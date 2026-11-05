/**
 * Replicate Provider
 *
 * Provider for Replicate API with model adapter support.
 * Replicate has no consistent API - each model has its own input/output schema.
 * Users must register ModelAdapters for each model they want to use.
 */

import type {
  AIContextAny,
  AIMetadataAny,
  Chunk,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageAnalyzeRequest,
  ImageEditRequest,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ModelCapability,
  ModelInfo,
  ModelTier,
  ModelTransformer,
  ModelTransformerResponse,
  Provider,
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
} from '@aeye/ai';
import { BaseChunk, BaseRequest, BaseResponse, deliverSchema, getModel, LENIENT, type Executor, type Request, type Streamer, type Response, getResponseFromChunks } from '@aeye/core';
import Replicate from 'replicate';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Hook called before a request is made to the provider.
 * 
 * @template TRequest - The request type
 * @template TInput - The Replicate input payload type
 * @param request - The request object
 * @param input - The Replicate input payload being sent to the API
 * @param ctx - The context object
 */
export type PreRequestHook<TRequest = any, TInput = any> = (
  request: TRequest,
  input: TInput,
  ctx: AIContextAny
) => void | Promise<void>;

/**
 * Hook called after a response is received from the provider.
 * 
 * @template TRequest - The request type
 * @template TInput - The Replicate input payload type
 * @template TResponse - The response type
 * @param request - The request object
 * @param input - The Replicate input payload that was sent to the API
 * @param response - The response object
 * @param ctx - The context object
 */
export type PostRequestHook<TRequest = any, TInput = any, TResponse = any> = (
  request: TRequest,
  input: TInput,
  response: TResponse,
  ctx: AIContextAny
) => void | Promise<void>;

/**
 * Hook called when an error occurs during a request to the provider.
 * 
 * @param TRequest - The request type
 * @param TInput - The Replicate input payload type
 * @param request - The request object
 * @param input - The Replicate input payload that was sent to the API
 * @param error - The error that occurred
 * @param ctx - The context object
 */
export type ErrorHook<TRequest = any, TInput = any> = (
  request: TRequest,
  input: TInput,
  error: Error,
  ctx: AIContextAny
) => void | Promise<void>;

/**
 * Hooks for a specific operation type.
 */
export interface ReplicateHookObject<TRequest = any, TResponse = any> {
  beforeRequest?: PreRequestHook<TRequest, object>;
  afterRequest?: PostRequestHook<TRequest, object, TResponse>;
  onError?: ErrorHook<TRequest, object>;
}

/**
 * Hooks for different operation types.
 */
export interface ReplicateHooks {
  // Chat completion hooks
  chat?: ReplicateHookObject<Request, Response>;
  // Image generation hooks
  imageGenerate?: ReplicateHookObject<ImageGenerationRequest, ImageGenerationResponse>;
  // Image generation hooks
  imageEdit?: ReplicateHookObject<ImageEditRequest, ImageGenerationResponse>;
  // Image analysis hooks
  imageAnalyze?: ReplicateHookObject<ImageAnalyzeRequest, Response>;
  // Transcription hooks
  transcribe?: ReplicateHookObject<TranscriptionRequest, TranscriptionResponse>;
  // Speech synthesis hooks
  speech?: ReplicateHookObject<SpeechRequest, SpeechResponse>;
  // Embedding hooks
  embed?: ReplicateHookObject<EmbeddingRequest, EmbeddingResponse>;
}

/**
 * Keys of ReplicateHooks
 */
export type ReplicateHookType = keyof ReplicateHooks;

/**
 * A ModelTransformer specialized for Replicate models.
 */
export type ReplicateTransformer = ModelTransformer<any, any, any>;


export interface ReplicateConfig {
  apiKey: string;
  baseUrl?: string;
  /**
   * Model-specific transformers for request/response conversion
   * Map of model ID (owner/name) to transformer
   */
  transformers?: Record<string, ReplicateTransformer>;
  /**
   * Hooks for intercepting requests and responses
   */
  hooks?: ReplicateHooks;
}

// ============================================================================
// Types from Replicate API
// ============================================================================

interface ReplicateModel {
  url: string;
  owner: string;
  name: string;
  description: string | null;
  visibility: string;
  github_url: string | null;
  paper_url: string | null;
  license_url: string | null;
  run_count: number;
  cover_image_url: string | null;
  default_example: {
    model: string;
    version: string;
    input: Record<string, unknown>;
    output: unknown;
  } | null;
  latest_version: {
    id: string;
    created_at: string;
    cog_version: string;
    openapi_schema: {
      info: {
        title: string;
        version: string;
      };
      paths: Record<string, unknown>;
      components: {
        schemas: {
          Input?: {
            type: string;
            properties: Record<string, unknown>;
            required?: string[];
          };
          Output?: {
            type: string;
            properties?: Record<string, unknown>;
            items?: unknown;
          };
        };
      };
    };
  } | null;
}

