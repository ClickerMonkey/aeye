/**
 * OpenAI Provider
 *
 * Provider for OpenAI's chat (Chat Completions and Responses), GPT Image,
 * transcription, speech, and embedding models. Also serves as base class for
 * OpenAI-compatible providers.
 */

import type {
  AIContextAny,
  AIMetadataAny,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageAnalyzeRequest,
  ImageEditRequest,
  ImageGenerationChunk,
  ImageGenerationRequest,
  ImageGenerationResponse,
  Message,
  ModelInfo,
  Provider,
  SpeechRequest,
  SpeechResponse,
  TranscriptionChunk,
  TranscriptionRequest,
  TranscriptionResponse,
  TranscriptionSegment
} from '@aeye/ai';
import { clampReasoningEffort, detectTier, isModelInfo, resolveStrictFormat } from '@aeye/ai';
import { BaseRequest, type Chunk, type DescriptorFamily, type Executor, type FormatDescriptor, type GeneratedImage, getDescriptor, getModel, getResponseFromChunks, LENIENT, type MessageContent, type Model, ModelInput, type Request, type Response, SchemaBudget, strictestOf, strictify, strictPriority, type Streamer, toBase64, toFile, toJSONSchema, type ToolCall, toText, toURL } from '@aeye/core';
import OpenAI from 'openai';
import { chatUsage, MODERATION_MODEL, toChatAudioFormat, toCitation, toModeration, toServiceTier, transcriptionUsage } from './convert';
import { imageParams, imageUsage, partialImages } from './images';
import { isResponsesOnly, outputItemChunk, responseChunks, responseEndChunk, toHostedTool, toInputContent, toReasoningItems } from './responses';
import { isContextWindowError, parseContextWindowError, type RetryConfig, RetryContext, type RetryEvents, withRetry } from './retry';
import { ContextWindowError, ProviderError } from './types';

// ============================================================================
// OpenAI Provider Configuration
// ============================================================================

/**
 * Resolve the full `ModelInfo` for the request when available.
 *
 * `BaseAPI` injects `selected.model` into `ctx.metadata.model` after model
 * selection, so on the standard execution path we get the strict-format
 * declarations directly from there. External callers that bypass `BaseAPI`
 * (e.g. invoking the executor directly) may pass only a model id — we
 * return undefined in that case and the caller falls back to LENIENT.
 */
function pickModelInfo(
  metadata: AIMetadataAny | undefined,
  ctx: AIContextAny | undefined,
  modelId: string,
): ModelInfo | undefined {
  return [metadata?.model, ctx?.metadata?.model].find(
    (candidate): candidate is ModelInfo => !!candidate && isModelInfo(candidate) && candidate.id === modelId
  );
}

/**
 * Hook called before a request is made to the provider.
 *
 * @template TRequest - The request type
 * @template TParams - The provider-specific parameters type
 * @param request - The request object
 * @param params - The provider-specific parameters being sent to the API
 * @param ctx - The context object
 * @param metadata - Optional metadata
 */
export type PreRequestHook<TRequest, TParams> = (
  request: TRequest,
  params: TParams,
  ctx: AIContextAny,
  metadata?: AIMetadataAny
) => void | Promise<void>;

/**
 * Hook called after a response is received from the provider.
 *
 * @template TRequest - The request type
 * @template TParams - The provider-specific parameters type
 * @template TResponse - The response type
 * @param request - The request object
 * @param params - The provider-specific parameters that were sent to the API
 * @param response - The response object
 * @param ctx - The context object
 * @param metadata - Optional metadata
 */
export type PostRequestHook<TRequest, TParams, TResponse> = (
  request: TRequest,
  params: TParams,
  response: TResponse,
  ctx: AIContextAny,
  metadata?: AIMetadataAny
) => void | Promise<void>;

/**
 * Hook called when an error occurs during a request to the provider.
 *
 * @template TRequest - The request type
 * @template TParams - The provider-specific parameters type
 * @param error - The error that occurred
 * @param request - The request object
 * @param params - The provider-specific parameters that were sent to the API
 * @param ctx - The context object
 * @param metadata - Optional metadata
 */
export type ErrorHook<TRequest, TParams> = (
  request: TRequest,
  params: TParams,
  error: Error,
  ctx: AIContextAny,
  metadata?: AIMetadataAny
) => void | Promise<void>;

/**
 * Each operation's @aeye request, the parameters sent for it, and its @aeye response.
 */
export interface OpenAIOperations {
  chat: { request: Request; params: OpenAI.Chat.ChatCompletionCreateParams; response: Response };
  responses: { request: Request; params: OpenAI.Responses.ResponseCreateParams; response: Response };
  imageGenerate: { request: ImageGenerationRequest; params: OpenAI.Images.ImageGenerateParams; response: ImageGenerationResponse };
  imageEdit: { request: ImageEditRequest; params: OpenAI.Images.ImageEditParams; response: ImageGenerationResponse };
  transcribe: { request: TranscriptionRequest; params: OpenAI.Audio.TranscriptionCreateParams; response: TranscriptionResponse };
  speech: { request: SpeechRequest; params: OpenAI.Audio.SpeechCreateParams; response: SpeechResponse };
  embed: { request: EmbeddingRequest; params: OpenAI.EmbeddingCreateParams; response: EmbeddingResponse };
}

/**
 * Hooks around one operation.
 */
export interface OperationHooks<TOperation extends OpenAIOperations[keyof OpenAIOperations]> {
  beforeRequest?: PreRequestHook<TOperation['request'], TOperation['params']>;
  afterRequest?: PostRequestHook<TOperation['request'], TOperation['params'], TOperation['response']>;
  onError?: ErrorHook<TOperation['request'], TOperation['params']>;
}

/**
 * Hooks for different operation types. Image analysis runs as chat, so
 * it reports through the chat (or responses) hooks.
 */
export type OpenAIHooks = {
  [K in keyof OpenAIOperations]?: OperationHooks<OpenAIOperations[K]>;
};

/**
 * Configuration options for the OpenAI provider.
 *
 * @example
 * ```typescript
 * const config: OpenAIConfig = {
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   organization: 'org-123456', // Optional
 *   retry: {
 *     maxRetries: 3,
 *     initialDelay: 1000,
 *     retryableStatuses: [0, 429, 500, 503],
 *   },
 *   retryEvents: {
 *     onRetry: (attempt, error, delay, context) => {
 *       console.log(`Retry attempt ${attempt} for ${context.operation} after ${delay}ms`);
 *     },
 *   },
 *   hooks: {
 *     chat: {
 *       beforeRequest: async (request, params, ctx, metadata) => {
 *         console.log('Chat request:', request);
 *         console.log('OpenAI params:', params);
 *       },
 *       afterRequest: async (request, params, response, ctx, metadata) => {
 *         console.log('Chat response:', response);
 *         console.log('OpenAI params used:', params);
 *       },
 *     },
 *   },
 * };
 * ```
 */
export interface OpenAIConfig {
  // OpenAI API key for authentication
  apiKey: string;
  // Custom base URL for OpenAI-compatible APIs (e.g., Azure OpenAI)
  baseURL?: string;
  // OpenAI organization ID for multi-org accounts
  organization?: string;
  // Optional project ID
  project?: string;
  // If you want to allow OpenAI to store contents of calls. By default this is false.
  store?: boolean;
  // Which API chat requests use. `auto` (the default) uses Chat Completions
  // unless the model or the request needs the Responses API.
  api?: 'auto' | 'chat' | 'responses';
  // Global retry configuration for all operations
  retry?: RetryConfig;
  // Global event handlers for retry lifecycle events
  retryEvents?: RetryEvents;
  // Hooks for intercepting requests and responses
  hooks?: OpenAIHooks;
  // Default models
  defaultModels?: {
    chat?: ModelInput;
    imageGenerate?: ModelInput;
    imageEdit?: ModelInput;
    imageAnalyze?: ModelInput;
    transcription?: ModelInput;
    speech?: ModelInput;
    embedding?: ModelInput;
  }
}

