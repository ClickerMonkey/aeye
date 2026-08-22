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

import type { Message, ModelCapability, ModelInfo, ModelParameter, ModelTokenizer, Provider } from '@aeye/ai';
import { detectTier } from '@aeye/ai';
import { accumulateReasoning, type Chunk, type DescriptorFamily, type Request, type Response } from '@aeye/core';
import { OpenAIConfig, OpenAIProvider } from '@aeye/openai';
import OpenAI from 'openai';
import { fetchModels, fetchZDRModels } from './source';
import { OpenRouterChatChunk, OpenRouterChatRequest, OpenRouterChatResponse, OpenRouterMessage, OpenRouterModel, OpenRouterReasoningDetails, OpenRouterRequestMessage } from './types';

/**
 * OpenRouter provider configuration
 */
export interface OpenRouterConfig extends OpenAIConfig {
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
      dataCollection?: 'deny' | 'allow';
      zdr?: boolean;
      only?: string[];
      ignore?: string[];
      quantizations?: ('int4' | 'int8' | 'fp4' | 'fp6' | 'fp8' | 'fp16' | 'bf16' | 'fp32' | 'unknown')[];
      sort?: 'price' | 'throughput' | 'latency';
      maxPrice?: {
        prompt?: number; // dollars per million tokens
        completion?: number; // dollars per million tokens
        image?: number; // dollars per image
      };
    };
    transforms?: string[];
  };
}


/**
 * Convert OpenRouter parameter names to our ModelParameter format
 */
function convertSupportedParameters(openRouterParams: string[]): ModelParameter[] {
  const paramMap: Record<string, ModelParameter> = {
    'max_tokens': 'maxTokens',
    'temperature': 'temperature',
    'top_p': 'topP',
    'frequency_penalty': 'frequencyPenalty',
    'presence_penalty': 'presencePenalty',
    'stop': 'stop',
    'seed': 'seed',
    'response_format': 'responseFormat',
    'structured_outputs': 'structuredOutput',
    'tools': 'tools',
    'tool_choice': 'toolChoice',
    'logit_bias': 'logitBias',
    'logprobs': 'logProbabilities',
    'top_logprobs': 'logProbabilities',
    'reasoning': 'reason',
    'include_reasoning': 'reason',
  };

  const converted = new Set<ModelParameter>();
  for (const param of openRouterParams) {
    const mapped = paramMap[param];
    if (mapped) {
      converted.add(mapped);
    }
  }

  return Array.from(converted);
}

/**
 * Detect capabilities from input/output modalities
 */
function detectCapabilities(model: OpenRouterModel): ModelCapability[] {
  const capabilities = new Set<ModelCapability>();

  // Chat capability - if model outputs text
  if (model.architecture.output_modalities.includes('text')) {
    capabilities.add('chat');
  }

  // Image generation - if model outputs images
  if (model.architecture.output_modalities.includes('image')) {
    capabilities.add('image');
  }

  // Vision capability - if model accepts images as input
  if (model.architecture.input_modalities.includes('image')) {
    capabilities.add('vision');
  }

  // Audio/hearing capability - if model accepts audio as input
  if (model.architecture.input_modalities.includes('audio')) {
    capabilities.add('hearing');
  }

  // File handling capability
  if (model.architecture.input_modalities.includes('file')) {
    capabilities.add('vision'); // Files often imply document/vision capabilities
  }

  // Tools/function calling
  if (model.supported_parameters.includes('tools') || model.supported_parameters.includes('tool_choice')) {
    capabilities.add('tools');
  }

  // Reasoning capability
  if (model.supported_parameters.includes('reasoning') || model.supported_parameters.includes('include_reasoning')) {
    capabilities.add('reasoning');
  }

  // JSON output capability
  if (model.supported_parameters.includes('response_format')) {
    capabilities.add('json');
  }

  // Structured output capability
  if (model.supported_parameters.includes('structured_outputs')) {
    capabilities.add('structured');
  }

  // Streaming capability (most models support this)
  capabilities.add('streaming');

  return Array.from(capabilities);
}


/**
 * Convert OpenRouter model to ModelInfo with full details
 */
