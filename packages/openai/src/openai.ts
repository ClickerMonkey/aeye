/**
 * OpenAI Provider
 *
 * Provider for OpenAI's GPT models, DALL-E, Whisper, and TTS.
 * Also serves as base class for OpenAI-compatible providers.
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
  TranscriptionResponse
} from '@aeye/ai';
import { detectTier } from '@aeye/ai';
import { toFile, BaseRequest, type Chunk, type Executor, type FinishReason, getModel, getResourceFormat, type MessageContent, ModelInput, type Request, Resource, type Response, type Streamer, toBase64, toJSONSchema, type ToolCall, toStream, toText, toURL, type Usage, getResponseFromChunks } from '@aeye/core';
import fs from 'fs';
import OpenAI from 'openai';
import { Stream } from 'openai/core/streaming';
import { isContextWindowError, parseContextWindowError, type RetryConfig, RetryContext, type RetryEvents, withRetry } from './retry';
import { ContextWindowError, ProviderError } from './types';

// ============================================================================
// OpenAI Provider Configuration
// ============================================================================

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
export type PreRequestHook<TRequest = any, TParams = any> = (
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
export type PostRequestHook<TRequest = any, TParams = any, TResponse = any> = (
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
export type ErrorHook<TRequest = any, TParams = any> = (
  request: TRequest,
  params: TParams,
  error: Error,
  ctx: AIContextAny,
  metadata?: AIMetadataAny
) => void | Promise<void>;

/**
 * Hooks for different operation types.
 */
export interface OpenAIHooks {
  // Chat completion hooks
  chat?: {
    beforeRequest?: PreRequestHook<Request, OpenAI.Chat.ChatCompletionCreateParams>;
    afterRequest?: PostRequestHook<Request, OpenAI.Chat.ChatCompletionCreateParams, Response>;
    onError?: ErrorHook<Request, OpenAI.Chat.ChatCompletionCreateParams>;
  };
  // Image generation hooks
  imageGenerate?: {
    beforeRequest?: PreRequestHook<ImageGenerationRequest, OpenAI.Images.ImageGenerateParams>;
    afterRequest?: PostRequestHook<ImageGenerationRequest, OpenAI.Images.ImageGenerateParams, ImageGenerationResponse>;
    onError?: ErrorHook<ImageGenerationRequest, OpenAI.Images.ImageGenerateParams>;
  };
  // Image edit hooks
  imageEdit?: {
    beforeRequest?: PreRequestHook<ImageEditRequest, OpenAI.Images.ImageEditParams>;
    afterRequest?: PostRequestHook<ImageEditRequest, OpenAI.Images.ImageEditParams, ImageGenerationResponse>;
    onError?: ErrorHook<ImageEditRequest, OpenAI.Images.ImageEditParams>;
  };
  // Image analysis hooks
  imageAnalyze?: {
    beforeRequest?: PreRequestHook<ImageAnalyzeRequest, OpenAI.Chat.ChatCompletionCreateParams>;
    afterRequest?: PostRequestHook<ImageAnalyzeRequest, OpenAI.Chat.ChatCompletionCreateParams, Response>;
    onError?: ErrorHook<ImageAnalyzeRequest, OpenAI.Chat.ChatCompletionCreateParams>;
  };
  // Transcription hooks
  transcribe?: {
    beforeRequest?: PreRequestHook<TranscriptionRequest, OpenAI.Audio.TranscriptionCreateParams>;
    afterRequest?: PostRequestHook<TranscriptionRequest, OpenAI.Audio.TranscriptionCreateParams, TranscriptionResponse>;
    onError?: ErrorHook<TranscriptionRequest, OpenAI.Audio.TranscriptionCreateParams>;
  };
  // Speech synthesis hooks
  speech?: {
    beforeRequest?: PreRequestHook<SpeechRequest, OpenAI.Audio.Speech.SpeechCreateParams>;
    afterRequest?: PostRequestHook<SpeechRequest, OpenAI.Audio.Speech.SpeechCreateParams, SpeechResponse>;
    onError?: ErrorHook<SpeechRequest, OpenAI.Audio.Speech.SpeechCreateParams>;
  };
  // Embedding hooks
  embed?: {
    beforeRequest?: PreRequestHook<EmbeddingRequest, OpenAI.EmbeddingCreateParams>;
    afterRequest?: PostRequestHook<EmbeddingRequest, OpenAI.EmbeddingCreateParams, EmbeddingResponse>;
    onError?: ErrorHook<EmbeddingRequest, OpenAI.EmbeddingCreateParams>;
  };
}

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

// ============================================================================
// OpenAI Provider Class
// ============================================================================

/**
 * OpenAI provider implementation for the @aeye framework.
 *
 * Supports the full range of OpenAI capabilities including:
 * - Chat completions with GPT-4, GPT-4 Turbo, GPT-3.5 Turbo
 * - Vision with GPT-4 Vision (GPT-4V)
 * - Reasoning models (o1, o3-mini)
 * - Image generation with DALL-E 2 and DALL-E 3
 * - Speech-to-text with Whisper
 * - Text-to-speech with TTS
 * - Text embeddings
 * - Function calling and structured outputs
 * - Streaming responses
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
 *   { model: 'gpt-4' }
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
 *   { model: 'gpt-4' }
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
 *
 * Subclasses can optionally override:
 * - `listModels(config)`: Custom model listing logic
 * - `createClient(config)`: Customize client creation
 * - `convertModel(model)`: Customize model conversion
 * - `customizeImageParams(params, config)`: Modify image params
 * - `customizeTranscriptionParams(params, config)`: Modify transcription params
 * - `customizeSpeechParams(params, config)`: Modify speech params
 * - `customizeEmbeddingParams(params, config)`: Modify embedding params
 */

/**
 * Helper function to convert OpenAI-style usage to the new structured Usage format
 */
function convertOpenAIUsage(openaiUsage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}): Usage {
  const usage: Usage = {};

  // Text tokens (default category)
  // Note: prompt_tokens already includes cached tokens, so we don't subtract them
  // They're just reported separately in the details for pricing purposes
  const textInput = (openaiUsage.prompt_tokens || 0) - 
                   (openaiUsage.prompt_tokens_details?.audio_tokens || 0);
  const textOutput = (openaiUsage.completion_tokens || 0) - 
                    (openaiUsage.completion_tokens_details?.reasoning_tokens || 0) -
                    (openaiUsage.completion_tokens_details?.audio_tokens || 0);
  
  if (textInput > 0 || textOutput > 0 || openaiUsage.prompt_tokens_details?.cached_tokens) {
    usage.text = {};
    // Only include non-cached input tokens
    const nonCachedInput = textInput - (openaiUsage.prompt_tokens_details?.cached_tokens || 0);
    if (nonCachedInput > 0) usage.text.input = nonCachedInput;
    if (textOutput > 0) usage.text.output = textOutput;
    if (openaiUsage.prompt_tokens_details?.cached_tokens) {
      usage.text.cached = openaiUsage.prompt_tokens_details.cached_tokens;
    }
  }

  // Reasoning tokens
  if (openaiUsage.completion_tokens_details?.reasoning_tokens) {
    usage.reasoning = {
      output: openaiUsage.completion_tokens_details.reasoning_tokens
    };
  }

  // Audio tokens
  const audioInput = openaiUsage.prompt_tokens_details?.audio_tokens;
  const audioOutput = openaiUsage.completion_tokens_details?.audio_tokens;
  if (audioInput || audioOutput) {
    usage.audio = {};
    if (audioInput) usage.audio.input = audioInput;
    if (audioOutput) usage.audio.output = audioOutput;
  }

  return usage;
}