// ============================================================================
// Helper Functions
// ============================================================================

function createClient(config: ReplicateConfig): Replicate {
  return new Replicate({
    auth: config.apiKey,
    baseUrl: config.baseUrl,
  });
}

/**
 * Convert Replicate model to ModelInfo
 */
function convertModel(model: ReplicateModel): ModelInfo {
  const modelId = `${model.owner}/${model.name}`;

  // Try to detect capabilities from schema
  const capabilities = new Set<ModelCapability>();

  // Check if it's likely an image model based on name/description
  const lowerName = model.name.toLowerCase();
  const lowerDesc = (model.description || '').toLowerCase();

  if (lowerName.includes('stable-diffusion') ||
      lowerName.includes('sdxl') ||
      lowerName.includes('flux') ||
      lowerName.includes('imagen') ||
      lowerDesc.includes('image generation') ||
      lowerDesc.includes('text-to-image')) {
    capabilities.add('image');
  }

  if (lowerName.includes('whisper') ||
      lowerName.includes('transcribe') ||
      lowerDesc.includes('speech-to-text') ||
      lowerDesc.includes('transcription')) {
    capabilities.add('hearing');
  }

  if (lowerName.includes('tts') ||
      lowerName.includes('speech') ||
      lowerDesc.includes('text-to-speech')) {
    capabilities.add('audio');
  }

  if (lowerName.includes('embed') ||
      lowerDesc.includes('embedding')) {
    capabilities.add('embedding');
  }

  if (lowerName.includes('llm') ||
      lowerName.includes('chat') ||
      lowerName.includes('gpt') ||
      lowerName.includes('llama') ||
      lowerDesc.includes('language model')) {
    capabilities.add('chat');
  }

  // Determine tier based on popularity
  let tier: ModelTier = 'experimental';
  if (model.run_count > 1000000) {
    tier = 'flagship';
  } else if (model.run_count > 100000) {
    tier = 'efficient';
  }

  return {
    id: modelId,
    provider: 'replicate',
    name: model.name,
    capabilities,
    pricing: {},
    contextWindow: 0, // Unknown without model-specific info
    maxOutputTokens: undefined,
    tier,
    metadata: {
      owner: model.owner,
      description: model.description,
      runCount: model.run_count,
      githubUrl: model.github_url,
      paperUrl: model.paper_url,
      coverImageUrl: model.cover_image_url,
    },
  };
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class ReplicateProvider implements Provider<ReplicateConfig> {
  readonly name = 'replicate';
  readonly config: ReplicateConfig;

  constructor(config: ReplicateConfig) {
    this.config = config;
  }

  /**
   * List available models from Replicate
   *
   * Note: This only lists models from specific collections.
   * Users can still use any Replicate model by specifying the full owner/name.
   */
  async listModels(config?: ReplicateConfig): Promise<ModelInfo[]> {
    const repConfig = config || this.config;
    const client = createClient(repConfig);

    try {
      // Get featured/popular models from Replicate
      // We'll fetch a few popular collections
      const collections = [
        'text-to-image',
        'image-to-text',
        'text-to-speech',
        'speech-to-text',
      ];

      const allModels: ModelInfo[] = [];

      for (const collection of collections) {
        try {
          // Fetch models from collection
          const modelsIterator = await client.collections.get(collection);

          if (modelsIterator.models) {
            for (const model of modelsIterator.models) {
              try {
                allModels.push(convertModel(model as ReplicateModel));
              } catch (error) {
                console.warn(`Failed to convert Replicate model ${model.name}:`, error);
              }
            }
          }
        } catch (error) {
          console.warn(`Failed to fetch Replicate collection ${collection}:`, error);
        }
      }

      return allModels;
    } catch (error) {
      console.error('Failed to list Replicate models:', error);
      return [];
    }
  }

  /**
   * Check Replicate API health
   */
  async checkHealth(config?: ReplicateConfig): Promise<boolean> {
    try {
      const repConfig = config || this.config;
      const client = createClient(repConfig);

      // Try to fetch account info as a health check
      await client.models.list();
      return true;
    } catch (error) {
      console.error('Replicate health check failed:', error);
      return false;
    }
  }

  /**
   * Get transformer for a specific model
   */
  private getTransformer(modelId: string, config?: ReplicateConfig): ReplicateTransformer | undefined {
    const repConfig = config || this.config;
    return repConfig.transformers?.[modelId] as ReplicateTransformer | undefined;
  }

  /**
   * Does a simple request
   * 
   * @param config 
   * @param request 
   * @param ctx 
   * @param metadata 
   */
  private async doRequest<
    TRequest extends BaseRequest,
    TResponse extends BaseResponse
  >(
    config: ReplicateConfig | undefined,
    request: TRequest, 
    ctx: AIContextAny, 
    metadata: AIMetadataAny | undefined,
    requestSignal: AbortSignal | undefined,
    getConverters: (transformer: ReplicateTransformer) => {
      convertRequest?: (request: TRequest, ctx: AIContextAny) => Promise<object>;
      parseResponse?: (response: object, ctx: AIContextAny) => Promise<ModelTransformerResponse<TResponse>>;
    },
    hookType: ReplicateHookType
  ) {
    const repConfig = config || this.config;

    // Extract model ID from metadata
    const modelInput = request.model || metadata?.model || ctx.metadata?.model;
    if (!modelInput) {
      throw new Error('Replicate executor requires model ID in metadata');
    }

    const model = getModel(modelInput);

    // Get transformer for model
    const transformer = this.getTransformer(model.id, repConfig);
    if (!transformer) {
      throw new Error(
        `Replicate model "${model.id}" requires a ModelTransformer. ` +
        'Add a transformer to your ReplicateConfig.transformers.'
      );
    }

    // Ensure transformer has necessary methods
    const { convertRequest, parseResponse } = getConverters(transformer);
    if (!convertRequest || !parseResponse) {
      throw new Error(
        `Replicate model "${model.id}" requires a ModelTransformer with convertRequest and parseResponse.` +
        `Ensure the transformer for model "${model.id}" has the necessary methods.`
      );
    }

    const signal = requestSignal || ctx.signal;
    const modelId = model.id as `${string}/${string}`;
    const client = createClient(repConfig);
    const hooks = repConfig.hooks?.[hookType] as ReplicateHookObject<TRequest, TResponse> | undefined;

    // Convert request using transformer
    const input = await convertRequest(request, ctx);

    // Call pre-request hook with input payload
    await hooks?.beforeRequest?.(request, input, ctx);

    try {      
      // Run prediction
      const output = await client.run(modelId, { input, signal });

      // Parse response using transformer
      const response = await parseResponse(output, ctx) as TResponse;
      response.model = modelInput;

      // Call post-request hook with input payload
      await hooks?.afterRequest?.(request, input, response, ctx);

      return response;
    } catch (error) {
      // Call error hook
      await hooks?.onError?.(request, input, error as Error, ctx);

      throw error;
    }
  }

  /**
   * Does a simple request
   * 
   * @param config 
   * @param request 
   * @param ctx 
   * @param metadata 
   */
  private async* doStream<
    TRequest extends BaseRequest,
    TChunk extends BaseChunk
  >(
    config: ReplicateConfig | undefined,
    request: TRequest, 
    ctx: AIContextAny, 
    metadata: AIMetadataAny | undefined,
    requestSignal: AbortSignal | undefined,
    getConverters: (transformer: ReplicateTransformer) => {
      convertRequest?: (request: TRequest, ctx: AIContextAny) => Promise<object>;
      parseChunk?: (chunk: object, ctx: AIContextAny) => Promise<TChunk>;
    },
    hookType: ReplicateHookType
  ) {
    const repConfig = config || this.config;

    // Extract model ID from metadata
    const modelInput = request.model || metadata?.model || ctx.metadata?.model;
    if (!modelInput) {
      throw new Error('Replicate executor requires model ID in metadata');
    }
    const model = getModel(modelInput);

    // Get transformer for model
    const transformer = this.getTransformer(model.id, repConfig);
    if (!transformer) {
      throw new Error(
        `Replicate model "${model.id}" requires a ModelTransformer. ` +
        'Add a transformer to your ReplicateConfig.transformers.'
      );
    }

    // Ensure transformer has necessary methods
    const { convertRequest, parseChunk } = getConverters(transformer);
    if (!convertRequest || !parseChunk) {
      throw new Error(
        `Replicate model "${model.id}" requires a ModelTransformer with convertRequest and parseChunk.` +
        `Ensure the transformer for model "${model.id}" has the necessary methods.`
      );
    }

    const signal = requestSignal || ctx.signal;
    const modelId = model.id as `${string}/${string}`;
    const client = createClient(repConfig);
    const hooks = repConfig.hooks?.[hookType] as ReplicateHookObject<TRequest, any> | undefined;

    // Convert request using transformer
    const input = await convertRequest(request, ctx);
    let yieldedModel = false;

    // Call pre-request hook with input payload
    await hooks?.beforeRequest?.(request, input, ctx);

    try {
      // Stream prediction
      for await (const event of client.stream(modelId, { input, signal })) {
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }
        
        // Parse chunk using transformer
        const chunk = await parseChunk(event, ctx);
        if (chunk.usage && !yieldedModel) {
          chunk.model = modelInput;
          yieldedModel = true;
        }
        yield chunk;
      }
      if (!yieldedModel) {
        yield {
          model: modelInput,
        };    
      }
    } catch (error) {
      // Call error hook
      await hooks?.onError?.(request, input, error as Error, ctx);

      throw error;
    }
  }

  /**
   * Create executor for chat/completion
   *
   * Note: Chat requires a model transformer in config for request/response conversion
   */
  createExecutor(config?: ReplicateConfig): Executor<AIContextAny, AIMetadataAny> {
    const repConfig = config || this.config;

    return async (request: Request, ctx, metadata, signal) => {
      // Replicate models take no response format, so a schema goes in the prompt
      return this.doRequest(repConfig, deliverSchema(request, LENIENT, 'prompt'), ctx, metadata, signal, (transformer) => transformer.chat || {}, 'chat');
    };
  }

  /**
   * Create streamer for chat/completion
   */
  createStreamer(config?: ReplicateConfig): Streamer<AIContextAny, AIMetadataAny> {
    const provider = this;

    return async function* (request: Request, ctx: AIContextAny, metadata?: AIMetadataAny, signal?: AbortSignal) {
      const stream = provider.doStream(config, deliverSchema(request, LENIENT, 'prompt'), ctx, metadata, signal, (transformer) => transformer.chat || {}, 'chat');
      const chunks: Chunk[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
        yield chunk;
      }

      const response = getResponseFromChunks(chunks);
      if (request.model) {
        response.model = request.model;
      }
      return response;
    };
  }

  /**
   * Generate image using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async generateImage(
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ): Promise<ImageGenerationResponse> {
    return this.doRequest(config, request, ctx, undefined, ctx.signal, (transformer) => transformer.imageGenerate || {}, 'imageGenerate');
  }

  /**
   * Generate image using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async* generateImageStream(
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ) {
    return this.doStream(config, request, ctx, undefined, ctx.signal, (transformer) => transformer.imageGenerate || {}, 'imageGenerate');
  }

  /**
   * Edit image using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async editImage(
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ): Promise<ImageGenerationResponse> {
    return this.doRequest(config, request, ctx, undefined, ctx.signal, (transformer) => transformer.imageEdit || {}, 'imageEdit');
  }

  /**
   * Edit image using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async* editImageStream(
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ) {
    return this.doStream(config, request, ctx, undefined, ctx.signal, (transformer) => transformer.imageEdit || {}, 'imageEdit');
  }

  /**
   * Analyze image using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async analyzeImage(
    request: ImageAnalyzeRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ): Promise<Response> {
    return this.doRequest(config, request, ctx, undefined, ctx.signal, (transformer) => transformer.imageAnalyze || {}, 'imageAnalyze');
  }

  /**
   * Analyze image using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async* analyzeImageStream(
    request: ImageAnalyzeRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ) {
    return this.doStream(config, request, ctx, undefined, ctx.signal, (transformer) => transformer.imageAnalyze || {}, 'imageAnalyze');
  }

  /**
   * Transcribe audio using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async transcribe(
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ): Promise<TranscriptionResponse> {
    return this.doRequest(config, request, ctx, undefined, undefined, (transformer) => transformer.transcribe || {}, 'transcribe');
  }

  /**
   * Transcribe audio using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async* transcribeStream(
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ) {
    return this.doStream(config, request, ctx, undefined, undefined, (transformer) => transformer.transcribe || {}, 'transcribe');
  }

  /**
   * Generate speech using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async speech(
    request: SpeechRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ): Promise<SpeechResponse> {
    return this.doRequest(config, request, ctx, undefined, undefined, (transformer) => transformer.speech || {}, 'speech');
  }

  /**
   * Generate embeddings using Replicate
   *
   * Requires a ModelTransformer for the specific model being used.
   */
  async embed(
    request: EmbeddingRequest,
    ctx: AIContextAny,
    config?: ReplicateConfig
  ): Promise<EmbeddingResponse> {
    return this.doRequest(config, request, ctx, undefined, undefined, (transformer) => transformer.embed || {}, 'embed');
  }
}
