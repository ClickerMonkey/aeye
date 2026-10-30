/**
 * OpenRouter Provider
 *
 * Provider for OpenRouter API with provider-specific routing and fallback options.
 *
 * Strict structured output enforcement:
 *   OpenRouter may route a strict `json_schema` request to a best-effort provider
 *   that ignores `response_format`, so the model emits non-conforming JSON (e.g. it
 *   echoes the schema instead of an instance). To prevent this, whenever the outgoing
 *   request carries a strict json_schema response format, this provider sets
 *   `provider.require_parameters = true` — OpenRouter's documented routing enforcement
 *   that only picks providers honoring every supplied parameter (including the schema).
 *   This auto-enforcement is ON by default and can be opted out per-call by setting
 *   `defaultParams.providers.requireParameters` explicitly (`false` disables, `true`
 *   forces regardless of strictness). See {@link OpenRouterConfig.defaultParams}.
 */

import type { AIContextAny, BatchJob, DecisionAnswer, DecisionQuestion, ImageEditRequest, ImageGenerationRequest, ImageGenerationResponse, ImageOutputOptions, Message, ModelCapability, ModelInfo, ModelParameter, ModelTokenizer, Provider } from '@aeye/ai';
import { detectTier, INPUT_CAPABILITIES, OUTPUT_CAPABILITIES } from '@aeye/ai';
import { REASONING_EFFORTS, withAllowedTools, type Chunk, type MessageContent, type DescriptorFamily, type GeneratedImage, type HostedTool, type Reasoning, type Request, type Resource, type Response, type Usage } from '@aeye/core';
import { type BatchSubmission, type DefaultModels, OpenAIConfig, OpenAIProvider, type OperationRun, ProviderError } from '@aeye/openai';
import OpenAI from 'openai';
import { fetchModels, fetchZDRModels } from './source';
import type { OpenRouterBatch, OpenRouterChatChunk, OpenRouterDecision, OpenRouterDecisionAnswer, OpenRouterDecisionQuestion, OpenRouterChatRequest, OpenRouterChatResponse, OpenRouterContentPart, OpenRouterImage, OpenRouterMetrics, OpenRouterModel, OpenRouterOutput, OpenRouterPlugin, OpenRouterProviderPreferences, OpenRouterRequestMessage, OpenRouterRerank, OpenRouterServerTool, OpenRouterUsage } from './types';

/**
 * OpenRouter provider configuration. Requests always go through chat
 * completions, where OpenRouter serves routing, plugins, and server tools.
 */
export interface OpenRouterConfig extends Omit<OpenAIConfig, 'api'> {
  defaultParams?: {
    siteUrl?: string;
    appName?: string;
    providers?: {
      order?: string[];
      allowFallbacks?: boolean;
      /**
       * Controls OpenRouter's `provider.require_parameters` routing enforcement,
       * which restricts routing to providers that honor every supplied parameter.
       *
       * - `true`  — always force enforcement.
       * - `false` — never force it (opt out even for strict structured output).
       * - `undefined` (default) — auto-enable ONLY when the request carries a strict
       *   `json_schema` response format, so strict structured outputs are actually
       *   enforced instead of silently degrading to a best-effort provider.
       *
       * Non-strict requests are unaffected unless this is explicitly set.
       */
      requireParameters?: boolean;
      dataCollection?: OpenRouterProviderPreferences['data_collection'];
      zdr?: boolean;
      // Only route to providers that allow training on outputs
      enforceDistillableText?: boolean;
      only?: string[];
      ignore?: string[];
      quantizations?: OpenRouterProviderPreferences['quantizations'];
      sort?: OpenRouterProviderPreferences['sort'];
      // Preferred median throughput floor (tokens/second) and latency ceiling (seconds)
      preferredMinThroughput?: number;
      preferredMaxLatency?: number;
      maxPrice?: OpenRouterProviderPreferences['max_price'];
    };
    // Models to fall back to, in order, when the requested one fails
    fallbackModels?: string[];
    // Plugins applied to every request
    plugins?: OpenRouterPlugin[];
    /**
     * @deprecated OpenRouter replaced transforms with plugins; `middle-out`
     * is sent as the `context-compression` plugin.
     */
    transforms?: string[];
  };
}