export function convertOpenRouterModel(
  model: OpenRouterModel,
  zdrModelIds: Set<string>,
  metrics?: { latency?: number; throughput?: number; uptime?: number } | null
): ModelInfo {
  const capabilities = detectCapabilities(model);
  const supportedParameters = convertSupportedParameters(model.supported_parameters);
  const tier = detectTier(model.name);

  // Update ZDR support from ZDR endpoint
  if (zdrModelIds.has(model.id)) {
    capabilities.push('zdr');
  }

  const hasValue = (x: string | undefined): x is string => {
    return x !== undefined && x !== null && x !== '' && x !== '0';
  }

  return {
    provider: 'openrouter',
    id: model.id,
    name: model.name,
    capabilities: new Set(capabilities), // Will be serialized as array
    tier,
    pricing: {
      text: hasValue(model.pricing.prompt) || hasValue(model.pricing.completion) ? {
        input: hasValue(model.pricing.prompt) ? parseFloat(model.pricing.prompt) * 1_000_000 : undefined,
        output: hasValue(model.pricing.completion) ? parseFloat(model.pricing.completion) * 1_000_000 : undefined,
      } : undefined,
      image: hasValue(model.pricing.image) ? {
        input: parseFloat(model.pricing.image) * 1_000_000,
      } : undefined,
      reasoning: hasValue(model.pricing.internal_reasoning) ? {
        output: parseFloat(model.pricing.internal_reasoning) * 1_000_000,
      } : undefined,
      perRequest: hasValue(model.pricing.request) 
        ? parseFloat(model.pricing.request) 
        : undefined,
    },
    contextWindow: model.context_length,
    maxOutputTokens: model.top_provider.max_completion_tokens ?? undefined,
    tokenizer: model.architecture.tokenizer as ModelTokenizer,
    supportedParameters: new Set(supportedParameters), // Will be serialized as array
    // Only emit metrics for FINITE values. A scraped page value that fails to
    // parse yields NaN, which `JSON.stringify` turns into `null` — poisoning the
    // generated `ModelInfo` (whose metric fields are `number | undefined`).
    metrics: metrics && (Number.isFinite(metrics.latency) || Number.isFinite(metrics.throughput)) ? {
      timeToFirstToken: Number.isFinite(metrics.latency) ? metrics.latency : undefined,
      tokensPerSecond: Number.isFinite(metrics.throughput) ? metrics.throughput : undefined,
      // Store uptime in metadata since it's not a standard metric
    } : undefined,
    metadata: {
      description: model.description,
      defaultParameters: model.default_parameters,
      canonicalSlug: model.canonical_slug,
      huggingFaceId: model.hugging_face_id,
      created: model.created,
      uptime: Number.isFinite(metrics?.uptime) ? metrics?.uptime : undefined,
    },
  };
}

/**
 * OpenRouter provider implementation extending base OpenAI-compatible provider
 */