/**
 * Default model for each operation.
 */
export type DefaultModels = NonNullable<OpenAIConfig['defaultModels']>;

/**
 * Models used when neither the request, the context, nor the config names one.
 */
const DEFAULT_MODELS: DefaultModels = {
  imageGenerate: 'gpt-image-2',
  imageEdit: 'gpt-image-2',
  imageAnalyze: 'gpt-5.4-mini',
  transcription: 'gpt-transcribe',
  speech: 'gpt-4o-mini-tts',
  embedding: 'text-embedding-3-small',
};

/**
 * Everything one API call needs, resolved once from the request, context,
 * and config.
 */
interface OperationRun<TConfig> {
  config: TConfig;
  client: OpenAI;
  ctx: AIContextAny;
  metadata?: AIMetadataAny;
  model: Model;
  // The full model, when selection provided one
  modelInfo?: ModelInfo;
  signal?: AbortSignal;
  retry<R>(call: (signal?: AbortSignal) => Promise<R>): Promise<R>;
}

/**
 * The result of a chat call, or the `length` response that stands in for a
 * request that overflowed the context window.
 */
type ChatSent<R> = { result: R } | { overflow: Response };

// ============================================================================
// OpenAI Provider Class
// ============================================================================

/**
 * OpenAI provider implementation for the @aeye framework.
 *
 * Supports the full range of OpenAI capabilities including:
 * - Chat through Chat Completions, or the Responses API when a model or
 *   request needs it (hosted tools, reasoning summaries, Responses-only models)
 * - Function calling and structured outputs, streaming, and reasoning
 * - Image, audio, and file input; audio output
 * - Image generation and editing with GPT Image
 * - Transcription (with speaker diarization) and speech synthesis
 * - Text embeddings
 *
 * Can be extended by other OpenAI-compatible providers (e.g., Azure OpenAI, OpenRouter).
 *
 * @example Basic usage
 * ```typescript
 * import { OpenAIProvider } from '@aeye/openai';
 *
 * const provider = new OpenAIProvider({
 *   apiKey: process.env.OPENAI_API_KEY!,
 * });
 *
 * // Create an executor for chat completions
 * const executor = provider.createExecutor();
 *
 * const response = await executor(
 *   {
 *     messages: [
 *       { role: 'user', content: 'Hello!' }
 *     ]
 *   },
 *   {},
 *   { model: 'gpt-5.4-mini' }
 * );
 * ```
 *
 * @example With function calling
 * ```typescript
 * import { z } from 'zod';
 *
 * const response = await executor(
 *   {
 *     messages: [
 *       { role: 'user', content: 'What is the weather in San Francisco?' }
 *     ],
 *     tools: [
 *       {
 *         name: 'get_weather',
 *         description: 'Get current weather',
 *         parameters: z.object({
 *           location: z.string(),
 *         }),
 *       }
 *     ],
 *     toolChoice: 'auto',
 *   },
 *   {},
 *   { model: 'gpt-5.4-mini' }
 * );
 * ```
 *
 * @example Extending for custom providers
 * ```typescript
 * class CustomProvider extends OpenAIProvider {
 *   readonly name = 'custom';
 *
 *   protected createClient(config: OpenAIConfig) {
 *     return new OpenAI({
 *       apiKey: config.apiKey,
 *       baseURL: 'https://custom-api.example.com/v1',
 *     });
 *   }
 * }
 * ```
 *
 * @template TConfig Configuration type extending OpenAIConfig
 */
export class OpenAIProvider<TConfig extends OpenAIConfig = OpenAIConfig> implements Provider<TConfig> {
  // Provider name for error messages and identification
  readonly name: string = 'openai';

  // Config stored in the provider instance (used as fallback)
  readonly config: TConfig;

  // Default metadata to apply to all requests
  defaultMetadata?: Provider['defaultMetadata'];

  // Models used when neither the request, the context, nor the config names one
  protected readonly defaults: DefaultModels = DEFAULT_MODELS;

  constructor(config: TConfig) {
    this.config = config;
  }

  // ============================================================================
  // Client Creation (Can Override)
  // ============================================================================