/**
 * OpenRouter parameter names to our ModelParameter names
 */
const PARAMETERS: Partial<Record<string, ModelParameter>> = {
  max_tokens: 'maxTokens',
  max_completion_tokens: 'maxTokens',
  temperature: 'temperature',
  top_p: 'topP',
  frequency_penalty: 'frequencyPenalty',
  presence_penalty: 'presencePenalty',
  stop: 'stop',
  seed: 'seed',
  response_format: 'responseFormat',
  structured_outputs: 'structuredOutput',
  tools: 'tools',
  tool_choice: 'toolChoice',
  logit_bias: 'logitBias',
  logprobs: 'logProbabilities',
  top_logprobs: 'logProbabilities',
  reasoning: 'reason',
  reasoning_effort: 'reason',
  include_reasoning: 'reason',
  verbosity: 'verbosity',
};

/**
 * Capabilities a model has for each modality it produces: chat output, plus
 * OpenRouter's dedicated media and embedding endpoints.
 */
const PRODUCES: Partial<Record<OpenRouterOutput, ModelCapability>> = {
  ...OUTPUT_CAPABILITIES,
  text: 'chat',
  speech: 'audio',
  transcription: 'hearing',
  embeddings: 'embedding',
  rerank: 'rerank',
  decisions: 'decision',
};

/**
 * Capabilities a model has for each parameter it accepts.
 */
const PARAMETER_CAPABILITIES: Partial<Record<string, ModelCapability>> = {
  tools: 'tools',
  tool_choice: 'tools',
  reasoning: 'reasoning',
  include_reasoning: 'reasoning',
  response_format: 'json',
  structured_outputs: 'structured',
};

/**
 * Server tool call counts in usage, by the hosted tool they belong to.
 */
const SERVER_TOOL_USAGE: Partial<Record<string, HostedTool['type']>> = {
  web_search_requests: 'web_search',
  web_fetch_requests: 'web_fetch',
  image_generation_requests: 'image_generation',
};

/**
 * Aspect ratios image models accept.
 */
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

/**
 * Models used when neither the request, the context, nor the config names one.
 */
const DEFAULT_MODELS: DefaultModels = {
  imageGenerate: 'google/gemini-2.5-flash-image',
  imageEdit: 'google/gemini-2.5-flash-image',
  imageAnalyze: 'openai/gpt-5.4-mini',
  transcription: 'openai/gpt-transcribe',
  embedding: 'openai/text-embedding-3-small',
  rerank: 'cohere/rerank-v3.5',
  decision: 'typesafe/jev-1.14',
};

/**
 * Detect capabilities from modalities and supported parameters
 */
function detectCapabilities(model: OpenRouterModel): Set<ModelCapability> {
  const capabilities = new Set<ModelCapability>();
  const add = (capability: ModelCapability | undefined) => capability && capabilities.add(capability);

  model.architecture.input_modalities.forEach(modality => add(INPUT_CAPABILITIES[modality]));
  model.architecture.output_modalities.forEach(modality => add(PRODUCES[modality]));
  model.supported_parameters.forEach(param => add(PARAMETER_CAPABILITIES[param]));
  if (capabilities.has('chat')) {
    capabilities.add('streaming');
  }
  return capabilities;
}

/**
 * A price string as a number, or undefined when free or absent.
 */