export class OpenRouterProvider extends OpenAIProvider<OpenRouterConfig> implements Provider<OpenRouterConfig> {
  readonly name = 'openrouter';

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
    new Set<DescriptorFamily>(['openai', 'anthropic', 'google']);

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
   * Augment chat request with OpenRouter-specific parameters
   */
  protected override augmentChatRequest(
    params: OpenRouterChatRequest,
    request: Request,
    config: OpenRouterConfig
  ) {
    // Add reasoning if specified
    if (request.reason) {
      params.reasoning = {
        enabled: true,
        effort: request.reason.effort,
        max_tokens: request.reason.maxTokens,
      };
    }

    const dp = config.defaultParams;

    // Merge provider parameters from config defaults (preserve any existing
    // params.provider already set upstream).
    if (dp?.providers) {
      const { allowFallbacks, requireParameters, dataCollection, maxPrice, ...provider } = dp.providers;
      params.provider = {
        ...params.provider,
        allow_fallbacks: allowFallbacks,
        require_parameters: requireParameters,
        data_collection: dataCollection,
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
      params.provider = {
        ...params.provider,
        require_parameters: true,
      };
    }

    if (dp?.transforms) {
      params.transforms = dp.transforms;
    }
  }

  /**
   * 
   * @param expected 
   * @param response 
   */
  protected override augmentChatResponse(
    expected: OpenRouterChatResponse, 
    response: Response,
    config: OpenRouterConfig
  ) {
    const message = expected.choices?.[0]?.message;
    if (message) {
      if (message.reasoning) {
        if (!response.reasoning) {
          response.reasoning = {};
        }
        response.reasoning.content = message.reasoning;
      }
      if (message.reasoning_details) {
        if (!response.reasoning) {
          response.reasoning = {};
        }
        response.reasoning.details = message.reasoning_details;
      }
    }
    const usage = expected.usage;
    if (usage) {
      if (!response.usage) {
        response.usage = {};
      }
      if (!response.usage.text) {
        response.usage.text = {};
      }
      if (usage.completion_tokens) {
        response.usage.text.output = usage.completion_tokens;
      }
      if (usage.prompt_tokens) {
        response.usage.text.input = usage.prompt_tokens;
      }
      if (usage.cost) {
        response.usage.cost = usage.cost;
      }
    }
  }

  protected override augmentChatChunk(
    expected: OpenRouterChatChunk,
    chunk: Chunk,
    config: OpenRouterConfig
  ) {
    const usage = expected.usage;
    if (usage) {
      if (!chunk.usage) {
        chunk.usage = {};
      }
      if (!chunk.usage.text) {
        chunk.usage.text = {};
      }
      if (usage.completion_tokens) {
        chunk.usage.text.output = usage.completion_tokens;
      }
      if (usage.prompt_tokens) {
        chunk.usage.text.input = usage.prompt_tokens;
      }
      if (usage.cost) {
        chunk.usage.cost = usage.cost;
      }
    }
    const delta = expected.choices[0]?.delta;
    if (delta?.reasoning || delta?.reasoning_details?.length) {
      chunk.reasoning = accumulateReasoning(chunk.reasoning, {
        content: delta.reasoning,
        details: delta.reasoning_details,
      });
    }
  }

  protected augmentChatMessage(
      chatMessage: OpenRouterRequestMessage,
      message: Message,
      config: OpenRouterConfig,
  ) {
    if (message.reasoning?.content) {
      chatMessage.reasoning = message.reasoning.content;
    }
    if (message.reasoning?.details) {
      chatMessage.reasoning_details = message.reasoning.details as OpenRouterReasoningDetails[];
    }
  }

  protected async convertMessages(request: Request, config: OpenRouterConfig): Promise<OpenRouterRequestMessage[]> {
    const messages = await super.convertMessages(request, config) as OpenRouterRequestMessage[];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      // If the message has content & reasoning, move details into a separate field
      // Annoying OpenRouter doesn't transform it correctly for us
      if (message.role === 'assistant' && 
        (message.content?.length) && 
        (message.reasoning?.length || message.reasoning_details?.length)
      ) {
        // Remove reasoning details from content
        const { reasoning, reasoning_details } = message;
        delete message.reasoning;
        delete message.reasoning_details;

        // Insert a new message before this one with the reasoning info
        messages.splice(i, 0, {
          role: 'assistant',
          name: message.name,
          reasoning,
          reasoning_details,
        });
      }
    }
    return messages;
  }

  /**
   * OpenRouter does not support image generation
   */
  override generateImage = undefined;

  /**
   * OpenRouter does not support image generation streaming
   */
  override generateImageStream = undefined;

  /**
   * OpenRouter does not support image editing
   */
  override editImage = undefined;

  /**
   * OpenRouter does not support image editing
   */
  override editImageStream = undefined;

  /**
   * OpenRouter does not support audio transcription
   */
  override transcribe = undefined;

  /**
   * OpenRouter does not support audio transcription streaming
   */
  override transcribeStream = undefined;

  /**
   * OpenRouter does not support speech synthesis
   */
  override speech = undefined;

  /**
   * OpenRouter does not support embeddings
   */
  override embed = undefined;

  /**
   * Override listModels to use OpenRouter's model API with ZDR support
   */
  async listModels(config: OpenRouterConfig): Promise<ModelInfo[]> {
    try {
      // Fetch both models and ZDR models in parallel
      const [models, zdrModels] = await Promise.all([
        fetchModels(config.apiKey),
        fetchZDRModels(config.apiKey),
      ]);

      return models.map((model) => convertOpenRouterModel(model, zdrModels));
    } catch (error) {
      throw new Error(`Failed to list OpenRouter models: ${error}`);
    }
  }
}