  /**
   * Create OpenAI client from provider config.
   *
   * Subclasses can override this method to customize client initialization,
   * such as setting a custom base URL for OpenAI-compatible APIs.
   *
   * @param config Provider configuration
   * @returns Configured OpenAI client instance
   */
  protected createClient(config: TConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      organization: config.organization,
      project: config.project,
    });
  }

  /**
   * Convert OpenAI's model format to @aeye ModelInfo format.
   *
   * Subclasses can override this to enrich model metadata with
   * provider-specific information.
   *
   * @param model OpenAI model object
   * @returns Standardized ModelInfo object
   */
  protected convertModel(model: OpenAI.Model): ModelInfo {
    return {
      provider: this.name,
      id: model.id,
      name: model.id,
      capabilities: new Set(['chat', 'streaming']), // Minimal default, enriched by model sources
      tier: detectTier(model.id),
      pricing: {},
      contextWindow: 0, // Will be enriched by model sources
      maxOutputTokens: undefined,
      metadata: {
        ownedBy: model.owned_by,
        created: model.created,
      },
    };
  }

  // ============================================================================
  // Optional Override Methods for Request Customization
  // ============================================================================

  /**
   * Customize image generation params before sending to API.
   *
   * @param params Image generation parameters (mutate in place)
   * @param request Original @aeye request
   * @param config Provider configuration
   */
  protected augmentImageGenerateRequest?<TParams extends OpenAI.ImageGenerateParams>(
    params: TParams,
    request: ImageGenerationRequest,
    config: TConfig,
  ): void;

  /**
   * Customize image edit params before sending to API.
   *
   * @param params Image edit parameters (mutate in place)
   * @param request Original @aeye request
   * @param config Provider configuration
   */
  protected augmentImageEditRequest?<TParams extends OpenAI.ImageEditParams>(
    params: TParams,
    request: ImageEditRequest,
    config: TConfig,
  ): void;

  /**
   * Customize transcription params before sending to API.
   *
   * @param params Transcription parameters (mutate in place)
   * @param request Original @aeye request
   * @param config Provider configuration
   */
  protected augmentTranscriptionRequest?<TParams extends OpenAI.Audio.TranscriptionCreateParams>(
    params: TParams,
    request: TranscriptionRequest,
    config: TConfig
  ): void;

  /**
   * Customize speech generation params before sending to API.
   *
   * @param params Speech synthesis parameters (mutate in place)
   * @param request Original @aeye request
   * @param config Provider configuration
   */
  protected augmentSpeechRequest?<TParams extends OpenAI.Audio.SpeechCreateParams>(
    params: TParams,
    request: SpeechRequest,
    config: TConfig
  ): void;

  /**
   * Customize embedding params before sending to API.
   *
   * @param params Embedding parameters (mutate in place)
   * @param request Original @aeye request
   * @param config Provider configuration
   */
  protected augmentEmbeddingRequest?<TParams extends OpenAI.EmbeddingCreateParams>(
    params: TParams,
    request: EmbeddingRequest,
    config: TConfig,
  ): void;

  /**
   * Customize chat completion params before sending to API.
   *
   * Override this method to modify request parameters for custom providers
   * or to add provider-specific features.
   *
   * @param params OpenAI chat completion parameters
   * @param request Original @aeye request
   * @param config Provider configuration
   */
  protected augmentChatRequest<TParams extends OpenAI.Chat.ChatCompletionCreateParams>(
    params: TParams,
    request: Request,
    config: TConfig,
  ) {
    // No-op by default
  }

  /**
   * Augment chat message with provider-specific data.
   *
   * @param chatMessage - OpenAI chat message
   * @param message - Original @aeye message
   * @param config - Provider configuration
   */
  protected augmentChatMessage<TMessage extends OpenAI.Chat.ChatCompletionMessageParam>(
    chatMessage: TMessage,
    message: Message,
    config: TConfig,
  ) {
    // No-op by default
  }

  /**
   * Get augmented chat message with provider-specific data.
   */
  private getChatMessage<TMessage extends OpenAI.Chat.ChatCompletionMessageParam>(
    chatMessage: TMessage,
    message: Message,
    config: TConfig,
  ) {
    this.augmentChatMessage(chatMessage, message, config);
    return chatMessage;
  }

  /**
   * Augment chat content part with provider-specific data.
   *
   * @param chatContent - OpenAI chat content part
   * @param content - Original @aeye message content
   * @param config - Provider configuration
   */
  protected augmentChatContent<TContent extends OpenAI.Chat.Completions.ChatCompletionContentPart>(
    chatContent: TContent,
    content: MessageContent,
    config: TConfig,
  ) {
    // No-op by default
  }

  /**
   * Get augmented chat content part with provider-specific data. A cache
   * breakpoint on the content marks the part.
   */
  private getChatContent<TContent extends OpenAI.Chat.Completions.ChatCompletionContentPart>(
    chatContent: TContent,
    content: MessageContent,
    config: TConfig,
  ) {
    const part = content.cacheBreakpoint ? { ...chatContent, prompt_cache_breakpoint: {} } : chatContent;
    this.augmentChatContent(part, content, config);
    return part;
  }

  /**
   * Augment chat chunk with provider-specific data.
   *
   * @param expected - The chunk as received
   * @param chunk - @aeye chunk to augment
   * @param config - Provider configuration
   */
  protected augmentChatChunk<TParams extends OpenAI.Chat.Completions.ChatCompletionChunk>(
    expected: TParams,
    chunk: Chunk,
    config: TConfig,
  ) {
    // No-op by default
  }

  /**
   * Augment chat response with provider-specific data.
   *
   * @param expected - The completion as received
   * @param response - @aeye response object to augment
   * @param config - Provider configuration
   */
  protected augmentChatResponse<TParams extends OpenAI.Chat.Completions.ChatCompletion>(
    expected: TParams,
    response: Response,
    config: TConfig,
  ) {
    // No-op by default
  }

  // ============================================================================
  // Message & Request Conversion (Protected - Reusable)
  // ============================================================================

  /**
   * Convert @aeye MessageContent to OpenAI text content format, for roles
   * that only accept text.
   *
   * @param x - Message content
   * @param name - Who sent it, for placeholder text
   * @param config - Provider configuration
   */
  protected convertContentText(
    x: string | MessageContent[],
    name: string,
    config: TConfig
  ): OpenAI.Chat.Completions.ChatCompletionContentPartText[] {
    if (typeof x === 'string') {
      return [{ type: 'text', text: x }];
    }

    return x.map((part) => this.getChatContent({
      type: 'text',
      text: part.type === 'text'
        ? String(part.content)
        : `${part.type[0].toUpperCase()}${part.type.slice(1)} sent by ${name} not included in content.`,
    }, part, config));
  }

  /**
   * Convert @aeye MessageContent to OpenAI format.
   *
   * @param x - Message content
   * @param name - Who sent it, for placeholder text
   * @param config - Provider configuration
   */
  protected async convertContent(
    x: string | MessageContent[],
    name: string,
    config: TConfig
  ): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart[]> {
    if (typeof x === 'string') {
      return [{ type: 'text', text: x }];
    }

    return Promise.all(x.map(async (part): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart> => {
      const note = (text: string) => this.getChatContent({ type: 'text', text }, part, config);

      switch (part.type) {
        case 'text': {
          const text = await toText(part.content).catch(() => `Text content sent by ${name} could not be converted to text.`);
          return note(text);
        }

        case 'image': {
          const url = await toURL(part.content, part.format, 'INVALID').catch(() => 'INVALID');
          if (url === 'INVALID') {
            return note(`Image content sent by ${name} could not be converted to a URL.`);
          }
          return this.getChatContent({ type: 'image_url', image_url: { url, detail: part.detail } }, part, config);
        }

        case 'audio': {
          const base64 = await toBase64(part.content, undefined, 'INVALID').catch(() => 'INVALID');
          if (base64 === 'INVALID') {
            return note(`Audio content sent by ${name} could not be converted to base64.`);
          }
          const [, mimeType = '', data = ''] = /^data:([^;]+);base64,(.+)$/.exec(base64) ?? [];
          const format = (part.format ?? mimeType).includes('wav') ? 'wav' : 'mp3';
          return this.getChatContent({ type: 'input_audio', input_audio: { data, format } }, part, config);
        }

        case 'file': {
          const fileData = await toBase64(part.content, part.format, 'INVALID').catch(() => 'INVALID');
          if (fileData === 'INVALID') {
            return note(`File content sent by ${name} could not be converted to base64.`);
          }
          return this.getChatContent({
            type: 'file',
            file: { file_data: fileData, filename: part.name ?? `file${part.format ? `.${part.format}` : ''}` },
          }, part, config);
        }

        default:
          return note(`${part.type} content sent by ${name} is not supported.`);
      }
    }));
  }

  /**
   * Convert @aeye ToolCall to OpenAI format.
   * @param x ToolCall object
   */
  protected convertToolCall(x: ToolCall): OpenAI.Chat.ChatCompletionMessageToolCall {
    return {
      id: x.id,
      type: 'function',
      function: {
        name: x.name,
        arguments: x.arguments,
      },
    };
  }

  /**
   * Converts a name on a message to conform to OpenAI's naming rules.
   * Removes invalid characters and truncates to max length.
   *
   * @param name - Original name
   * @returns Converted name or undefined
   */
  protected convertName(name: string | undefined): string | undefined {
    if (!name) {
      return undefined;
    }
    return name.replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9-_]/g, '')
      .substring(0, 64);
  }

  /**
   * Convert @aeye Request messages to Chat Completions messages.
   *
   * Handles conversion of all message types (system, user, assistant, tool)
   * and content types (text, image, audio, file).
   *
   * @param request @aeye request object
   * @param config Provider configuration
   * @returns Array of OpenAI-formatted messages
   */
  protected async convertMessages(request: Request, config: TConfig): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    return (await Promise.all(request.messages.map(async (msg): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> => {
      switch (msg.role) {
        case 'system':
          return [this.getChatMessage({
            role: 'developer',
            name: this.convertName(msg.name),
            content: this.convertContentText(msg.content, msg.name || 'system', config),
          }, msg, config)];
        case 'tool':
          return [this.getChatMessage({
            role: 'tool',
            tool_call_id: msg.toolCallId ?? '',
            content: this.convertContentText(msg.content, msg.name || 'tool', config),
          }, msg, config)];
        case 'user':
          return [this.getChatMessage({
            role: 'user',
            name: this.convertName(msg.name),
            content: await this.convertContent(msg.content, msg.name || 'user', config),
          }, msg, config)];
        case 'assistant': {
          const name = this.convertName(msg.name);
          const toolCalls = msg.toolCalls?.map((tc) => this.convertToolCall(tc));
          const content = await this.convertContent(msg.content, msg.name || 'assistant', config);
          if (content.every(c => c.type === 'text')) {
            return [this.getChatMessage({ role: 'assistant', name, tool_calls: toolCalls, content }, msg, config)];
          }
          // The assistant role only takes text, so non-text parts are sent
          // as user messages in place
          const firstText = content.findIndex(c => c.type === 'text');
          return content.map((part, index): OpenAI.Chat.ChatCompletionMessageParam => part.type === 'text'
            ? this.getChatMessage({ role: 'assistant', name, tool_calls: index === firstText ? toolCalls : undefined, content: [part] }, msg, config)
            : this.getChatMessage({ role: 'user', name, content: [part] }, msg, config)
          );
        }
      }
    }))).flat();
  }

  /**
   * Convert @aeye Request messages to Responses API input items. Assistant
   * turns replay their Responses reasoning so stateless requests keep it, and
   * tool results may carry images and files.
   *
   * @param request @aeye request object
   * @param config Provider configuration
   */
  protected async convertResponsesInput(request: Request, config: TConfig): Promise<OpenAI.Responses.ResponseInputItem[]> {
    const content = async (msg: Message) =>
      (await this.convertContent(msg.content, msg.name || msg.role, config)).map(toInputContent);

    return (await Promise.all(request.messages.map(async (msg): Promise<OpenAI.Responses.ResponseInputItem[]> => {
      switch (msg.role) {
        case 'system':
          return [{ role: 'developer', content: await content(msg) }];
        case 'user':
          return [{ role: 'user', content: await content(msg) }];
        case 'tool':
          return [{ type: 'function_call_output', call_id: msg.toolCallId ?? '', output: await content(msg) }];
        case 'assistant': {
          const text = this.convertContentText(msg.content, msg.name || 'assistant', config).map(part => part.text).join('');
          return [
            ...toReasoningItems(msg.reasoning),
            ...(text ? [{ role: 'assistant' as const, content: text }] : []),
            ...(msg.toolCalls ?? []).map(tc => ({ type: 'function_call' as const, call_id: tc.id, name: tc.name, arguments: tc.arguments })),
          ];
        }
      }
    }))).flat();
  }

  /**
   * Convert @aeye tool definitions to OpenAI format.
   *
   * Strict-mode is a best-effort wish: a tool's `strict: true` only takes
   * effect when `resolveStrictFormat(model) === 'openai'` (resolved from
   * the model's `strictFormat` override, or its `provider` / `id` prefix).
   * Numeric
   * priority (`strict: <n>`) competes for slot allocation under the shared
   * `SchemaBudget`; tools that don't fit fall back to LENIENT silently.
   *
   * Tools are emitted in their original declaration order, but slot
   * allocation walks them in *descending priority* order so the most-wanted
   * strict items consume the budget first.
   *
   * @param request @aeye request (mutated: each tool's `descriptor` field is
   *                pinned for the validation roundtrip)
   * @param budget  shared allocator (also fed by `convertResponseFormat`)
   */
  protected convertTools(
    request: Request,
    budget: SchemaBudget,
  ): OpenAI.Chat.ChatCompletionFunctionTool[] | undefined {
    if (!request.tools || request.tools.length === 0) return undefined;

    const descriptors = this.allocateToolDescriptors(request, budget);

    return request.tools.map((tool, i) => {
      const descriptor = descriptors[i];
      const strictifiedSchema = strictify(tool.parameters, descriptor);

      // Only set the API-level strict flag when we're actually emitting a
      // strict-mode-compatible schema. Setting strict:true with a schema
      // that violates OpenAI's strict-mode rules is the failure mode we
      // are trying to avoid.
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: toJSONSchema(strictifiedSchema, descriptor),
          ...(descriptor.strict ? { strict: true } : {}),
        },
      };
    });
  }

  /**
   * The set of strict descriptor families this provider can speak on the
   * wire. Defaults to `['openai']` — the OpenAI Chat Completions API only
   * accepts OpenAI-shaped strict schemas. Subclasses or custom providers
   * extending OpenAIProvider can extend this set to accept additional
   * registered families (e.g. a custom `'openai-tight'` variant).
   */
  protected supportedStrictFamilies: ReadonlySet<DescriptorFamily> = new Set<DescriptorFamily>(['openai']);

  /**
   * Build a SchemaBudget tuned to the strictest of the model's tool /
   * structured-output families. Anthropic-style per-request limits apply
   * across BOTH tool schemas and the response_format schema, so the budget
   * is shared between `convertTools` and `convertResponseFormat`.
   *
   * Strict mode engages only when the model's resolved family is in
   * `supportedStrictFamilies` AND the model has the corresponding
   * capability (`'toolsStrict'` for tools, `'structured'` for output).
   * Otherwise the family's non-strict descriptor applies, which keeps the
   * dialect's own constraints (Gemini rejects LENIENT's recursive `$defs/Any`)
   * even when only the model id is known. Families the API doesn't speak
   * fall back to LENIENT — protects the wire from receiving a dialect the API
   * doesn't understand.
   *
   * @param model The full model, or just its id and provider when selection
   *   didn't supply one
   */
  protected buildSchemaBudget(model: Pick<ModelInfo, 'id' | 'provider' | 'strictFormat'> & { capabilities?: ModelInfo['capabilities'] }): SchemaBudget {
    const family = resolveStrictFormat(model);
    const descriptorFor = (capability: 'toolsStrict' | 'structured') =>
      family !== undefined && this.supportedStrictFamilies.has(family)
        ? getDescriptor(family, model.capabilities?.has(capability) ?? false)
        : LENIENT;
    return new SchemaBudget(strictestOf(descriptorFor('toolsStrict'), descriptorFor('structured')));
  }

  /**
   * The schema budget for a call: from the selected model, or from the model
   * id alone.
   */
  private schemaBudget(run: OperationRun<TConfig>): SchemaBudget {
    return this.buildSchemaBudget(run.modelInfo ?? { id: run.model.id, provider: this.name });
  }

  /**
   * Allocate per-tool descriptors in descending-priority order, then return
   * them in original declaration order. Mutates `request.tools[i].descriptor`
   * to record the chosen id for the Prompt's validation roundtrip.
   */
  private allocateToolDescriptors(request: Request, budget: SchemaBudget): FormatDescriptor[] {
    const tools = request.tools ?? [];
    const order = tools
      .map((t, i) => ({ i, p: strictPriority(t.strict) }))
      .sort((a, b) => b.p - a.p);

    const descriptors: FormatDescriptor[] = new Array(tools.length);
    for (const { i } of order) {
      const tool = tools[i];
      descriptors[i] = budget.allocateTool(tool.parameters, tool.strict);
      tool.descriptor = descriptors[i].id;
    }
    return descriptors;
  }

  /**
   * Convert @aeye tool choice to OpenAI format.
   *
   * @param request @aeye request object
   * @returns OpenAI-formatted tool choice option or undefined
   */
  protected convertToolChoice(
    request: Request
  ): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
    const choice = request.toolChoice;
    return typeof choice === 'object'
      ? { type: 'function', function: { name: choice.tool } }
      : choice;
  }

  /**
   * Convert @aeye response format to OpenAI format.
   *
   * Strict structured output is best-effort: honored only when the chosen
   * `resolveStrictFormat(model) === 'openai'` AND the model has the
   * `'structured'` capability. For unsupported models
   * the LENIENT descriptor is used and the API-level `strict: true` flag is
   * omitted — silent fallback. The chosen descriptor is pinned on the
   * `responseFormat.descriptor` so the Prompt validator can apply the
   * matching strictify before parsing model output.
   *
   * @param request @aeye request object (mutated to record descriptor)
   * @param budget shared allocator (also fed by `convertTools`)
   * @returns OpenAI-formatted response format or undefined
   */
  protected convertResponseFormat(
    request: Request,
    budget: SchemaBudget,
  ): OpenAI.ResponseFormatText | OpenAI.ResponseFormatJSONObject | OpenAI.ResponseFormatJSONSchema | undefined {
    const format = request.responseFormat;
    if (!format) return undefined;
    if (format === 'text') return { type: 'text' };
    if (format === 'json') return { type: 'json_object' };

    const descriptor = budget.allocateOutput(format.type, format.strict ?? 1);
    format.descriptor = descriptor.id;

    return {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: toJSONSchema(strictify(format.type, descriptor), descriptor),
        ...(descriptor.strict ? { strict: true } : {}),
      },
    };
  }

  // ============================================================================
  // Provider Interface Implementation
  // ============================================================================

  /**
   * List available models from OpenAI.
   *
   * @param config Optional configuration override
   * @returns Array of available models with metadata
   * @throws {ProviderError} If listing models fails
   */
  async listModels(config?: TConfig): Promise<ModelInfo[]> {
    const client = this.createClient({ ...this.config, ...config });

    try {
      const response = await client.models.list();
      return response.data.map((m) => this.convertModel(m));
    } catch (error) {
      throw new ProviderError(this.name, 'Failed to list models', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Check if the OpenAI API is accessible with the provided credentials.
   *
   * @param config Optional configuration override
   * @returns true if API is accessible, false otherwise
   */
  async checkHealth(config?: TConfig): Promise<boolean> {
    try {
      await this.createClient({ ...this.config, ...config }).models.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve what one API call needs: the effective config and its client,
   * the model (request, then context, then metadata, then configured and
   * built-in defaults), and retries.
   *
   * @param operation - Operation name for retry events and errors
   * @param request - The request
   * @param ctx - The context
   * @param metadata - Request metadata, for chat
   * @param config - Per-call config override
   * @param signal - Per-call abort signal
   * @param defaultModel - Which configured default model applies
   */
  protected prepare(
    operation: string,
    request: BaseRequest,
    ctx: AIContextAny,
    metadata: AIMetadataAny | undefined,
    config: TConfig | undefined,
    signal: AbortSignal | undefined,
    defaultModel: keyof DefaultModels,
  ): OperationRun<TConfig> {
    const effectiveConfig = { ...this.config, ...config };
    const model = getModel(
      request.model || ctx.metadata?.model || metadata?.model ||
      effectiveConfig.defaultModels?.[defaultModel] || this.defaults[defaultModel]
    );
    if (!model) {
      throw new ProviderError(this.name, `Model is required for ${this.name} requests`);
    }

    const retryConfig: RetryConfig = { ...effectiveConfig.retry, ...request.extra?.retry };
    const retryEvents: RetryEvents = request.extra?.retryEvents || effectiveConfig.retryEvents || {};
    const retryContext: RetryContext = {
      operation,
      model: model.id,
      provider: this.name,
      startTime: Date.now(),
    };
    const effectiveSignal = signal || ctx.signal;

    return {
      config: effectiveConfig,
      client: this.createClient(effectiveConfig),
      ctx,
      metadata,
      model,
      modelInfo: pickModelInfo(metadata, ctx, model.id),
      signal: effectiveSignal,
      retry: (call) => withRetry(() => call(effectiveSignal), retryContext, retryConfig, retryEvents, effectiveSignal),
    };
  }

  /**
   * Send one API call with retries, around the operation's before and error
   * hooks. A context-window rejection becomes a ContextWindowError.
   */
  private async send<K extends keyof OpenAIOperations, R>(
    op: K,
    run: OperationRun<TConfig>,
    request: OpenAIOperations[K]['request'],
    params: OpenAIOperations[K]['params'],
    call: (signal?: AbortSignal) => Promise<R>,
  ): Promise<R> {
    const hooks = run.config.hooks?.[op];
    await hooks?.beforeRequest?.(request, params, run.ctx, run.metadata);
    try {
      return await run.retry(call);
    } catch (e) {
      if (!(e instanceof Error)) {
        throw e;
      }
      if (isContextWindowError(e)) {
        throw new ContextWindowError(this.name, `Context window exceeded during ${op}`, parseContextWindowError(e)?.contextWindow, e);
      }
      await hooks?.onError?.(request, params, e, run.ctx, run.metadata);
      throw e;
    }
  }

  /**
   * Report a response to the operation's after hook and return it.
   */
  private async finish<K extends keyof OpenAIOperations>(
    op: K,
    run: OperationRun<TConfig>,
    request: OpenAIOperations[K]['request'],
    params: OpenAIOperations[K]['params'],
    response: OpenAIOperations[K]['response'],
  ): Promise<OpenAIOperations[K]['response']> {
    await run.config.hooks?.[op]?.afterRequest?.(request, params, response, run.ctx, run.metadata);
    return response;
  }

  /**
   * Send a chat call. A request that overflows the context window ends as
   * `length` rather than failing, so the prompt loop can trim and retry.
   */
  private async sendChat<K extends 'chat' | 'responses', R>(
    op: K,
    run: OperationRun<TConfig>,
    request: Request,
    params: OpenAIOperations[K]['params'],
    call: (signal?: AbortSignal) => Promise<R>,
  ): Promise<ChatSent<R>> {
    try {
      return { result: await this.send(op, run, request, params, call) };
    } catch (e) {
      if (!(e instanceof ContextWindowError)) {
        throw e;
      }
      const overflow: Response = { content: '', toolCalls: [], finishReason: 'length', model: run.model, usage: { text: { input: e.contextWindow } } };
      return { overflow: await this.finish(op, run, request, params, overflow) };
    }
  }

  /**
   * Relay streamed chunks, then report the assembled response to the after
   * hook (even when the stream fails part way) and return it.
   */
  private async *relay<K extends 'chat' | 'responses'>(
    op: K,
    run: OperationRun<TConfig>,
    request: Request,
    params: OpenAIOperations[K]['params'],
    chunks: AsyncIterable<Chunk>,
  ): AsyncGenerator<Chunk, Response> {
    const received: Chunk[] = [];
    let response: Response;
    try {
      for await (const chunk of chunks) {
        if (run.signal?.aborted) {
          throw new Error('Request aborted');
        }
        received.push(chunk);
        yield chunk;
      }
    } finally {
      response = getResponseFromChunks(received, run.model);
      await this.finish(op, run, request, params, response);
    }
    return response;
  }

  // ============================================================================
  // Chat
  // ============================================================================

  /**
   * Whether a chat request goes to the Responses API: always or never when
   * configured, otherwise when the model is Responses-only or the request
   * uses something only Responses offers.
   *
   * @param request - The request
   * @param modelId - The model it targets
   * @param config - Provider configuration
   */
  protected usesResponses(request: Request, modelId: string, config: TConfig): boolean {
    const api = config.api ?? 'auto';
    if (api !== 'auto') {
      return api === 'responses';
    }
    const { mode, summary, context } = request.reason ?? {};
    return isResponsesOnly(modelId) || !!request.hostedTools?.length || !!(mode || summary || context);
  }

  /**
   * Chat Completions parameters for a request, before the stream flag.
   *
   * @param request - The request
   * @param run - The resolved call
   * @param streaming - Whether the response will stream (audio output
   *   streams only as PCM)
   */
  protected async buildChatParams(request: Request, run: OperationRun<TConfig>, streaming: boolean): Promise<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming> {
    const budget = this.schemaBudget(run);
    const tools = this.convertTools(request, budget);
    const audio = request.modalities?.includes('audio') ? request.audio : undefined;

    return {
      model: run.model.id,
      messages: await this.convertMessages(request, run.config),
      temperature: request.temperature,
      top_p: request.topP,
      max_completion_tokens: request.maxTokens,
      frequency_penalty: request.frequencyPenalty,
      presence_penalty: request.presencePenalty,
      logit_bias: request.logitBias,
      logprobs: request.logProbabilities,
      seed: request.seed,
      stop: request.stop,
      tools,
      tool_choice: tools?.length ? this.convertToolChoice(request) : undefined,
      parallel_tool_calls: tools?.length ? !request.toolsOneAtATime : undefined,
      response_format: this.convertResponseFormat(request, budget),
      reasoning_effort: request.reason?.effort && clampReasoningEffort(request.reason.effort, run.modelInfo?.reasoningEfforts),
      verbosity: request.verbosity,
      service_tier: request.serviceTier,
      metadata: request.metadata,
      modalities: audio ? ['text', 'audio'] : undefined,
      audio: audio && { voice: audio.voice, format: toChatAudioFormat(audio.format ?? (streaming ? 'pcm' : 'mp3')) },
      moderation: request.moderate ? { model: MODERATION_MODEL } : undefined,
      prompt_cache_key: request.cacheKey,
      safety_identifier: request.userKey,
      store: run.config.store ?? false,
      ...request.extra,
    };
  }

  /**
   * Responses API parameters for a request, before the stream flag.
   * Reasoning comes back encrypted unless responses are stored, so later
   * turns can replay it.
   *
   * @param request - The request
   * @param run - The resolved call
   */
  protected async buildResponsesParams(request: Request, run: OperationRun<TConfig>): Promise<OpenAI.Responses.ResponseCreateParamsNonStreaming> {
    const budget = this.schemaBudget(run);
    const store = run.config.store ?? false;
    const format = this.convertResponseFormat(request, budget);
    const tools: OpenAI.Responses.Tool[] = [
      ...(this.convertTools(request, budget) ?? []).map(({ function: fn }): OpenAI.Responses.FunctionTool => ({
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ?? null,
        strict: fn.strict ?? false,
      })),
      ...(request.hostedTools ?? []).map(tool => toHostedTool(tool, this.name)),
    ];
    const choice = request.toolChoice;
    const reason = request.reason;

    return {
      model: run.model.id,
      input: await this.convertResponsesInput(request, run.config),
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? (typeof choice === 'object' ? { type: 'function', name: choice.tool } : choice) : undefined,
      parallel_tool_calls: tools.length ? !request.toolsOneAtATime : undefined,
      text: {
        format: format?.type === 'json_schema' ? { type: 'json_schema', ...format.json_schema, schema: format.json_schema.schema ?? {} } : format,
        verbosity: request.verbosity,
      },
      reasoning: reason && {
        effort: reason.effort && clampReasoningEffort(reason.effort, run.modelInfo?.reasoningEfforts),
        summary: reason.summary,
        mode: reason.mode,
        context: reason.context,
      },
      include: store ? undefined : ['reasoning.encrypted_content'],
      max_output_tokens: request.maxTokens,
      temperature: request.temperature,
      top_p: request.topP,
      metadata: request.metadata,
      service_tier: request.serviceTier,
      moderation: request.moderate ? { model: MODERATION_MODEL } : undefined,
      prompt_cache_key: request.cacheKey,
      safety_identifier: request.userKey,
      store,
      ...request.extra,
    };
  }

  /**
   * Map a Chat Completions result to a @aeye response.
   */
  private chatResponse(completion: OpenAI.Chat.Completions.ChatCompletion, request: Request, run: OperationRun<TConfig>): Response {
    const { message, finish_reason } = completion.choices[0];
    const toolCalls = message.tool_calls?.flatMap((tc) => tc.type === 'function'
      ? [{ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }]
      : []);
    const citations = message.annotations?.map(note => toCitation(note.url_citation));

    return {
      content: message.content || '',
      toolCalls,
      finishReason: toolCalls?.length ? 'tool_calls' : finish_reason === 'function_call' /* deprecated */ ? 'stop' : finish_reason,
      refusal: message.refusal ?? (finish_reason === 'content_filter' ? message.content ?? undefined : undefined),
      citations: citations?.length ? citations : undefined,
      audio: message.audio ? { id: message.audio.id, data: message.audio.data, transcript: message.audio.transcript, format: request.audio?.format } : undefined,
      moderation: completion.moderation ? toModeration(completion.moderation) : undefined,
      serviceTier: toServiceTier(completion.service_tier),
      model: run.model,
      usage: completion.usage ? chatUsage(completion.usage) : undefined,
    };
  }

  /**
   * Turn a Chat Completions stream into chunks.
   *
   * Tool calls are finalized only on positive evidence they're done: a
   * finish reason on the chunk (the whole response is done), or a higher
   * tool-call index (tool calls arrive in index order). Providers interleave
   * usage-only and keep-alive chunks, so "not updated this chunk" is not
   * evidence. Anything unfinished when the stream ends is finalized then.
   */
  private async *chatChunks(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    request: Request,
    config: TConfig,
  ): AsyncGenerator<Chunk> {
    type ToolCallItem = ToolCall & { named: boolean; finished: boolean; index: number };
    const toolCalls = new Map<number, ToolCallItem>();
    let maxIndexSeen = -1;

    // Emits a tool call as finished, and as named first if it never was
    const finalize = (toolCall: ToolCallItem, chunk: Chunk) => {
      toolCall.finished = true;
      chunk.toolCall = toolCall;
      if (!toolCall.named) {
        chunk.toolCallNamed = chunk.toolCallArguments = toolCall;
        toolCall.named = true;
      }
    };

    try {
      for await (const raw of stream) {
        const choice = raw?.choices[0];
        const delta = choice?.delta;
        const finish = choice?.finish_reason;

        // OpenAI streams `finish_reason: null` on every intermediate chunk
        const chunk: Chunk = {
          content: delta?.content || undefined,
          finishReason: finish === 'function_call' /* deprecated */ ? 'stop' : finish ?? undefined,
          refusal: delta?.refusal ?? undefined,
          audio: delta?.audio && { id: delta.audio.id, data: delta.audio.data, transcript: delta.audio.transcript, format: request.audio?.format },
          moderation: raw.moderation ? toModeration(raw.moderation) : undefined,
          serviceTier: toServiceTier(raw.service_tier),
          usage: raw.usage ? chatUsage(raw.usage) : undefined,
        };

        for (const tc of delta?.tool_calls ?? []) {
          const toolCall = toolCalls.get(tc.index) ?? { id: '', name: '', arguments: '', named: false, finished: false, index: tc.index };
          toolCalls.set(tc.index, toolCall);
          toolCall.id = tc.id || toolCall.id;
          toolCall.name = tc.function?.name || toolCall.name;
          toolCall.arguments += tc.function?.arguments ?? '';
          maxIndexSeen = Math.max(maxIndexSeen, tc.index);

          if (toolCall.arguments) {
            if (toolCall.named) {
              chunk.toolCallArguments = toolCall;
            } else {
              chunk.toolCallNamed = toolCall;
              toolCall.named = true;
            }
          }
        }

        for (const toolCall of toolCalls.values()) {
          if (!toolCall.finished && (chunk.finishReason !== undefined || toolCall.index < maxIndexSeen)) {
            finalize(toolCall, chunk);
          }
        }

        this.augmentChatChunk(raw, chunk, config);
        yield chunk;
      }
    } finally {
      const empty: OpenAI.Chat.Completions.ChatCompletionChunk = { choices: [], created: 0, id: '', model: '', object: 'chat.completion.chunk' };
      for (const toolCall of toolCalls.values()) {
        if (!toolCall.finished) {
          const chunk: Chunk = {};
          finalize(toolCall, chunk);
          this.augmentChatChunk(empty, chunk, config);
          yield chunk;
        }
      }
    }
  }

  /**
   * Run a chat request through Chat Completions.
   */
  private async complete(request: Request, run: OperationRun<TConfig>): Promise<Response> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = { ...await this.buildChatParams(request, run, false), stream: false };
    this.augmentChatRequest(params, request, run.config);

    const sent = await this.sendChat('chat', run, request, params, async (signal) => {
      const completion = await run.client.chat.completions.create(params, { signal });
      if (!completion.choices?.[0]) {
        throw new ProviderError(this.name, 'No choices in response');
      }
      return completion;
    });
    if ('overflow' in sent) {
      return sent.overflow;
    }

    const response = this.chatResponse(sent.result, request, run);
    this.augmentChatResponse(sent.result, response, run.config);
    return this.finish('chat', run, request, params, response);
  }

  /**
   * Stream a chat request through Chat Completions.
   */
  private async *completeStream(request: Request, run: OperationRun<TConfig>): AsyncGenerator<Chunk, Response> {
    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      ...await this.buildChatParams(request, run, true),
      stream: true,
      stream_options: { include_usage: true },
    };
    this.augmentChatRequest(params, request, run.config);

    const sent = await this.sendChat('chat', run, request, params, (signal) => run.client.chat.completions.create(params, { signal }));
    if ('overflow' in sent) {
      return sent.overflow;
    }
    return yield* this.relay('chat', run, request, params, this.chatChunks(sent.result, request, run.config));
  }

  /**
   * Run a chat request through the Responses API.
   */
  private async respond(request: Request, run: OperationRun<TConfig>): Promise<Response> {
    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = { ...await this.buildResponsesParams(request, run), stream: false };

    const sent = await this.sendChat('responses', run, request, params, (signal) => run.client.responses.create(params, { signal }));
    if ('overflow' in sent) {
      return sent.overflow;
    }

    const chunks = [...sent.result.output.map(item => outputItemChunk(item, false)), responseEndChunk(sent.result)];
    return this.finish('responses', run, request, params, getResponseFromChunks(chunks, run.model));
  }

  /**
   * Stream a chat request through the Responses API.
   */
  private async *respondStream(request: Request, run: OperationRun<TConfig>): AsyncGenerator<Chunk, Response> {
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = { ...await this.buildResponsesParams(request, run), stream: true };

    const sent = await this.sendChat('responses', run, request, params, (signal) => run.client.responses.create(params, { signal }));
    if ('overflow' in sent) {
      return sent.overflow;
    }
    return yield* this.relay('responses', run, request, params, responseChunks(sent.result, this.name));
  }

  /**
   * Create an executor for chat requests.
   *
   * @param config Optional configuration override
   * @returns Executor function for chat
   * @throws {ProviderError} If request fails
   */
  createExecutor(config?: TConfig): Executor<AIContextAny, AIMetadataAny> {
    return (request, ctx, metadata, signal) => {
      const run = this.prepare('chat', request, ctx, metadata, config, signal, 'chat');
      return this.usesResponses(request, run.model.id, run.config)
        ? this.respond(request, run)
        : this.complete(request, run);
    };
  }

  /**
   * Create a streamer for streaming chat requests.
   *
   * @param config Optional configuration override
   * @returns Streamer async generator function
   * @throws {ProviderError} If request fails
   */
  createStreamer(config?: TConfig): Streamer<AIContextAny, AIMetadataAny> {
    return (request, ctx, metadata, signal) => {
      const run = this.prepare('streaming chat', request, ctx, metadata, config, signal, 'chat');
      return this.usesResponses(request, run.model.id, run.config)
        ? this.respondStream(request, run)
        : this.completeStream(request, run);
    };
  }

  // ============================================================================
  // Images
  // ============================================================================

  /**
   * Relay image generation or edit progress, then report the final images
   * to the after hook.
   */
  private async *imageProgress<K extends 'imageGenerate' | 'imageEdit'>(
    op: K,
    run: OperationRun<TConfig>,
    request: OpenAIOperations[K]['request'],
    params: OpenAIOperations[K]['params'],
    events: AsyncIterable<OpenAI.Images.ImageGenStreamEvent | OpenAI.Images.ImageEditStreamEvent>,
    partials: number,
  ): AsyncGenerator<ImageGenerationChunk> {
    const images: GeneratedImage[] = [];
    let received = 0;
    for await (const event of events) {
      if (run.signal?.aborted) {
        throw new Error('Request aborted');
      }
      const image = { b64_json: event.b64_json };
      const done = event.type === 'image_generation.completed' || event.type === 'image_edit.completed';
      if (done) {
        images.push(image);
      }
      yield {
        progress: ++received / (partials + 1),
        done,
        image,
        model: run.model,
        usage: done ? imageUsage(event, 1) : undefined,
      };
    }
    await this.finish(op, run, request, params, { images, model: run.model });
  }

  /**
   * Generate images.
   *
   * @param request Image generation request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Generated images
   * @throws {ProviderError} If generation fails
   */
  generateImage: Provider['generateImage'] = async (
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<ImageGenerationResponse> => {
    const run = this.prepare('generate image', request, ctx, undefined, config, undefined, 'imageGenerate');
    const params: OpenAI.Images.ImageGenerateParamsNonStreaming = {
      ...imageParams(request, run.model.id, run.modelInfo),
      moderation: request.moderation,
      ...request.extra,
      stream: false,
    };
    this.augmentImageGenerateRequest?.(params, request, run.config);

    const result = await this.send('imageGenerate', run, request, params, (signal) => run.client.images.generate(params, { signal }));
    const images = (result.data ?? []).map(toGeneratedImage);
    return this.finish('imageGenerate', run, request, params, { images, model: run.model, usage: imageUsage(result, images.length) });
  }

  /**
   * Generate images with streaming partial images.
   *
   * @param request Image generation request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Async generator yielding progress chunks
   * @throws {ProviderError} If generation fails
   */
  generateImageStream: Provider['generateImageStream'] = async function* (
    this: OpenAIProvider<TConfig>,
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<ImageGenerationChunk> {
    const run = this.prepare('generate image stream', request, ctx, undefined, config, undefined, 'imageGenerate');
    const partials = partialImages(request);
    const params: OpenAI.Images.ImageGenerateParamsStreaming = {
      ...imageParams(request, run.model.id, run.modelInfo),
      moderation: request.moderation,
      partial_images: partials,
      ...request.extra,
      stream: true,
    };
    this.augmentImageGenerateRequest?.(params, request, run.config);

    const events = await this.send('imageGenerate', run, request, params, (signal) => run.client.images.generate(params, { signal }));
    yield* this.imageProgress('imageGenerate', run, request, params, events, partials);
  }

  /**
   * Image edit parameters shared by the streaming and non-streaming paths.
   */
  private async editParams(request: ImageEditRequest, run: OperationRun<TConfig>) {
    return {
      ...imageParams(request, run.model.id, run.modelInfo),
      image: await Promise.all([request.image, ...request.references ?? []].map((image) => toFile(image))),
      mask: request.mask ? await toFile(request.mask) : undefined,
      input_fidelity: request.inputFidelity,
      ...request.extra,
    };
  }

  /**
   * Edit or combine images with a text prompt and an optional mask.
   *
   * @param request Image edit request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Edited images
   * @throws {ProviderError} If editing fails
   */
  editImage: Provider['editImage'] = async (
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<ImageGenerationResponse> => {
    const run = this.prepare('edit image', request, ctx, undefined, config, undefined, 'imageEdit');
    const params: OpenAI.Images.ImageEditParamsNonStreaming = { ...await this.editParams(request, run), stream: false };
    this.augmentImageEditRequest?.(params, request, run.config);

    const result = await this.send('imageEdit', run, request, params, (signal) => run.client.images.edit(params, { signal }));
    const images = (result.data ?? []).map(toGeneratedImage);
    return this.finish('imageEdit', run, request, params, { images, model: run.model, usage: imageUsage(result, images.length) });
  }

  /**
   * Edit images with streaming partial images.
   *
   * @param request Image edit request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Async generator yielding progress chunks
   * @throws {ProviderError} If editing fails
   */
  editImageStream: Provider['editImageStream'] = async function* (
    this: OpenAIProvider<TConfig>,
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<ImageGenerationChunk> {
    const run = this.prepare('edit image stream', request, ctx, undefined, config, undefined, 'imageEdit');
    const partials = partialImages(request);
    const params: OpenAI.Images.ImageEditParamsStreaming = { ...await this.editParams(request, run), partial_images: partials, stream: true };
    this.augmentImageEditRequest?.(params, request, run.config);

    const events = await this.send('imageEdit', run, request, params, (signal) => run.client.images.edit(params, { signal }));
    yield* this.imageProgress('imageEdit', run, request, params, events, partials);
  }

  // ============================================================================
  // Audio
  // ============================================================================

  /**
   * Transcription parameters shared by the streaming and non-streaming
   * paths. Diarization needs chunking, and known speakers go as data URLs.
   */
  private async transcriptionParams(request: TranscriptionRequest, run: OperationRun<TConfig>) {
    const speakers = request.knownSpeakers;
    return {
      model: run.model.id,
      file: await toFile(request.audio),
      language: request.language,
      prompt: request.prompt,
      temperature: request.temperature,
      response_format: request.responseFormat,
      timestamp_granularities: request.timestampGranularities,
      chunking_strategy: request.responseFormat === 'diarized_json' ? 'auto' as const : undefined,
      known_speaker_names: speakers?.map((speaker) => speaker.name),
      known_speaker_references: speakers && await Promise.all(speakers.map((speaker) => toURL(speaker.audio))),
      ...request.extra,
    };
  }

  /**
   * Transcribe audio to text, with timed and speaker-labeled segments when
   * the response format provides them.
   *
   * @param request Transcription request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Transcription text and segments
   * @throws {ProviderError} If transcription fails
   */
  transcribe: Provider['transcribe'] = async (
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<TranscriptionResponse> => {
    const run = this.prepare('transcribe', request, ctx, undefined, config, undefined, 'transcription');
    const params: OpenAI.Audio.TranscriptionCreateParamsNonStreaming = { ...await this.transcriptionParams(request, run), stream: false };
    this.augmentTranscriptionRequest?.(params, request, run.config);

    // Text, SRT, and VTT formats come back as a bare string
    const result = await this.send<'transcribe', OpenAI.Audio.TranscriptionCreateResponse | string>(
      'transcribe', run, request, params, (signal) => run.client.audio.transcriptions.create(params, { signal })
    );
    return this.finish('transcribe', run, request, params, typeof result === 'string'
      ? { text: result, model: run.model }
      : {
          text: result.text,
          segments: 'segments' in result ? result.segments?.map(toSegment) : undefined,
          model: run.model,
          usage: result.usage && transcriptionUsage(result.usage),
        });
  }

  /**
   * Transcribe audio with streaming text and segments.
   *
   * @param request Transcription request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Async generator yielding transcription chunks
   * @throws {ProviderError} If transcription fails
   */
  transcribeStream: Provider['transcribeStream'] = async function* (
    this: OpenAIProvider<TConfig>,
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<TranscriptionChunk> {
    const run = this.prepare('transcribe stream', request, ctx, undefined, config, undefined, 'transcription');
    const params: OpenAI.Audio.TranscriptionCreateParamsStreaming = { ...await this.transcriptionParams(request, run), stream: true };
    this.augmentTranscriptionRequest?.(params, request, run.config);

    const events = await this.send('transcribe', run, request, params, (signal) => run.client.audio.transcriptions.create(params, { signal }));
    for await (const event of events) {
      if (run.signal?.aborted) {
        throw new Error('Request aborted');
      }
      switch (event.type) {
        case 'transcript.text.delta':
          yield { delta: event.delta };
          break;
        case 'transcript.text.segment':
          yield { segment: toSegment(event) };
          break;
        case 'transcript.text.done':
          yield { text: event.text, usage: event.usage && transcriptionUsage(event.usage), model: run.model };
          break;
      }
    }
  }

  /**
   * Generate speech from text.
   *
   * @param request Speech synthesis request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Audio stream and its format
   * @throws {ProviderError} If speech generation fails
   */
  speech: Provider['speech'] = async (
    request: SpeechRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<SpeechResponse> => {
    const run = this.prepare('speech', request, ctx, undefined, config, undefined, 'speech');
    const params: OpenAI.Audio.SpeechCreateParams = {
      model: run.model.id,
      input: request.text,
      instructions: request.instructions,
      voice: request.voice ?? 'alloy',
      speed: request.speed,
      response_format: request.responseFormat ?? 'opus',
      ...request.extra,
    };
    this.augmentSpeechRequest?.(params, request, run.config);

    const result = await this.send('speech', run, request, params, (signal) => run.client.audio.speech.create(params, { signal }));
    if (!result.body) {
      throw new ProviderError(this.name, 'Speech response had no audio');
    }
    return this.finish('speech', run, request, params, { model: run.model, audio: result.body, responseFormat: params.response_format });
  }

  /**
   * Generate text embeddings for semantic search and similarity.
   *
   * @param request Embedding request parameters
   * @param ctx Context object
   * @param config Optional configuration override
   * @returns Array of embeddings with usage information
   * @throws {ProviderError} If embedding generation fails
   */
  embed: Provider['embed'] = async (
    request: EmbeddingRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<EmbeddingResponse> => {
    const run = this.prepare('embed', request, ctx, undefined, config, undefined, 'embedding');
    const params: OpenAI.EmbeddingCreateParams = {
      model: run.model.id,
      input: request.texts,
      dimensions: request.dimensions,
      encoding_format: request.encodingFormat,
      user: request.userIdentifier,
      ...request.extra,
    };
    this.augmentEmbeddingRequest?.(params, request, run.config);

    const result = await this.send('embed', run, request, params, (signal) => run.client.embeddings.create(params, { signal }));
    return this.finish('embed', run, request, params, {
      embeddings: result.data.map(({ embedding, index }) => ({ embedding, index })),
      model: run.model,
      usage: { embeddings: { count: result.data.length, tokens: result.usage.prompt_tokens } },
    });
  }

  // ============================================================================
  // Image Analysis
  // ============================================================================

  /**
   * An image analysis request as a chat request, and the metadata naming
   * the configured analysis model as the fallback.
   */
  private analysisChat(request: ImageAnalyzeRequest, config?: TConfig): [Request, AIMetadataAny] {
    const chat: Request = {
      model: request.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', content: request.prompt },
          ...request.images.map((image): MessageContent => ({ type: 'image', content: image })),
        ],
      }],
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    };
    const model = config?.defaultModels?.imageAnalyze ?? this.config.defaultModels?.imageAnalyze ?? this.defaults.imageAnalyze;
    return [chat, { model }];
  }

  /**
   * Analyze images with a vision model. Runs as a chat request, reported
   * through the chat hooks.
   */
  analyzeImage: Provider['analyzeImage'] = (request, ctx, config?: TConfig) => {
    const [chat, metadata] = this.analysisChat(request, config);
    return this.createExecutor(config)(chat, ctx, metadata);
  }

  /**
   * Analyze images with a vision model, streaming the answer. Runs as a
   * chat request, reported through the chat hooks.
   */
  analyzeImageStream: Provider['analyzeImageStream'] = (request, ctx, config?: TConfig) => {
    const [chat, metadata] = this.analysisChat(request, config);
    return this.createStreamer(config)(chat, ctx, metadata);
  }
}

/**
 * A generated image as returned by the Images API.
 */
function toGeneratedImage(image: OpenAI.Image): GeneratedImage {
  return { url: image.url, b64_json: image.b64_json, revisedPrompt: image.revised_prompt };
}

/**
 * A transcription segment from a verbose or diarized transcription, or a
 * streamed segment event.
 */
function toSegment(segment: { id: string | number; start: number; end: number; text: string; speaker?: string }): TranscriptionSegment {
  return { id: String(segment.id), start: segment.start, end: segment.end, text: segment.text, speaker: segment.speaker };
}
