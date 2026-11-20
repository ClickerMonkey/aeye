/**
 * Ollama Provider
 *
 * Local (or cloud) Ollama models: chat and embeddings through Ollama's
 * OpenAI-compatible `/v1` (Chat Completions), System One decisions through
 * `/v1/systemone`, and the model list from Ollama's native API, with what
 * each model can do and the context window it is really served with.
 */

import type { AIContextAny, DecisionResponse, ModelCapability, ModelInfo, Provider } from '@aeye/ai';
import { checkDecisionLimits } from '@aeye/ai';
import type { Request } from '@aeye/core';
import { type DefaultModels, fromSystemOneAnswers, type OpenAIConfig, OpenAIProvider, ProviderError, type SystemOneDecision, systemOneTextBytes, toSystemOneParams } from '@aeye/openai';
import OpenAI from 'openai';
import { OLLAMA_BASE_URL, OllamaApi, type OllamaShow, reasons, servedWindow, takesTools, unsetWindow } from './api';

/**
 * The limits of Ollama's `/v1/systemone`: questions per call, and bytes of
 * state and questions per call (images aside).
 */
export const OLLAMA_SYSTEM_ONE_LIMITS = { maxQuestions: 64, maxRequestBytes: 64 * 1024 } as const satisfies Pick<ModelInfo, 'maxQuestions' | 'maxRequestBytes'>;

/**
 * Configuration of an Ollama provider.
 */
export interface OllamaConfig extends OpenAIConfig {
  // Where Ollama listens: its root, not `/v1` (default http://127.0.0.1:11434)
  baseURL?: string;
  // The window the server serves a model with when its Modelfile sets no
  // `num_ctx` (as the server's `OLLAMA_CONTEXT_LENGTH` does). Unset, it is
  // Ollama's own default for the server's version.
  contextWindow?: number;
  // The most window assumed when `contextWindow` is unset
  maxContextWindow?: number;
  // How long the server keeps a model loaded after a decision: a duration
  // such as '5m', or seconds (0 unloads it at once, below 0 keeps it)
  keepAlive?: string | number;
  // Models that answer System One decisions, for servers whose `/api/show`
  // lists no capabilities (newer servers list `decision`)
  decisionModels?: string[];
  // The `fetch` every call goes through
  fetch?: typeof fetch;
}

/**
 * What an Ollama provider is made from: its config, with the key optional
 * (a local server takes none).
 */
export type OllamaOptions = Omit<OllamaConfig, 'apiKey'> & { apiKey?: string };

/**
 * What a model can do: from the capabilities `/api/show` lists, else (older
 * servers) from its template and name, with decisions from `decisionModels`.
 *
 * @param model The model's name
 * @param show What `/api/show` says about it
 * @param decisionModels Models that answer decisions, when `/api/show` lists no capabilities
 */
export function capabilitiesOf(model: string, show: OllamaShow, decisionModels: readonly string[] = []): Set<ModelCapability> {
  const listed = show.capabilities;
  const capabilities = new Set<ModelCapability>();
  if (listed) {
    if (listed.includes('completion')) {
      capabilities.add('chat').add('streaming').add('json');
    }
    // Ollama's embedding endpoints take text only, so no model gets
    // `imageEmbedding`, even one that lists `vision`
    if (listed.includes('embedding')) {
      capabilities.add('embedding');
    }
    if (listed.includes('decision')) {
      capabilities.add('decision');
    }
    if (listed.includes('vision')) {
      capabilities.add('vision');
    }
  } else if (decisionModels.includes(model) || decisionModels.includes(model.replace(/:latest$/, ''))) {
    capabilities.add('decision');
  } else {
    capabilities.add('chat').add('streaming').add('json');
  }
  if (capabilities.has('chat')) {
    if (takesTools(show)) {
      capabilities.add('tools');
    }
    if (reasons(model, show)) {
      capabilities.add('reasoning');
    }
  }
  return capabilities;
}

/**
 * Ollama through its OpenAI-compatible API. `@aeye/openai` sends system
 * messages with OpenAI's `developer` role, which Ollama's chat templates
 * drop without a word, so they go to Ollama as `system`.
 *
 * @example
 * ```typescript
 * const ollama = new OllamaProvider({ keepAlive: '10m' });
 * const ai = AI.with().providers({ ollama }).create();
 * const { answers } = await ai.decide.get({
 *   input: 'The printer is on fire.',
 *   questions: { urgent: { type: 'predicate', instructions: 'Is this urgent?' } },
 * }, { metadata: { model: 'nimble' } });
 * ```
 */