function price(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

/**
 * A per-token price string as dollars per million tokens.
 */
function perMillion(value: string | undefined): number | undefined {
  const parsed = price(value);
  return parsed && parsed * 1_000_000;
}

/**
 * Convert OpenRouter model to ModelInfo with full details
 */
export function convertOpenRouterModel(
  model: OpenRouterModel,
  zdrModelIds: Set<string>,
  metrics?: OpenRouterMetrics | null
): ModelInfo {
  const capabilities = detectCapabilities(model);
  if (zdrModelIds.has(model.id)) {
    capabilities.add('zdr');
  }
  const { pricing } = model;
  const embeds = capabilities.has('embedding');
  const supportedEfforts = model.reasoning?.supported_efforts;

  return {
    provider: 'openrouter',
    id: model.id,
    name: model.name,
    capabilities,
    tier: detectTier(model.name),
    pricing: {
      text: embeds ? undefined : {
        input: perMillion(pricing.prompt),
        output: perMillion(pricing.completion),
        cached: perMillion(pricing.input_cache_read),
        cacheWrite: perMillion(pricing.input_cache_write),
      },
      image: price(pricing.image_token) || price(pricing.image_output)
        ? { input: perMillion(pricing.image_token), tokens: perMillion(pricing.image_output) }
        : undefined,
      audio: price(pricing.audio) || price(pricing.audio_output)
        ? { input: perMillion(pricing.audio), output: perMillion(pricing.audio_output) }
        : undefined,
      reasoning: price(pricing.internal_reasoning) ? { output: perMillion(pricing.internal_reasoning) } : undefined,
      embeddings: embeds ? { cost: perMillion(pricing.prompt) } : undefined,
      tools: price(pricing.web_search) ? { web_search: price(pricing.web_search) } : undefined,
      perRequest: price(pricing.request),
    },
    contextWindow: model.context_length,
    maxOutputTokens: model.top_provider.max_completion_tokens ?? undefined,
    tokenizer: model.architecture.tokenizer,
    supportedParameters: new Set(model.supported_parameters.flatMap(param => PARAMETERS[param] ?? [])),
    reasoningEfforts: supportedEfforts && REASONING_EFFORTS.filter(effort => supportedEfforts.includes(effort)),
    retiresAt: model.expiration_date?.slice(0, 10),
    // Only emit metrics for FINITE values. A scraped page value that fails to
    // parse yields NaN, which `JSON.stringify` turns into `null` — poisoning the
    // generated `ModelInfo` (whose metric fields are `number | undefined`).
    metrics: metrics && (Number.isFinite(metrics.latency) || Number.isFinite(metrics.throughput)) ? {
      timeToFirstToken: Number.isFinite(metrics.latency) ? metrics.latency : undefined,
      tokensPerSecond: Number.isFinite(metrics.throughput) ? metrics.throughput : undefined,
    } : undefined,
    metadata: {
      description: model.description,
      defaultParameters: model.default_parameters,
      canonicalSlug: model.canonical_slug,
      huggingFaceId: model.hugging_face_id,
      created: model.created,
      knowledgeCutoff: model.knowledge_cutoff ?? undefined,
      voices: model.supported_voices ?? undefined,
      uptime: Number.isFinite(metrics?.uptime) ? metrics?.uptime : undefined,
    },
  };
}

/**
 * A hosted tool as an OpenRouter server tool.
 */
function toServerTool(tool: HostedTool): OpenRouterServerTool {
  switch (tool.type) {
    case 'web_search':
      return {
        type: 'openrouter:web_search',
        parameters: { max_results: tool.maxResults, allowed_domains: tool.allowedDomains, excluded_domains: tool.blockedDomains },
      };
    case 'web_fetch':
      return { type: 'openrouter:web_fetch' };
    case 'image_generation':
      return { type: 'openrouter:image_generation' };
    default:
      throw new ProviderError('openrouter', `The ${tool.type} hosted tool is not available on OpenRouter`);
  }
}

/**
 * The supported aspect ratio closest to a WIDTHxHEIGHT size.
 */
function aspectRatio(size: string): string {
  const [width, height] = size.split('x').map(Number);
  const ratio = (r: string) => { const [w, h] = r.split(':').map(Number); return w / h; };
  return ASPECT_RATIOS.reduce((best, r) =>
    Math.abs(ratio(r) - width / height) < Math.abs(ratio(best) - width / height) ? r : best
  );
}

/**
 * A question as OpenRouter's decisions endpoint takes it: a predicate is a
 * `noul` question, and choices and levels are its criteria.
 */
function toDecisionQuestion(question: DecisionQuestion): OpenRouterDecisionQuestion {
  const { instructions } = question;
  switch (question.type) {
    case 'predicate':
      return { type: 'noul', instructions };
    case 'choice':
      return { type: 'choice', instructions, criteria: question.choices };
    case 'score':
      return { type: 'score', instructions, criteria: question.levels };
  }
}

/**
 * An answer in @aeye's shape, with score probabilities in level order.
 */
function toDecisionAnswer(answer: OpenRouterDecisionAnswer): DecisionAnswer {
  switch (answer.type) {
    case 'noul':
      return { type: 'predicate', probability: answer.noul };
    case 'choice':
      return answer;
    case 'score':
      return {
        type: 'score',
        score: answer.score,
        probabilities: Object.entries(answer.probabilities).sort(([a], [b]) => Number(a) - Number(b)).map(([, probability]) => probability),
        confidence: answer.confidence,
      };
  }
}

/**
 * Images a chat model produced.
 */
function toImages(images: OpenRouterImage[] | undefined): GeneratedImage[] | undefined {
  return images?.length ? images.map(image => ({ url: image.image_url.url })) : undefined;
}

/**
 * Usage beyond what the OpenAI shape carries: server tool calls, and the
 * full cost, which with BYOK is OpenRouter's fee plus the provider's bill.
 */
function augmentUsage(target: Usage, usage: OpenRouterUsage) {
  for (const [key, calls] of Object.entries(usage.server_tool_use_details ?? {})) {
    const tool = SERVER_TOOL_USAGE[key];
    if (tool && calls) {
      target.tools = { ...target.tools, [tool]: calls };
    }
  }
  if (usage.cost !== undefined) {
    target.cost = usage.cost + (usage.is_byok ? usage.cost_details?.upstream_inference_cost ?? 0 : 0);
  }
}

/**
 * OpenRouter provider implementation extending base OpenAI-compatible provider
 */
export class OpenRouterProvider extends OpenAIProvider<OpenRouterConfig> implements Provider<OpenRouterConfig> {
  readonly name = 'openrouter';

  protected override readonly defaults = DEFAULT_MODELS;

  /**
   * OpenRouter is a router, not a model host: it speaks an OpenAI-shaped API
   * but forwards each request to the upstream provider that actually serves
   * the model, translating the tool/response schemas on the way. So the wire
   * dialect that matters is the UPSTREAM model's, which
   * `resolveStrictFormat` already derives from the `[family]/...` id prefix
   * (`google/gemini-3-flash-preview` → `'google'`).
   *
   * The inherited default is `['openai']` — correct for api.openai.com, wrong
   * here, and it silently forced EVERY tool schema through LENIENT no matter
   * which family the model belonged to. LENIENT encodes `z.any()` as a
   * self-referencing `$defs/Any`, which Gemini's function-calling grammar
   * compiler rejects with `400 INVALID_ARGUMENT` as soon as a tool call is
   * forced. `applySchemaDeliveryFallback` never hid this because it resolves
   * the family itself and only covers `response_format`, not tools — which is
   * why structured output looked family-aware while tools were not.
   */
  protected override supportedStrictFamilies: ReadonlySet<DescriptorFamily> =
    new Set<DescriptorFamily>(['openai', 'anthropic', 'google', 'xai']);

  // Reasoning of each converted assistant message, re-attached when the
  // messages are assembled
  private readonly reasoningOf = new WeakMap<OpenAI.Chat.ChatCompletionMessageParam, Reasoning>();

  protected createClient(config: OpenRouterConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL || 'https://openrouter.ai/api/v1',
      project: config.project,
      organization: config.organization,
      defaultHeaders: {
        'HTTP-Referer': config.defaultParams?.siteUrl,
        'X-Title': config.defaultParams?.appName,
      },
    });
  }

  protected convertModel(model: OpenAI.Model): ModelInfo {
    // This won't be used since we override listModels, but provide implementation
    return {
      provider: 'openrouter',
      id: model.id,
      name: model.id,
      capabilities: new Set(['chat', 'streaming']),
      tier: detectTier(model.id),
      pricing: {},
      contextWindow: 0,
      maxOutputTokens: undefined,
      metadata: {},
    };
  }

  /**
   * OpenRouter serves hosted tools and reasoning options through chat
   * completions, so the Responses API is never needed.
   */
  protected override usesResponses(): boolean {
    return false;
  }

  /**
   * OpenRouter doesn't honor `allowed_tools` (models still call the others,
   * and some upstreams reject it), so only the allowed tools are sent.
   */
  protected override buildChatParams(request: Request, run: OperationRun<OpenRouterConfig>, streaming: boolean) {
    return super.buildChatParams(withAllowedTools(request), run, streaming);
  }

  /**
   * Augment chat request with OpenRouter-specific parameters
   */
  protected override augmentChatRequest(
    params: OpenRouterChatRequest,
    request: Request,
    config: OpenRouterConfig
  ) {
    const dp = config.defaultParams;

    // OpenRouter takes reasoning as one object with either a token budget or
    // an effort, not both; the effort arrives already clamped to what the
    // model accepts
    if (request.reason) {
      const { maxTokens, exclude, summary, mode, context } = request.reason;
      const budget = maxTokens ? { max_tokens: maxTokens } : { effort: params.reasoning_effort ?? undefined };
      params.reasoning = { enabled: true, ...budget, exclude, summary, mode, context };
    }
    delete params.reasoning_effort;
    // OpenRouter ignores OpenAI's inline moderation
    delete params.moderation;

    if (dp?.providers) {
      const { allowFallbacks, requireParameters, dataCollection, enforceDistillableText, preferredMinThroughput, preferredMaxLatency, maxPrice, ...provider } = dp.providers;
      params.provider = {
        ...params.provider,
        allow_fallbacks: allowFallbacks,
        require_parameters: requireParameters,
        data_collection: dataCollection,
        enforce_distillable_text: enforceDistillableText,
        preferred_min_throughput: preferredMinThroughput,
        preferred_max_latency: preferredMaxLatency,
        max_price: maxPrice,
        ...provider,
      };
    }

    // Enforce strict structured output routing.
    //
    // The request's response_format is built by the OpenAIProvider parent before
    // this hook runs, so we can detect a strict json_schema here. When present,
    // default OpenRouter's `require_parameters` routing enforcement ON so the router
    // only picks a provider that honors the schema (otherwise it may fall back to a
    // best-effort provider that ignores response_format and echoes the schema).
    //
    // Opt-out: an explicit `requireParameters` (true/false) from config always wins;
    // we only auto-enable when it was left undefined. Non-strict requests are never
    // forced here.
    const isStrictStructured =
      params.response_format?.type === 'json_schema' &&
      params.response_format.json_schema?.strict === true;

    if (isStrictStructured && dp?.providers?.requireParameters === undefined) {
      params.provider = { ...params.provider, require_parameters: true };
    }

    const plugins: OpenRouterPlugin[] = [...dp?.plugins ?? []];
    if (dp?.transforms?.includes('middle-out')) {
      plugins.push({ id: 'context-compression', engine: 'middle-out' });
    }
    if (plugins.length) {
      params.plugins = plugins;
    }
    if (dp?.fallbackModels?.length) {
      params.models = dp.fallbackModels;
    }
    if (request.hostedTools?.length) {
      params.tools = [...params.tools ?? [], ...request.hostedTools.map(toServerTool)];
    }
    if (request.modalities?.includes('image')) {
      params.modalities = request.modalities;
    }
    params.user = request.userKey;
  }

  protected override augmentChatResponse(
    expected: OpenRouterChatResponse,
    response: Response,
    config: OpenRouterConfig
  ) {
    const message = expected.choices?.[0]?.message;
    if (message?.reasoning || message?.reasoning_details) {
      response.reasoning = { content: message.reasoning, details: message.reasoning_details };
    }
    response.images = toImages(message?.images);
    if (expected.usage) {
      augmentUsage(response.usage ??= {}, expected.usage);
    }
  }

  protected override augmentChatChunk(
    expected: OpenRouterChatChunk,
    chunk: Chunk,
    config: OpenRouterConfig
  ) {
    const delta = expected.choices[0]?.delta;
    if (delta?.reasoning || delta?.reasoning_details?.length) {
      chunk.reasoning = { content: delta.reasoning, details: delta.reasoning_details };
    }
    chunk.images = toImages(delta?.images);
    if (expected.usage) {
      augmentUsage(chunk.usage ??= {}, expected.usage);
    }
  }

  /**
   * OpenRouter marks cache breakpoints Anthropic-style and translates them
   * for each upstream provider.
   */
  protected override augmentChatContent(
    chatContent: OpenRouterContentPart,
  ) {
    if (chatContent.prompt_cache_breakpoint) {
      delete chatContent.prompt_cache_breakpoint;
      chatContent.cache_control = { type: 'ephemeral' };
    }
  }

  protected override augmentChatMessage(
    chatMessage: OpenAI.Chat.ChatCompletionMessageParam,
    message: Message,
  ) {
    if (message.reasoning && chatMessage.role === 'assistant') {
      this.reasoningOf.set(chatMessage, message.reasoning);
    }
  }

  /**
   * Assistant messages carry their reasoning back, once even when a message
   * was split into parts. OpenRouter doesn't transform reasoning on a message
   * that also has content, so that reasoning goes in its own assistant
   * message just before.
   */
  protected override async convertMessages(request: Request, config: OpenRouterConfig): Promise<OpenRouterRequestMessage[]> {
    const messages = await super.convertMessages(request, config);
    const replayed = new Set<Reasoning>();
    return messages.flatMap((message): OpenRouterRequestMessage[] => {
      const reasoning = this.reasoningOf.get(message);
      if (!reasoning || replayed.has(reasoning)) {
        return [message];
      }
      replayed.add(reasoning);
      const replay = { reasoning: reasoning.content ?? undefined, reasoning_details: reasoning.details };
      return message.role === 'assistant' && message.content?.length
        ? [{ role: 'assistant', name: message.name, ...replay }, message]
        : [{ ...message, ...replay }];
    });
  }

  /**
   * Produce images through chat: image models on OpenRouter answer with
   * images when asked for the image modality. Runs through the chat hooks.
   */
  private async chatImages(request: ImageOutputOptions, images: Resource[], ctx: AIContextAny, defaultModel: keyof DefaultModels, config?: OpenRouterConfig): Promise<ImageGenerationResponse> {
    const response = await this.createExecutor(config)({
      model: request.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', content: request.prompt },
          ...images.map((image): MessageContent => ({ type: 'image', content: image })),
        ],
      }],
      modalities: ['image', 'text'],
      extra: {
        image_config: request.size && request.size !== 'auto' ? { aspect_ratio: aspectRatio(request.size) } : undefined,
        ...request.extra,
      },
    }, ctx, { model: config?.defaultModels?.[defaultModel] ?? this.config.defaultModels?.[defaultModel] ?? this.defaults[defaultModel] });

    return { images: response.images ?? [], model: response.model, usage: response.usage };
  }

  override generateImage: Provider['generateImage'] = (request: ImageGenerationRequest, ctx: AIContextAny, config?: OpenRouterConfig) =>
    this.chatImages(request, [], ctx, 'imageGenerate', config);

  override editImage: Provider['editImage'] = (request: ImageEditRequest, ctx: AIContextAny, config?: OpenRouterConfig) =>
    this.chatImages(request, [request.image, ...request.references ?? []], ctx, 'imageEdit', config);

  /**
   * Image streaming is not offered; image requests fall back to the
   * non-streaming methods.
   */
  override generateImageStream = undefined;
  override editImageStream = undefined;

  /**
   * Transcription streaming is not offered; transcription falls back to
   * the non-streaming method.
   */
  override transcribeStream = undefined;

  /**
   * Order documents by relevance to a query.
   *
   * @param request Rerank request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Documents by relevance, most relevant first
   */
  rerank: Provider['rerank'] = async (request, ctx, config?: OpenRouterConfig) => {
    const run = this.prepare('rerank', request, ctx, undefined, config, undefined, 'rerank');
    const body = { model: run.model.id, query: request.query, documents: request.documents, top_n: request.topN, ...request.extra };
    const result = await run.retry((signal) => run.client.post<OpenRouterRerank>('/rerank', { body, signal }));
    return {
      results: result.results.map(({ index, relevance_score }) => ({ index, score: relevance_score })),
      model: run.model,
      usage: { cost: result.usage?.cost },
    };
  }

  /**
   * Typed answers about an input, from System One models such as Jev and
   * Kev or other decision models. A conversation goes in as chat messages.
   * Decisions are an alpha endpoint, outside the versioned API.
   *
   * @param request Decision request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Answers by question name
   */
  override decide: Provider['decide'] = async (request, ctx, config?: OpenRouterConfig) => {
    const run = this.prepare('decide', request, ctx, undefined, config, undefined, 'decision');
    const body = {
      model: run.model.id,
      state: typeof request.input === 'string' ? request.input : await this.convertMessages({ messages: request.input }, run.config),
      questions: Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, toDecisionQuestion(question)])),
      ...request.extra,
    };
    const url = new URL('../alpha/decisions', `${run.client.baseURL}/`).href;
    const result = await run.retry((signal) => run.client.post<OpenRouterDecision>(url, { body, signal }));
    return {
      answers: Object.fromEntries(Object.entries(result.answers).map(([name, answer]) => [name, toDecisionAnswer(answer)])),
      model: run.model,
      usage: { text: { input: result.usage.input_tokens, output: result.usage.output_tokens || undefined }, cost: result.usage.cost },
    };
  }

  /**
   * Start a batch: OpenRouter takes the requests inline.
   */
  protected override async createBatch(batch: BatchSubmission, run: OperationRun<OpenRouterConfig>): Promise<BatchJob> {
    const body = { endpoint: batch.endpoint, model: batch.model, requests: batch.lines };
    const created = await run.retry((signal) => run.client.post<OpenRouterBatch>('/batches', { body, signal }));
    return this.toBatchJob(created, run);
  }

  /**
   * Read a batch: OpenRouter returns the results inline once it completes.
   */
  protected override async retrieveBatch(job: BatchJob, run: OperationRun<OpenRouterConfig>): Promise<BatchJob> {
    const batch = await run.retry((signal) => run.client.get<OpenRouterBatch>(`/batches/${job.id}`, { signal }));
    const results = batch.results && this.batchResults(batch.results, batch.request_counts.total, run);
    return { ...this.toBatchJob(batch, run), results: results ?? undefined };
  }

  /**
   * A batch as @aeye reports it.
   */
  private toBatchJob(batch: OpenRouterBatch, run: OperationRun<OpenRouterConfig>): BatchJob {
    const usage: Usage = {};
    if (batch.usage) {
      augmentUsage(usage, batch.usage);
    }
    return { id: batch.id, provider: this.name, model: run.model.id, status: batch.status, counts: batch.request_counts, error: batch.error?.message, cost: usage.cost };
  }

  /**
   * Override listModels to use OpenRouter's model API with ZDR support
   */
  override async listModels(config?: OpenRouterConfig): Promise<ModelInfo[]> {
    const { apiKey } = { ...this.config, ...config };
    try {
      const [models, zdrModels] = await Promise.all([
        fetchModels(apiKey),
        fetchZDRModels(apiKey),
      ]);

      return models.map((model) => convertOpenRouterModel(model, zdrModels));
    } catch (error) {
      throw new Error(`Failed to list OpenRouter models: ${error}`);
    }
  }
}