export class OpenAIProvider<TConfig extends OpenAIConfig = OpenAIConfig> implements Provider<TConfig> {
  // Provider name for error messages and identification
  readonly name: string = 'openai';

  // Config stored in the provider instance (used as fallback)
  readonly config: TConfig;

  // Default metadata to apply to all requests
  defaultMetadata?: Provider['defaultMetadata'];

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
   *
   * @example
   * ```typescript
   * protected createClient(config: OpenAIConfig): OpenAI {
   *   return new OpenAI({
   *     apiKey: config.apiKey,
   *     baseURL: 'https://custom-endpoint.example.com/v1',
   *   });
   * }
   * ```
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
    const tier = detectTier(model.id);

    return {
      provider: this.name,
      id: model.id,
      name: model.id,
      capabilities: new Set(['chat', 'streaming']), // Minimal default, enriched by model sources
      tier,
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
   * @param params Image generation parameters
   * @param config Provider configuration
   * @returns Modified parameters
   */
  protected augmentImageGenerateRequest?<TParams extends OpenAI.ImageGenerateParams>(
    params: TParams, 
    request: ImageGenerationRequest,
    config: TConfig,
  ) {
    // No-op by default
  }

  /**
   * Customize image edit params before sending to API.
   *
   * @param params Image generation parameters
   * @param config Provider configuration
   * @returns Modified parameters
   */
  protected augmentImageEditRequest?<TParams extends OpenAI.ImageEditParams>(
    params: TParams, 
    request: ImageEditRequest,
    config: TConfig,
  ) {
    // No-op by default
  }

  /**
   * Customize transcription params before sending to API.
   *
   * @param params Transcription parameters
   * @param config Provider configuration
   * @returns Modified parameters
   */
  protected augmentTranscriptionRequest?<TParams extends OpenAI.Audio.TranscriptionCreateParams>(
    params: TParams, 
    request: TranscriptionRequest,
    config: TConfig
  ) {
    // No-op by default
  }

  /**
   * Customize speech generation params before sending to API.
   *
   * @param params Speech synthesis parameters
   * @param config Provider configuration
   * @returns Modified parameters
   */
  protected augmentSpeechRequest?<TParams extends OpenAI.Audio.SpeechCreateParams>(
    params: TParams, 
    request: SpeechRequest,
    config: TConfig
  ) {
    // No-op by default
  }

  /**
   * Customize embedding params before sending to API.
   *
   * @param params Embedding parameters
   * @param config Provider configuration
   * @returns Modified parameters
   */
  protected augmentEmbeddingRequest?<TParams extends OpenAI.EmbeddingCreateParams>(
    params: TParams, 
    request: EmbeddingRequest, 
    config: TConfig,
  ) {
    // No-op by default
  }

  /**
   * Customize chat completion params before sending to API.
   *
   * Override this method to modify request parameters for custom providers
   * or to add provider-specific features.
   *
   * @param params OpenAI chat completion parameters
   * @param config Provider configuration
   * @param request Original @aeye request
   * @returns Modified parameters
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
   * 
   * @param chatMessage - OpenAI chat message
   * @param message - Original @aeye message
   * @param config - Provider configuration
   * @returns 
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
   * Get augmented chat content part with provider-specific data.
   * 
   * @param chatContent - OpenAI chat content part
   * @param content - Original @aeye message content
   * @param config - Provider configuration
   * @returns 
   */
  private getChatContent<TContent extends OpenAI.Chat.Completions.ChatCompletionContentPart>(
    chatContent: TContent,
    content: MessageContent,
    config: TConfig,
  ) {
    this.augmentChatContent(chatContent, content, config);
    return chatContent;
  }

  /**
   * Augment chat chunk with provider-specific data.
   * 
   * @param expected 
   * @param chunk 
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
   * @param openai OpenAI chat completion response
   * @param response @aeye response object to augment
   * @returns 
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
   * Convert @aeye MessageContent to OpenAI text content format.
   * @param x 
   * @param name 
   * @returns 
   */
  protected convertContentText(
    x: string | MessageContent[],
    name: string,
    config: TConfig
  ): string | OpenAI.Chat.Completions.ChatCompletionContentPartText[] {
    if (typeof x === 'string') {
      return [{ type: 'text', text: x }];
    }
    if (!Array.isArray(x)) {
      console.warn(`[OpenAIProvider] convertContentText: Unsupported content type from ${name}.`);
      return [];
    }

    return x.map((part): OpenAI.Chat.Completions.ChatCompletionContentPartText => {
      if (part.type === 'text') {
        return this.getChatContent({ type: 'text', text: String(part.content) }, part, config);
      } else if (part.type === 'image') {
        return this.getChatContent({ type: 'text', text: `Image sent by ${name} not included in content.` }, part, config);
      } else if (part.type === 'file') {
        return this.getChatContent({ type: 'text', text: `File sent by ${name} not included in content.` }, part, config);
      } else if (part.type === 'audio') {
        return this.getChatContent({ type: 'text', text: `Audio sent by ${name} not included in content.` }, part, config);
      }
      return this.getChatContent({ type: 'text', text: `Unsupported content type from ${name}.` }, part, config);
    });
  }

  /**
   * Convert @aeye MessageContent to OpenAI format.
   * @param x 
   * @param name 
   * @returns 
   */
  protected async convertContent(
    x: string | MessageContent[],
    name: string,
    config: TConfig
  ): Promise<string | OpenAI.Chat.Completions.ChatCompletionContentPart[]> {
    if (typeof x === 'string') {
      return [{ type: 'text', text: x }];
    }

    return Promise.all(x.map(async (part): Promise<OpenAI.Chat.Completions.ChatCompletionContentPart> => {
      switch (part.type) {
        case 'text': {
          const text = await toText(part.content).catch(() => `Text content sent by ${name} could not be converted to text.`);
          return this.getChatContent({
            type: 'text',
            text,
          }, part, config);
        }

        case 'image': {
          const url = await toURL(part.content, part.format, 'INVALID').catch(() => 'INVALID');
          if (url === 'INVALID') {
            return this.getChatContent({
              type: 'text',
              text: `Image content sent by ${name} could not be converted to a URL.`,
            }, part, config);
          }

          return this.getChatContent({
            type: 'image_url',
            image_url: { url },
          }, part, config);
        }

        case 'audio': {
          // Convert audio content to base64 data
          const base64 = await toBase64(part.content, undefined, 'INVALID').catch(() => 'INVALID');
          if (base64 === 'INVALID') {
            return this.getChatContent({
              type: 'text',
              text: `Audio content sent by ${name} could not be converted to base64.`,
            }, part, config);
          }

          const [, mimeType, data] = /^data:([^;]+);base64,(.+)$/.exec(base64) || [null, '', ''];
          const format = part.format || mimeType && mimeType.includes('wav') ? 'wav' : 'mp3';
          return this.getChatContent({
            type: 'input_audio',
            input_audio: { data, format },
          }, part, config);
        }

        case 'file': {
          // Convert file content to base64 data (file IDs not supported)
          const fileData = await toBase64(part.content, part.format, 'INVALID').catch(() => 'INVALID');
          if (fileData === 'INVALID') {
            return this.getChatContent({
              type: 'text',
              text: `File content sent by ${name} could not be converted to base64.`,
            }, part, config);
          }

          return this.getChatContent({
            type: 'file',
            file: {
              file_data: fileData,
              // TODO add filename
              filename: 'file' + (part.format ? `.${part.format}` : ''),
            },
          }, part, config);
        }

        default:
          return this.getChatContent({
            type: 'text',
            text: `Unsupported content type from ${name}.`,
          }, part, config);
      }
    }));
  }

  /**
   * Convert @aeye ToolCall to OpenAI format.
   * @param x ToolCall object
   * @returns 
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
   * Convert @aeye Request messages to OpenAI format.
   *
   * Handles conversion of all message types (system, user, assistant, tool)
   * and content types (text, image, audio, file).
   *
   * @param request @aeye request object
   * @returns Array of OpenAI-formatted messages
   */
  protected async convertMessages(request: Request, config: TConfig): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
    return (await Promise.all(request.messages.map(async (msg): Promise<OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessageParam[]> => {
      switch (msg.role) {
        case 'system':
          return this.getChatMessage({
            role: 'developer',
            name: this.convertName(msg.name),
            content: this.convertContentText(msg.content, msg.name || 'system', config),
          }, msg, config);
        case 'tool':
          return this.getChatMessage({
            role: 'tool',
            tool_call_id: msg.toolCallId!,
            content: this.convertContentText(msg.content, msg.name || 'tool', config),
          }, msg, config);
        case 'assistant':
          const content = await this.convertContent(msg.content, msg.name || 'assistant', config);
          if (!content || typeof content === 'string' || content.every(c => c.type === 'text')) {
            return this.getChatMessage({
              role: msg.role,
              name: this.convertName(msg.name),
              tool_calls: msg.toolCalls?.map((tc) => this.convertToolCall(tc)),
              content,
            }, msg, config);
          } else {
            // Mixed content - need to split into multiple messages where non-text parts are separate messages
            // sent as user messages because assistent role cannot have non-text content
            const firstText = content.findIndex(c => c.type === 'text');
            return content.map((contentPart, index): OpenAI.Chat.ChatCompletionMessageParam => {
              if (contentPart.type === 'text') {
                return this.getChatMessage({
                  role: 'assistant',
                  name: this.convertName(msg.name),
                  tool_calls: index === firstText ? msg.toolCalls?.map((tc) => this.convertToolCall(tc)) : undefined,
                  content: [contentPart],
                }, msg, config);
              } else {
                return this.getChatMessage({
                  role: 'user',
                  name: this.convertName(msg.name),
                  content: [contentPart],
                }, msg, config);
              }
            });
          }
        case 'user':
          return this.getChatMessage({
            role: msg.role,
            name: this.convertName(msg.name),
            content: await this.convertContent(msg.content, msg.name || 'user', config),
          }, msg, config);
      }
    }))).flat();
  }