export class OllamaProvider extends OpenAIProvider<OllamaConfig> implements Provider<OllamaConfig> {
  readonly name: string = 'ollama';

  // Ollama serves whatever models it has pulled: no model is assumed
  protected override readonly defaults: DefaultModels = {};

  constructor(options: OllamaOptions = {}) {
    super({ api: 'chat', ...options, apiKey: options.apiKey ?? 'ollama', baseURL: (options.baseURL ?? OLLAMA_BASE_URL).replace(/\/+$/, '') });
  }

  /**
   * Ollama's native API, for a config.
   */
  api(config?: Partial<OllamaConfig>): OllamaApi {
    const effective = { ...this.config, ...config };
    return new OllamaApi(effective.baseURL, effective.fetch, effective.apiKey === 'ollama' ? undefined : effective.apiKey);
  }

  protected override createClient(config: OllamaConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: `${(config.baseURL ?? OLLAMA_BASE_URL).replace(/\/+$/, '')}/v1`,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  /**
   * The Chat Completions messages, each system one with the `system` role
   * Ollama reads.
   */
  protected override async convertMessages(request: Request, config: OllamaConfig): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    const messages = await super.convertMessages(request, config);
    return messages.map((message) => (message.role === 'developer' ? { ...message, role: 'system' } : message));
  }

  /**
   * The window the server serves a model with when its Modelfile sets no
   * `num_ctx`.
   */
  async unsetWindow(config?: Partial<OllamaConfig>): Promise<number> {
    const effective = { ...this.config, ...config };
    return unsetWindow(await this.api(effective).version(), effective.contextWindow, effective.maxContextWindow);
  }

  /**
   * The server's models, each with what it can do and the window it is
   * served with. Decision models carry System One's limits.
   */
  override async listModels(config?: Partial<OllamaConfig>): Promise<ModelInfo[]> {
    const effective = { ...this.config, ...config };
    const api = this.api(effective);
    try {
      const [tags, unset] = await Promise.all([api.tags(), this.unsetWindow(effective)]);
      return await Promise.all(tags.models.map(async ({ name }) => {
        const show = await api.show(name);
        const capabilities = capabilitiesOf(name, show, effective.decisionModels);
        return {
          provider: this.name,
          id: name,
          name,
          capabilities,
          tier: 'efficient',
          pricing: { text: { input: 0, output: 0 } },
          contextWindow: servedWindow(show, unset),
          ...(capabilities.has('decision') ? OLLAMA_SYSTEM_ONE_LIMITS : {}),
          metadata: { family: show.details?.family, size: show.details?.parameter_size },
        } satisfies ModelInfo;
      }));
    } catch (error) {
      throw new ProviderError(this.name, 'Failed to list models', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Typed answers from a System One model at `/v1/systemone`. A
   * conversation goes in as chat messages, images as base64, and the
   * config's `keepAlive` as `keep_alive` (the request's `extra` overrides
   * it). A call over the model's limits (`maxQuestions`, `maxRequestBytes`,
   * else Ollama's) is refused before it is sent, never split.
   *
   * @param request Decision request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Answers by question name
   * @throws {DecisionLimitError} When the call is over a limit
   */
  override decide: Provider['decide'] = async (request, ctx: AIContextAny, config?: OllamaConfig): Promise<DecisionResponse> => {
    const run = this.prepare('decide', request, ctx, undefined, config, undefined, 'decision');
    const state = typeof request.input === 'string' ? request.input : await this.convertMessages({ messages: request.input }, run.config);
    const params = await toSystemOneParams(run.model.id, state, request, run.config.keepAlive === undefined ? {} : { keep_alive: run.config.keepAlive });
    checkDecisionLimits({
      id: run.model.id,
      maxQuestions: run.modelInfo?.maxQuestions ?? OLLAMA_SYSTEM_ONE_LIMITS.maxQuestions,
      maxRequestBytes: run.modelInfo?.maxRequestBytes ?? OLLAMA_SYSTEM_ONE_LIMITS.maxRequestBytes,
    }, Object.keys(params.questions).length, systemOneTextBytes(params));

    const result = await this.send('decide', run, request, params, (signal) => run.client.post<SystemOneDecision>('/systemone', { body: params, signal }));
    return this.finish('decide', run, request, params, {
      answers: fromSystemOneAnswers(result.answers),
      model: run.model,
      usage: { text: { input: result.usage.input_tokens, output: result.usage.output_tokens || undefined } },
    });
  }
}