  /**
   * Convert @aeye tool definitions to OpenAI format.
   *
   * Transforms Zod schemas into JSON Schema format required by OpenAI.
   *
   * @param request @aeye request object
   * @returns Array of OpenAI-formatted tools or undefined
   */
  protected convertTools(request: Request): OpenAI.Chat.ChatCompletionTool[] | undefined {
    if (!request.tools || request.tools.length === 0) return undefined;
    
    return request.tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: toJSONSchema(tool.parameters, tool.strict ?? true),
        strict: tool.strict ?? true,
      },
    }));
  }

  /**
   * Convert @aeye tool choice to OpenAI format.
   *
   * Supports auto, required, none, and specific tool selection.
   *
   * @param request @aeye request object
   * @returns OpenAI-formatted tool choice option or undefined
   */
  protected convertToolChoice(
    request: Request
  ): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
    if (!request.toolChoice) return undefined;

    if (request.toolChoice === 'auto') return 'auto';
    if (request.toolChoice === 'required') return 'required';
    if (request.toolChoice === 'none') return 'none';
    if (typeof request.toolChoice === 'object') {
      return {
        type: 'function' as const,
        function: { name: request.toolChoice.tool },
      };
    }

    return undefined;
  }

  /**
   * Convert @aeye response format to OpenAI format.
   *
   * Supports text, JSON object mode, and structured output with Zod schemas.
   *
   * @param request @aeye request object
   * @returns OpenAI-formatted response format or undefined
   */
  protected convertResponseFormat(
    request: Request
  ): OpenAI.Chat.ChatCompletionCreateParams['response_format'] | undefined {
    if (!request.responseFormat) return undefined;

    if (typeof request.responseFormat === 'string') {
      if (request.responseFormat === 'text') {
        return { type: 'text' };
      }
      if (request.responseFormat === 'json') {
        return { type: 'json_object' };
      }
      return undefined;
    }

    const strict = request.responseFormat.strict ?? true;

    // Zod schema
    return {
      type: 'json_schema',
      json_schema: {
        name: 'response',
        schema: toJSONSchema(request.responseFormat.type, strict),
        strict,
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
    const effectiveConfig = config || this.config;
    const client = this.createClient(effectiveConfig);

    try {
      const response = await client.models.list();
      const models = response.data;
      return models.map((m) => this.convertModel(m));
    } catch (error) {
      throw new ProviderError(this.name, 'Failed to list models', error as Error);
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
      const effectiveConfig = config || this.config;
      const client = this.createClient(effectiveConfig);
      await client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get request data common to all request types.
   * 
   * @param request - The request
   * @param ctx - The context
   * @param effectiveConfig - The effective configuration
   * @param defaultModel - Optional default model
   * @returns 
   */
  getRequestData<R>(
    request: BaseRequest, 
    requestSignal: AbortSignal | undefined,
    ctx: AIContextAny, 
    effectiveConfig: TConfig, 
    operation: string, 
    defaultModel?: ModelInput
  ) {
    const model = getModel(request.model || ctx.metadata?.model || defaultModel);
    if (!model) {
      throw new ProviderError(this.name, `Model is required for ${this.name} requests`);
    }

    const retryConfig: RetryConfig = { ...effectiveConfig.retry, ...(request.extra?.retry) };
    const retryEvents: RetryEvents = request.extra?.retryEvents || effectiveConfig.retryEvents || {};
    const retryContext: RetryContext = {
      operation,
      model: model.id,
      provider: this.name,
      startTime: Date.now(),
    };

    const signal = requestSignal || ctx.signal;

    const retry = (fn: (signal?: AbortSignal) => Promise<R>): Promise<R> => {
      return withRetry(() => fn(signal), retryContext, retryConfig, retryEvents, signal);
    };

    return { model, retry, signal };
  }

  /**
   * Create an executor for chat completion requests.
   *
   * The executor handles non-streaming chat completions with support for:
   * - Multi-turn conversations
   * - Function calling
   * - Structured outputs
   * - Vision (images)
   * - Audio inputs
   *
   * @param config Optional configuration override
   * @returns Executor function for chat completions
   * @throws {ProviderError} If request fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  createExecutor(config?: TConfig): Executor<AIContextAny, AIMetadataAny> {
    const effectiveConfig = { ...this.config, ...config };
    const client = this.createClient(effectiveConfig);

    return async (request: Request, ctx: AIContextAny, metadata?: AIMetadataAny, requestSignal?: AbortSignal): Promise<Response> => {
      const { model, retry } = this.getRequestData<OpenAI.Chat.Completions.ChatCompletion>(request, requestSignal, ctx, effectiveConfig, 'chat', metadata?.model || effectiveConfig.defaultModels?.chat);

      const messages = await this.convertMessages(request, effectiveConfig);
      const tools = this.convertTools(request);
      const tool_choice = tools?.length ? this.convertToolChoice(request) : undefined;
      const parallel_tool_calls = tools?.length ? !request.toolsOneAtATime : undefined;
      const response_format = this.convertResponseFormat(request);
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model: model.id,
        messages,
        temperature: request.temperature,
        top_p: request.topP,
        max_completion_tokens: request.maxTokens,
        frequency_penalty: request.frequencyPenalty,
        presence_penalty: request.presencePenalty,
        logit_bias: request.logitBias,
        logprobs: request.logProbabilities,
        prompt_cache_key: request.cacheKey,
        safety_identifier: request.userKey,
        store: effectiveConfig.store ?? false,
        stop: request.stop,
        tools,
        tool_choice,
        parallel_tool_calls,
        response_format,
        reasoning_effort: request.reason?.effort,
        ...request.extra,
        stream: false,
      };

      this.augmentChatRequest(params, request, effectiveConfig);

      // Call pre-request hook with params
      await effectiveConfig.hooks?.chat?.beforeRequest?.(request, params, ctx, metadata);

      let completion: OpenAI.Chat.Completions.ChatCompletion;
      try {
        completion = await retry(async (signal) => {
          const data = await client.chat.completions.create(params, { signal });
          const choice = data.choices?.[0];
          if (!choice) {
            throw new ProviderError(this.name, 'No choices in response');
          }

          return data;
        });
      } catch (e: any) {
        if (isContextWindowError(e)) {
          const details = parseContextWindowError(e);
          const errorResponse: Response = {
            content: '',
            toolCalls: [],
            finishReason: 'length' as FinishReason,
            model,
            usage: { text: { input: details?.contextWindow } },
          };
          
          // Call post-request hook even on error
          await effectiveConfig.hooks?.chat?.afterRequest?.(request, params, errorResponse, ctx, metadata);
          
          return errorResponse;
        } else {
          await effectiveConfig.hooks?.chat?.onError?.(request, params, e, ctx, metadata);
        }

        throw e;
      }

      const choice = completion.choices[0];
      
      const toolCalls = choice.message.tool_calls
        ?.filter((tc) => tc.type === 'function')
        .map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }));

      const response: Response = {
        content: choice.message.content || '',
        toolCalls,
        finishReason: choice.finish_reason === 'function_call' /* deprecated */ ? 'stop' : toolCalls?.length ? 'tool_calls' : choice.finish_reason,
        refusal: choice.finish_reason === 'content_filter' ? choice.message.content || undefined : undefined,
        model,
        usage: completion.usage ? convertOpenAIUsage(completion.usage) : undefined,
      };

      this.augmentChatResponse(completion, response, effectiveConfig);

      // Call post-request hook with params
      await effectiveConfig.hooks?.chat?.afterRequest?.(request, params, response, ctx, metadata);

      return response;
    };
  }

  /**
   * Create a streamer for streaming chat completion requests.
   *
   * The streamer yields chunks as they arrive from OpenAI, enabling
   * real-time response rendering.
   *
   * @param config Optional configuration override
   * @returns Streamer async generator function
   * @throws {ProviderError} If request fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  createStreamer(config?: TConfig): Streamer<AIContextAny, AIMetadataAny> {
    const effectiveConfig = { ...this.config, ...config };
    const client = this.createClient(effectiveConfig);

    return async function* (
      this: OpenAIProvider<TConfig>,
      request: Request,
      ctx: AIContextAny,
      metadata?: AIMetadataAny,
      requestSignal?: AbortSignal
    ): AsyncGenerator<Chunk> {
      const { model, retry, signal } = this.getRequestData<Stream<OpenAI.Chat.Completions.ChatCompletionChunk>>(request, requestSignal, ctx, effectiveConfig, 'streaming chat', metadata?.model || effectiveConfig.defaultModels?.chat);

      const messages = await this.convertMessages(request, effectiveConfig);
      const tools = this.convertTools(request);
      const tool_choice = tools?.length ? this.convertToolChoice(request) : undefined;
      const parallel_tool_calls = tools?.length ? !request.toolsOneAtATime : undefined;
      const response_format = this.convertResponseFormat(request);

      const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        model: model.id,
        messages,
        temperature: request.temperature,
        top_p: request.topP,
        max_completion_tokens: request.maxTokens,
        frequency_penalty: request.frequencyPenalty,
        presence_penalty: request.presencePenalty,
        logit_bias: request.logitBias,
        logprobs: request.logProbabilities,
        prompt_cache_key: request.cacheKey,
        safety_identifier: request.userKey,
        store: effectiveConfig.store ?? false,
        stop: request.stop,
        tools,
        tool_choice,
        parallel_tool_calls,
        response_format,
        ...request.extra,
        stream: true,
        stream_options: { include_usage: true },
      };

      this.augmentChatRequest(params, request, effectiveConfig);

      // Call pre-request hook with params
      await effectiveConfig.hooks?.chat?.beforeRequest?.(request, params, ctx, metadata);

      let stream: Stream<OpenAI.Chat.Completions.ChatCompletionChunk>;
      try {
        stream = await retry(async (signal) => {
          const { response, data } = await client.chat.completions.create(params, { signal }).withResponse();

          if (!response.ok) {
            const headers = Object.fromEntries(response.headers);
            const body = await response.text().catch(() => '');
            const details = {
              status: response.status,
              statusText: response.statusText,
              headers,
              body,
            };

            throw new ProviderError(this.name, `Chat completion request failed: ${JSON.stringify(details)}`);
          }

          return data;
        });

      } catch (e: any) {
        if (isContextWindowError(e)) {
          const details = parseContextWindowError(e);
          const errorResponse: Response = {
            content: '',
            toolCalls: [],
            finishReason: 'length' as FinishReason,
            model,
            usage: { text: { input: details?.contextWindow } },
          };
          
          // Call post-request hook even on error
          await effectiveConfig.hooks?.chat?.afterRequest?.(request, params, errorResponse, ctx, metadata);
          
          return errorResponse;
        } else {
          await effectiveConfig.hooks?.chat?.onError?.(request, params, e, ctx, metadata);
        }

        throw e;
      }

      // Track accumulated tool calls and response
      type ToolCallItem = { id: string; name: string; arguments: string, named: boolean, finished: boolean, updated: boolean };
      const toolCallsMap = new Map<number, ToolCallItem>();
      const toolCalls: ToolCallItem[] = [];
      const chunks: Chunk[] = [];
      
      try {
        for await (const chunk of stream) {
          if (signal?.aborted) {
            throw new Error('Request aborted');
          }

          const choice = chunk?.choices[0];
          const delta = choice?.delta;
          
          const yieldChunk: Chunk = {
            content: delta?.content || undefined,
            finishReason: choice?.finish_reason as FinishReason | undefined,
            refusal: delta?.refusal ?? undefined,
            usage: chunk.usage ? convertOpenAIUsage(chunk.usage) : undefined,
          };

          // Handle tool calls
          for (const toolCall of toolCalls) {
            toolCall.updated = false;
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallsMap.get(tc.index);
              const toolCall = existing || { id: '', name: '', arguments: '', named: false, finished: false, updated: true };

              if (tc.id) {
                toolCall.id = tc.id;
                toolCall.updated = true;
              }
              if (tc.function?.name) {
                toolCall.name = tc.function.name;
                toolCall.updated = true;
              }
              if (tc.function?.arguments) {
                toolCall.arguments += tc.function.arguments;
                toolCall.updated = true;
              }
              if (!existing) {
                toolCallsMap.set(tc.index, toolCall);
                toolCalls.push(toolCall);
              }

              if (toolCall.arguments) {
                if (!toolCall.named) {
                  yieldChunk.toolCallNamed = toolCall;
                  toolCall.named = true;
                } else {
                  yieldChunk.toolCallArguments = toolCall;
                }
              }
            }
          }

          for (const toolCall of toolCalls) {
            if (!toolCall.updated && !toolCall.finished) {
              toolCall.finished = true;
              yieldChunk.toolCall = toolCall;
              if (!toolCall.named) {
                yieldChunk.toolCallNamed = toolCall;
                yieldChunk.toolCallArguments = toolCall;
                toolCall.named = true;
              }
            }
          }

          // Augment chunk with provider-specific data
          this.augmentChatChunk(chunk, yieldChunk, effectiveConfig);

          // Keep track of all chunks for post-processing if needed
          chunks.push(yieldChunk);

          // Send it!
          yield yieldChunk;
        }
      } finally {
        // All tool calls should've been emitted, but just in case
        for (const toolCall of toolCalls) {
          if (!toolCall.finished) {
            toolCall.finished = true;

            const chunk: OpenAI.Chat.Completions.ChatCompletionChunk = { choices: [], created: 0, id: '', model: '', object: 'chat.completion.chunk' };
            
            const yieldChunk: Chunk = { toolCall };
            if (!toolCall.named) {
              yieldChunk.toolCallNamed = toolCall;
              yieldChunk.toolCallArguments = toolCall;
              toolCall.named = true;
            }

            // Augment chunk with provider-specific data  
            this.augmentChatChunk(chunk, yieldChunk, effectiveConfig);

            // Keep track of all chunks for post-processing if needed
            chunks.push(yieldChunk);

            // Send it!
            yield yieldChunk;
          }
        }

        // Call post-request hook with accumulated response
        if (effectiveConfig.hooks?.chat?.afterRequest) {
          const finalResponse = getResponseFromChunks(chunks);
          finalResponse.model = model;
          
          await effectiveConfig.hooks.chat.afterRequest(request, params, finalResponse, ctx, metadata);
        }
      }
    }.bind(this);
  }

  /**
   * Get image generation parameters based on model and request.
   * 
   * @param request - Image generation request
   * @param model - Model ID
   * @returns 
   */
  getGenerateParameters(request: ImageGenerationRequest, model: string): OpenAI.Images.ImageGenerateParams {    
    const modelId = model.includes('gpt-image-')
      ? 'gpt-image'
      : model.includes('dall-e-2')
        ? 'dall-e-2'
        : model.includes('dall-e-3')
          ? 'dall-e-3'
          : 'unknown';

    const modelParameters = {
      'gpt-image': {
        style: {
          'vivid': undefined,
          'natural': undefined,
        },
        background: {
          'transparent': 'transparent',
          'opaque': 'opaque',
          'auto': 'auto',
        },
        quality: {
          'low': 'low',
          'medium': 'medium',
          'high': 'high',
        },
        responseFormat: {
          'url': undefined,
          'b64_json': undefined,
        },
        sizes: [
          { width: 1024, height: 1024 },
          { width: 1536, height: 1024 },
          { width: 1024, height: 1536 },
        ] as { width: number; height: number }[],
        n: { min: 1, max: 10 },
      },
      'dall-e-2': {
        style: {
          'vivid': undefined,
          'natural': undefined,
        },
        background: {
          'transparent': undefined,
          'opaque': undefined,
          'auto': undefined,
        },
        quality: {
          'low': 'standard',
          'medium': 'standard',
          'high': 'standard',
        },
        responseFormat: {
          'url': 'url',
          'b64_json': 'b64_json',
        },
        sizes: [
          { width: 256, height: 256 },
          { width: 512, height: 512 },
          { width: 1024, height: 1024 },
        ] as { width: number; height: number }[],
        n: { min: 1, max: 10 },
      },
      'dall-e-3': {
        style: { 
          'vivid': 'vivid',
          'natural': 'natural',
        },
        background: {
          'transparent': undefined,
          'opaque': undefined,
          'auto': undefined,
        },
        quality: {
          'low': 'standard',
          'medium': 'hd',
          'high': 'hd',
        },
        responseFormat: {
          'url': 'url',
          'b64_json': 'b64_json',
        },
        sizes: [
          { width: 1024, height: 1024 },
          { width: 1792, height: 1024 },
          { width: 1024, height: 1792 },
        ] as { width: number; height: number }[],
        n: { min: 1, max: 1 },
      },
      'unknown': {
        style: {
          'vivid': undefined,
          'natural': undefined,
        },
        background: {
          'transparent': undefined,
          'opaque': undefined,
          'auto': undefined,
        },
        quality: {
          'low': undefined,
          'medium': undefined,
          'high': undefined,
        },
        responseFormat: {
          'url': undefined,
          'b64_json': undefined,
        },
        sizes: [] as { width: number; height: number }[],
        n: { min: 1, max: 1 },
      },
    } as const;

    const sizesAvailable = modelParameters[modelId].sizes;
    let size: OpenAI.Images.ImageGenerateParams['size'] = undefined;
    if (request.size && sizesAvailable.length > 0) {
      const [widthStr, heightStr] = request.size.split('x');
      const width = parseInt(widthStr, 10);
      const height = parseInt(heightStr, 10);
      const closest = sizesAvailable
        .map(d => ({
          ...d,
          ratioDiff: Math.abs(d.width / d.height - width / height),
          scale: Math.min(d.width / width, d.height / height)
        }))
        .sort((a, b) => a.ratioDiff - b.ratioDiff || b.scale - a.scale)[0];

      size = `${closest.width}x${closest.height}` as OpenAI.Images.ImageGenerateParams['size'];
    }

    const params: OpenAI.Images.ImageGenerateParams = {
      model,
      prompt: request.prompt,
      n: request.n ? Math.max(modelParameters[modelId].n.min, Math.min(modelParameters[modelId].n.max, request.n)) : undefined,
      size,
      quality: request.quality ? modelParameters[modelId].quality[request.quality] : undefined,
      style: request.style ? modelParameters[modelId].style[request.style] : undefined,
      background: request.background ? modelParameters[modelId].background[request.background] : undefined,
      response_format: request.responseFormat ? modelParameters[modelId].responseFormat[request.responseFormat] : undefined,
    };

    return params;
  }
    
  /**
   * Generate images.
   *
   * @param request Image generation request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Generated image URLs or base64 data
   * @throws {ProviderError} If generation fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  generateImage: Provider['generateImage'] = async (
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<ImageGenerationResponse> => {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry } = this.getRequestData<OpenAI.Images.ImagesResponse>(request, undefined, ctx, effectiveConfig, 'generate image', effectiveConfig.defaultModels?.imageGenerate || 'gpt-image-1');
    
    const baseParams = this.getGenerateParameters(request, model.id);
    const params: OpenAI.Images.ImageGenerateParamsNonStreaming = {
      ...baseParams,
      user: request.userIdentifier,
      ...request.extra,
      stream: false,
    };

    // Apply provider-specific customizations
    this.augmentImageGenerateRequest?.(params, request, effectiveConfig);

    // Call pre-request hook with params
    await effectiveConfig.hooks?.imageGenerate?.beforeRequest?.(request, params, ctx);
    
    const client = this.createClient(effectiveConfig);

    let response: OpenAI.Images.ImagesResponse;
    try {
      response = await retry(async (signal) => {
        return await client.images.generate(params, { signal });
      });

    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during image generation', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.imageGenerate?.onError?.(request, params, e, ctx);
      }
      throw e;
    }
  
    const result = {
      images: (response.data || []).map((img) => ({
        url: img.url || undefined,
        b64_json: img.b64_json || undefined,
        revisedPrompt: img.revised_prompt || undefined,
      })),
      model,
      usage: response.usage ? convertOpenAIUsage(response.usage) : undefined,
    };

    // Call post-request hook with params
    await effectiveConfig.hooks?.imageGenerate?.afterRequest?.(request, params, result, ctx);

    return result;
  }
  
  /**
   * Generate images with streaming progress updates.
   *
   * Note: OpenAI's API doesn't natively support streaming image generation,
   * so this implementation polls for progress or returns the result immediately.
   *
   * @param request Image generation request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Async generator yielding progress chunks
   * @throws {ProviderError} If generation fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  generateImageStream: Provider['generateImageStream'] = async function* (
    this: OpenAIProvider<TConfig>,
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<ImageGenerationChunk> {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry, signal } = this.getRequestData<Stream<OpenAI.Images.ImageGenStreamEvent>>(request, undefined, ctx, effectiveConfig, 'generate image stream', effectiveConfig.defaultModels?.imageGenerate || 'gpt-image-1');
    const baseParams = this.getGenerateParameters(request, model.id);

    const imageStreams = Math.max(1, Math.min(3, request.streamCount ?? 2));

    const params: OpenAI.Images.ImageGenerateParamsStreaming = {
      ...baseParams,
      user: request.userIdentifier,
      partial_images: imageStreams,
      ...request.extra,
      stream: true,
    };

    this.augmentImageGenerateRequest?.(params, request, effectiveConfig);
    
    const client = this.createClient(effectiveConfig);

    let response: Stream<OpenAI.Images.ImageGenStreamEvent>;
    try {
      response = await retry(async (signal) => {
        return await client.images.generate(params, { signal });
      });

    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during image generation', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.imageGenerate?.onError?.(request, params, e, ctx);
      }
      throw e;
    }

    // Yield completion with results
    let imageCount = 0;
    for await (const img of response) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const progress = (imageCount + 1) / (imageStreams + 1);
      yield {
        progress,
        done: img.type === 'image_generation.completed',
        image: {
          b64_json: img.b64_json || undefined,
        },
      };

      imageCount++;
    }
  }

  
  /**
   * Get image generation parameters based on model and request.
   * 
   * @param request - Image generation request
   * @param model - Model ID
   * @returns 
   */
  getEditParameters(request: ImageEditRequest, model: string): Omit<OpenAI.Images.ImageEditParams, 'image'> {
    const modelId = model.includes('gpt-image-')
      ? 'gpt-image'
      : model.includes('dall-e-2')
        ? 'dall-e-2'
        : model.includes('dall-e-3')
          ? 'dall-e-3'
          : 'unknown';

    const modelParameters = {
      'gpt-image': {
        responseFormat: {
          'url': undefined,
          'b64_json': undefined,
        },
        sizes: [
          { width: 1024, height: 1024 },
          { width: 1536, height: 1024 },
          { width: 1024, height: 1536 },
        ] as { width: number; height: number }[],
        n: { min: 1, max: 10 },
      },
      'dall-e-2': {
        responseFormat: {
          'url': 'url',
          'b64_json': 'b64_json',
        },
        sizes: [
          { width: 256, height: 256 },
          { width: 512, height: 512 },
          { width: 1024, height: 1024 },
        ] as { width: number; height: number }[],
        n: { min: 1, max: 10 },
      },
      'dall-e-3': {
        responseFormat: {
          'url': 'url',
          'b64_json': 'b64_json',
        },
        sizes: [
          { width: 1024, height: 1024 },
          { width: 1792, height: 1024 },
          { width: 1024, height: 1792 },
        ] as { width: number; height: number }[],
        n: { min: 1, max: 1 },
      },
      'unknown': {
        responseFormat: {
          'url': undefined,
          'b64_json': undefined,
        },
        sizes: [] as { width: number; height: number }[],
        n: { min: 1, max: 1 },
      },
    } as const;

    const sizesAvailable = modelParameters[modelId].sizes;
    let size: OpenAI.Images.ImageEditParams['size'] = undefined;
    if (request.size && sizesAvailable.length > 0) {
      const [widthStr, heightStr] = request.size.split('x');
      const width = parseInt(widthStr, 10);
      const height = parseInt(heightStr, 10);
      const closest = sizesAvailable
        .map(d => ({
          ...d,
          ratioDiff: Math.abs(d.width / d.height - width / height),
          scale: Math.min(d.width / width, d.height / height)
        }))
        .sort((a, b) => a.ratioDiff - b.ratioDiff || b.scale - a.scale)[0];

      size = `${closest.width}x${closest.height}` as OpenAI.Images.ImageEditParams['size'];
    }

    const params: Omit<OpenAI.Images.ImageEditParams, 'image'> = {
      model,
      prompt: request.prompt,
      n: request.n ? Math.max(modelParameters[modelId].n.min, Math.min(modelParameters[modelId].n.max, request.n)) : undefined,
      size,
      response_format: request.responseFormat ? modelParameters[modelId].responseFormat[request.responseFormat] : undefined,
    };

    return params;
  }

  /**
   * Edit images using DALL-E models.
   *
   * Supports image editing with text prompts and optional masks.
   *
   * @param request Image edit request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Edited image URLs or base64 data
   * @throws {ProviderError} If editing fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  editImage: Provider['editImage'] = async (
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<ImageGenerationResponse> => {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry } = this.getRequestData<OpenAI.Images.ImagesResponse>(request, undefined, ctx, effectiveConfig, 'edit image', effectiveConfig.defaultModels?.imageEdit || 'gpt-image-1');
    
    const image = await toFile(request.image);
    const mask = request.mask ? await toFile(request.mask) : undefined;
    const baseParams = this.getEditParameters(request, model.id);
    
    const params: OpenAI.Images.ImageEditParamsNonStreaming = {
      ...baseParams,
      image,
      mask,
      user: request.userIdentifier,
      ...request.extra,
      stream: false,
    };

    // Apply provider-specific customizations
    this.augmentImageGenerateRequest?.(params, request, effectiveConfig);

    // Call pre-request hook with params
    await effectiveConfig.hooks?.imageEdit?.beforeRequest?.(request, params, ctx);

    const client = this.createClient(effectiveConfig);

    let response: OpenAI.Images.ImagesResponse;
    try {
      response = await retry(async (signal) => {
        return await client.images.edit(params, { signal });
      });

    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during image editing', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.imageEdit?.onError?.(request, params, e, ctx);
      }
      throw e;
    }

    const result = {
      images: (response.data || []).map((img) => ({
        url: img.url || undefined,
        b64_json: img.b64_json || undefined,
        revisedPrompt: img.revised_prompt || undefined,
      })),
      model,
      usage: response.usage ? convertOpenAIUsage(response.usage) : undefined,
    };

    // Call post-request hook with params
    await effectiveConfig.hooks?.imageEdit?.afterRequest?.(request, params, result, ctx);

    return result;
  }

  /**
   * Edit images with streaming progress updates.
   *
   * Note: OpenAI's API doesn't natively support streaming image editing,
   * so this implementation returns the result with progress indicators.
   *
   * @param request Image edit request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Async generator yielding progress chunks
   * @throws {ProviderError} If editing fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  editImageStream: Provider['editImageStream'] = async function* (
    this: OpenAIProvider<TConfig>,
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<ImageGenerationChunk> {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry, signal } = this.getRequestData<Stream<OpenAI.ImageEditStreamEvent>>(request, undefined, ctx, effectiveConfig, 'edit image stream', effectiveConfig.defaultModels?.imageEdit || 'gpt-image-1');
    
    const image = await toFile(request.image);
    const mask = request.mask ? await toFile(request.mask) : undefined;
    const imageStreams = Math.max(1, Math.min(3, request.streamCount ?? 2));
    const baseParams = this.getEditParameters(request, model.id);

    const params: OpenAI.Images.ImageEditParamsStreaming = {
      ...baseParams,
      image,
      mask,
      user: request.userIdentifier,
      partial_images: imageStreams,
      ...request.extra,
      stream: true,
    };

    this.augmentImageEditRequest?.(params, request, effectiveConfig);

    const client = this.createClient(effectiveConfig);

    let response: Stream<OpenAI.Images.ImageEditStreamEvent>;
    try {
      response = await retry(async (signal) => {
        return await client.images.edit(params, { signal });
      });

    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during image editing', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.imageEdit?.onError?.(request, params, e, ctx);
      }
      throw e;
    }

    // Yield completion with results
    let imageCount = 0;
    for await (const img of response) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const progress = (imageCount + 1) / (imageStreams + 1);

      yield {
        progress,
        done: img.type === 'image_edit.completed',
        image: {
          b64_json: img.b64_json || undefined,
        },
        model,
      };
      imageCount++;
    }
  }

  /**
   * Transcribe audio to text using Whisper models.
   *
   * Supports multiple audio formats and optional timestamps.
   *
   * @param request Transcription request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Transcription text and optional metadata
   * @throws {ProviderError} If transcription fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  transcribe: Provider['transcribe'] = async (
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<TranscriptionResponse> => {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry, signal } = this.getRequestData<OpenAI.Audio.Transcriptions.Transcription>(request, undefined, ctx, effectiveConfig, 'transcribe', effectiveConfig.defaultModels?.transcription || 'whisper-1');
    
    const file = await toFile(request.audio);
    const params: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsNonStreaming = {
      model: model.id,
      file,
      language: request.language,
      prompt: request.prompt,
      temperature: request.temperature,
      response_format: request.responseFormat as 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json' | undefined,
      timestamp_granularities: request.timestampGranularities as ('word' | 'segment')[] | undefined,
      ...request.extra,
      stream: false,
    };

    // Apply provider-specific customizations
    this.augmentTranscriptionRequest?.(params, request, effectiveConfig);

    // Call pre-request hook with params
    await effectiveConfig.hooks?.transcribe?.beforeRequest?.(request, params, ctx);
    
    const client = this.createClient(effectiveConfig);

    let response: OpenAI.Audio.Transcriptions.Transcription;
    try {
      response = await retry(async (signal) => {
        return await client.audio.transcriptions.create(params, { signal });
      });

    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during image editing', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.transcribe?.onError?.(request, params, e, ctx);
      }
      throw e;
    }

    const result = {
      text: response.text,
      model,
      usage: response.usage?.type === 'tokens' ? convertOpenAIUsage(response.usage) : 
             response.usage?.seconds ? { audio: { seconds: response.usage.seconds } } : undefined,
    };

    // Call post-request hook with params
    await effectiveConfig.hooks?.transcribe?.afterRequest?.(request, params, result, ctx);

    return result;
  }

  /**
   * Transcribe audio with streaming progress updates.
   *
   * Note: OpenAI's API doesn't natively support streaming transcription,
   * so this implementation returns the result with progress indicators.
   *
   * @param request Transcription request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Async generator yielding transcription chunks
   * @throws {ProviderError} If transcription fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  transcribeStream: Provider['transcribeStream'] = async function* (
    this: OpenAIProvider<TConfig>,
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<TranscriptionChunk> {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry, signal } = this.getRequestData<Stream<OpenAI.Audio.Transcriptions.TranscriptionStreamEvent>>(request, undefined, ctx, effectiveConfig, 'transcribe stream', effectiveConfig.defaultModels?.transcription || 'whisper-1');
    
    const file = await toFile(request.audio);
    const params: OpenAI.Audio.Transcriptions.TranscriptionCreateParamsStreaming = {
      model: model.id,
      file,
      language: request.language,
      prompt: request.prompt,
      temperature: request.temperature,
      response_format: request.responseFormat as 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json' | undefined,
      timestamp_granularities: request.timestampGranularities as ('word' | 'segment')[] | undefined,
      ...request.extra,
      stream: true,
    };

    this.augmentTranscriptionRequest?.(params, request, effectiveConfig);

    await effectiveConfig.hooks?.transcribe?.beforeRequest?.(request, params, ctx);

    const client = this.createClient(effectiveConfig);

    let response: Stream<OpenAI.Audio.Transcriptions.TranscriptionStreamEvent>;
    try {
      response = await retry(async (signal) => {
        return await client.audio.transcriptions.create(params, { signal });
      });

    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during transcription', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.transcribe?.onError?.(request, params, e, ctx);
      }
      throw e;
    }

    for await (const chunk of response) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      switch (chunk.type) {
        case 'transcript.text.delta':
          yield {
            delta: chunk.delta,
          };
          break
        case 'transcript.text.segment':
          yield {
            segment: {
              start: chunk.start,
              end: chunk.end,
              speaker: chunk.speaker,
              text: chunk.text,
              id: chunk.id,
            },
          };
          break;
        case 'transcript.text.done':
          yield {
            text: chunk.text,
            usage: chunk.usage ? convertOpenAIUsage(chunk.usage) : undefined,
            model,
          };
          break;
      }
    }
  }

  /**
   * Generate speech from text using TTS models.
   *
   * Supports multiple voices and audio formats.
   *
   * @param request Speech synthesis request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Audio buffer and content type
   * @throws {ProviderError} If speech generation fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  speech: Provider['speech'] = async (
    request: SpeechRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<SpeechResponse> => {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry, signal } = this.getRequestData<globalThis.Response>(request, undefined, ctx, effectiveConfig, 'speech', effectiveConfig.defaultModels?.speech || 'tts-1');
    
    const { text: input, instructions, speed } = request;
    const voiceDefault = 'alloy' as const;
    const voiceValid = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'] as const;
    const voiceRequest = request.voice || voiceDefault;
    const voice = (voiceValid as readonly string[]).includes(voiceRequest) ? voiceRequest : voiceDefault;
    const responseFormat = request.responseFormat || 'opus';

    const params: OpenAI.Audio.Speech.SpeechCreateParams = {
      model: model.id,
      input,
      instructions,
      voice,
      speed,
      response_format: responseFormat,
      ...request.extra,
    };

    // Apply provider-specific customizations
    this.augmentSpeechRequest?.(params, request, effectiveConfig);

    // Call pre-request hook with params
    await effectiveConfig.hooks?.speech?.beforeRequest?.(request, params, ctx);

    const client = this.createClient(effectiveConfig);

    let response: globalThis.Response;
    try {
      response = await retry(async (signal) => {
        return await client.audio.speech.create(params, { signal });
      });
    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during speech generation', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.speech?.onError?.(request, params, e, ctx);
      }
      throw e;
    }

    const result = {
      model,
      audio: response.body as ReadableStream<any>,
      responseFormat,
    };

    // Call post-request hook with params
    await effectiveConfig.hooks?.speech?.afterRequest?.(request, params, result, ctx);

    return result;
  }

  /**
   * Generate text embeddings for semantic search and similarity.
   *
   * Supports text-embedding-3-small, text-embedding-3-large, and ada-002 models.
   *
   * @param request Embedding request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Array of embeddings with usage information
   * @throws {ProviderError} If embedding generation fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  embed: Provider['embed'] = async (
    request: EmbeddingRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<EmbeddingResponse> => {
    const effectiveConfig = { ...this.config, ...config };

    const { model, retry } = this.getRequestData<OpenAI.CreateEmbeddingResponse>(request, undefined, ctx, effectiveConfig, 'embed', effectiveConfig.defaultModels?.embedding || 'text-embedding-3-small');
    
    const params: OpenAI.EmbeddingCreateParams = {
      model: model.id,
      input: request.texts,
      dimensions: request.dimensions,
      encoding_format: request.encodingFormat,
      user: request.userIdentifier,
      ...request.extra,
    };

    // Apply provider-specific customizations
    this.augmentEmbeddingRequest?.(params, request, effectiveConfig);

    // Call pre-request hook with params
    await effectiveConfig.hooks?.embed?.beforeRequest?.(request, params, ctx);

    const client = this.createClient(effectiveConfig);

    let response: OpenAI.CreateEmbeddingResponse;
    try {
      response = await retry(async (signal) => {
        return await client.embeddings.create(params, { signal });
      });

    } catch (e: any) {
      if (isContextWindowError(e)) {
        const details = parseContextWindowError(e);
        throw new ContextWindowError(this.name, 'Context window exceeded during embedding generation', details?.contextWindow, e);
      } else {
        await effectiveConfig.hooks?.embed?.onError?.(request, params, e, ctx);
      }
      throw e;
    }

    const result = {
      embeddings: response.data.map((item) => ({
        embedding: item.embedding,
        index: item.index,
      })),
      model,
      usage: response.usage
        ? {
            embeddings: {
              count: response.data.length,
              tokens: response.usage.prompt_tokens
            }
          }
        : undefined,
    };

    // Call post-request hook with params
    await effectiveConfig.hooks?.embed?.afterRequest?.(request, params, result, ctx);

    return result;
  }

  /**
   * Analyze images using vision-capable models.
   *
   * This method converts the image analysis request into a chat request
   * with image content and calls the chat API internally.
   *
   * @param request Image analysis request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Analysis response with text content
   * @throws {ProviderError} If analysis fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  analyzeImage: Provider['analyzeImage'] = async (
    request: ImageAnalyzeRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<Response> => {
    const effectiveConfig = { ...this.config, ...config };

    // Convert ImageAnalyzeRequest to chat Request
    const chatRequest: Request = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', content: request.prompt },
            ...request.images.map((image): MessageContent => ({
              type: 'image',
              content: image,
            })),
          ],
        },
      ],
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    };

    // Construct the params that would be sent to OpenAI
    const { model } = this.getRequestData<OpenAI.Chat.Completions.ChatCompletion>(chatRequest, undefined, ctx, effectiveConfig, 'analyze image', effectiveConfig.defaultModels?.imageAnalyze || 'gpt-4-vision-preview');
    const messages = await this.convertMessages(chatRequest, effectiveConfig);
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: model.id,
      messages,
      temperature: chatRequest.temperature,
      max_completion_tokens: chatRequest.maxTokens,
    };

    // Call pre-request hook with params
    await effectiveConfig.hooks?.imageAnalyze?.beforeRequest?.(request, params, ctx);

    const executor = this.createExecutor(effectiveConfig);
    let response: Response;

    try {
      // Use the chat executor to analyze the images (this will also call chat hooks)
      response = await executor(
        chatRequest,
        ctx,
        {},
        undefined
      );

      // Call post-request hook with params
      await effectiveConfig.hooks?.imageAnalyze?.afterRequest?.(request, params, response, ctx);
    } catch (e: any) {
      await effectiveConfig.hooks?.imageAnalyze?.onError?.(request, params, e, ctx);

      throw e;
    }
    
    return response;
  }

  /**
   * Analyze images with streaming response.
   *
   * This method converts the image analysis request into a chat request
   * with image content and calls the streaming chat API internally.
   *
   * @param request Image analysis request parameters
   * @param ctx Context object (not used)
   * @param config Optional configuration override
   * @returns Async generator yielding response chunks
   * @throws {ProviderError} If analysis fails
   * @throws {RateLimitError} If rate limit is exceeded
   */
  analyzeImageStream: Provider['analyzeImageStream'] = async function* (
    this: OpenAIProvider<TConfig>,
    request: ImageAnalyzeRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<Chunk> {
    const effectiveConfig = { ...this.config, ...config };

    // Convert ImageAnalyzeRequest to chat Request
    const chatRequest: Request = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', content: request.prompt },
            ...request.images.map((image): MessageContent => ({
              type: 'image',
              content: image,
            })),
          ],
        },
      ],
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    };

    // Construct the params that would be sent to OpenAI
    const { model } = this.getRequestData<OpenAI.Chat.Completions.ChatCompletion>(chatRequest, undefined, ctx, effectiveConfig, 'analyze image stream', effectiveConfig.defaultModels?.imageAnalyze || 'gpt-4-vision-preview');
    const messages = await this.convertMessages(chatRequest, effectiveConfig);
    const params: OpenAI.Chat.ChatCompletionCreateParams = {
      model: model.id,
      messages,
      temperature: chatRequest.temperature,
      max_completion_tokens: chatRequest.maxTokens,
      stream: true,
    };

    // Call pre-request hook with params
    await effectiveConfig.hooks?.imageAnalyze?.beforeRequest?.(request, params, ctx);

    const streamer = this.createStreamer(effectiveConfig);

    try {
      // Use the chat streamer to analyze the images (this will also call chat hooks)
      const stream = streamer(
        chatRequest,
        ctx,
        { model: request.model } as any,
        undefined
      );
      // Track accumulated response for post-hook
      let accumulatedContent = '';
      let finalUsage: any = undefined;
      let finishReason: any = undefined;
      const toolCalls: any[] = [];

      try {
        for await (const chunk of stream) {
          if (chunk.content) {
            accumulatedContent += chunk.content;
          }
          if (chunk.usage) {
            finalUsage = chunk.usage;
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
          if (chunk.toolCall) {
            toolCalls.push(chunk.toolCall);
          }
          yield chunk;
        }
      } finally {
        // Call post-request hook with params
        const finalResponse: Response = {
          content: accumulatedContent,
          toolCalls,
          finishReason: toolCalls.length ? 'tool_calls' : finishReason || 'stop' as FinishReason,
          model,
          usage: finalUsage,
        };

        await effectiveConfig.hooks?.imageAnalyze?.afterRequest?.(request, params, finalResponse, ctx);
      }
    } catch (e: any) {
      await effectiveConfig.hooks?.imageAnalyze?.onError?.(request, params, e, ctx);

      throw e;
    }
  }
}
