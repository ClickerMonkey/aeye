/**
 * AI Library Types (Instance-Based API)
 *
 * Type definitions for the class-based AI library.
 * Reuses core types from @server/ai/core for consistency.
 */

import type {
  AgentInput,
  AnyComponent,
  BaseChunk,
  BaseRequest,
  BaseResponse,
  Chunk,
  Component,
  ComponentCompatible,
  ComponentInput,
  ComponentOutput,
  Context as CoreContext,
  Executor,
  Message,
  Model,
  ModelInput,
  OptionalParams,
  PromptInput,
  Request,
  Resource,
  Response,
  Simplify,
  Streamer,
  ToolInput,
  Usage,
} from '@aeye/core';
import { AI } from './ai';

// ============================================================================
// Re-export Core Types
// ============================================================================

export type {
  AgentInput, AnyComponent, Chunk, Component, ComponentInput,
  ComponentOutput, CoreContext, Executor, Message, OptionalParams, PromptInput, Request,
  Response, Streamer, ToolInput, Usage
};

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * Strict partial type - explicitly marks that a type should have partial properties.
 * Used throughout the library to indicate when context/metadata can be partially provided.
 */
export type StrictPartial<T> = Partial<T>;

/**
 * Relaxes required properties of T that are present in U, making them optional.
 * This is used to compute which context/metadata fields must be provided by the caller,
 * after accounting for fields satisfied by default or provided context.
 *
 * @template T - The full type with required properties
 * @template U - The partial type with properties that can be omitted
 */
export type Relax<T, U extends Partial<T>> = Omit<T, keyof U> & Partial<Pick<T, keyof U & keyof T>>;


// ============================================================================
// Provider Types
// ============================================================================

/**
 * Collection of AI providers mapped by name.
 * Each provider implements the Provider interface and can have its own configuration.
 */
export type Providers = Record<string, Provider<any>>;

// ============================================================================
// Model Capabilities & Tiers
// ============================================================================

/**
 * Capabilities that AI models can support.
 * Used for model selection to ensure the chosen model supports required features.
 *
 * - chat: Basic text completion
 * - tools: Function/tool calling
 * - vision: Image understanding
 * - json: JSON output mode
 * - structured: Structured output with schemas
 * - streaming: Streaming responses
 * - reasoning: Extended reasoning (like OpenAI o1)
 * - image: Image generation
 * - audio: Text-to-speech
 * - hearing: Speech-to-text
 * - embedding: Text embeddings
 * - zdr: Zero data retention
 */
export type ModelCapability =
  | 'chat'
  | 'tools'
  | 'vision'
  | 'json'
  | 'structured'
  | 'streaming'
  | 'reasoning'
  | 'image'
  | 'audio'
  | 'hearing'
  | 'embedding'
  | 'zdr';

/**
 * Model performance and quality tiers.
 * Used for categorizing models by their capabilities and cost.
 *
 * - flagship: Top-tier models with best performance
 * - efficient: Smaller, faster, more cost-effective models
 * - legacy: Older models, may be deprecated
 * - experimental: Preview/beta models
 */
export type ModelTier =
  | 'flagship'
  | 'efficient'
  | 'legacy'
  | 'experimental';

// ============================================================================
// Model Information
// ============================================================================

/**
 * Pricing information for a model.
 * All costs are specified per 1 million tokens unless otherwise noted.
 */
export interface ModelPricing {
  text?: {
    input?: number;
    output?: number;
    cached?: number;
  };
  audio?: {
    input?: number;
    output?: number;
    perSecond?: number; // estimate
  };
  image?: {
    input?: number;
    output?: {
      quality: string; // e.g., low, medium, high
      sizes: {
        width: number;
        height: number;
        cost: number;
      }[]
    }[];
  };
  reasoning?: {
    input?: number;
    output?: number;
    cached?: number;
  };
  embeddings?: {
    cost?: number;
  };
  // Fixed cost per request
  perRequest?: number;
}

/**
 * Performance and usage metrics for a model.
 * Tracked over time to inform model selection decisions.
 */
export interface ModelMetrics {
  // Generation speed in tokens per second
  tokensPerSecond?: number;
  // Latency to first token in milliseconds
  timeToFirstToken?: number;
  // Average total request duration in milliseconds
  averageRequestDuration?: number;
  // Quality score (0-1)
  accuracyScore?: number;
  // Total number of requests made
  requestCount?: number;
  // Number of successful requests
  successCount?: number;
  // Number of failed requests
  failureCount?: number;
  // When metrics were last updated
  lastUpdated?: Date;
}

/**
 * Complete information about an AI model.
 * Contains capabilities, pricing, performance metrics, and metadata.
 *
 * @template TProvider - Provider name type (string union)
 */
export interface ModelInfo<TProvider extends string = string> extends Model {
  // Model identifier (e.g., "gpt-4", "claude-3-opus")
  id: string;
  // Provider name (e.g., "openai", "anthropic")
  provider: TProvider;
  // Human-readable model name
  name: string;
  // Set of capabilities this model supports
  capabilities: Set<ModelCapability>;
  // Performance/quality tier
  tier: ModelTier;
  // Pricing information
  pricing: ModelPricing;
  // Maximum context window size in tokens
  contextWindow: number;
  // Maximum output tokens (if different from context window)
  maxOutputTokens?: number;
  // Performance metrics
  metrics?: ModelMetrics;
  // The tokenizer used by the model
  tokenizer?: ModelTokenizer;
  // The supported parameters
  supportedParameters?: Set<ModelParameter>;
  // Additional provider-specific metadata
  metadata?: Record<string, unknown>;
}

/**
 * Tokenizer type used by the model.
 */
export type ModelTokenizer = 'Other' | 'GPT' | 'Mistral' | 'Llama3' | 'Qwen3' | 'Qwen' | 'Gemini' | 'DeepSeek' | 'Claude' | 'Grok' | 'Llama4' | 'Llama2' | 'Cohere' | 'Nova' | 'Router';

/**
 * Parameter names supported by models.
 */
export type ModelParameter = 
  // Chat Request
  | 'maxTokens' // max_tokens / max_completion_tokens
  | 'temperature' // temperature
  | 'topP' // top_p
  | 'frequencyPenalty' // frequency_penalty
  | 'presencePenalty' // presence_penalty
  | 'stop' // stop
  | 'seed' // seed
  | 'responseFormat' // response_format
  | 'structuredOutput' // structured_outputs
  | 'tools' // tools
  | 'toolChoice' // tool_choice
  | 'logitBias' // logit_bias
  | 'logProbabilities' // logprobs
  | 'reason' // reasoning
  // Image
  | 'imageBackground' // background
  | 'imageMultiple' // n
  | 'imageFormat' // output_format ()
  | 'imageStream' // stream / partial_images
  | 'imageStyle'
  // Embedding
  | 'embeddingDimensions' // dimensions
  // Transcription
  | 'transcribeStream' // stream
  | 'transcribePrompt' // prompt
  // Speech
  | 'speechInstructions' // instructions

/**
 * Override configuration for model properties.
 * Allows customizing model information without modifying the provider implementation.
 *
 * @template TProvider - Provider name type (string union)
 */
export interface ModelOverride<TProvider extends string = string> {
  // Match models from specific provider
  provider?: TProvider;
  // Match specific model ID
  modelId?: string;
  // Match model IDs using regex pattern
  modelPattern?: RegExp;
  // Properties to override
  overrides: Partial<Omit<ModelInfo<TProvider>, 'id' | 'provider'>>;
}

// ============================================================================
// Model Selection
// ===========================================`=================================

/**
 * Weights for scoring models during selection.
 * Higher weights prioritize that factor more heavily. Should sum to 1.0 for balanced scoring.
 */
export interface ModelSelectionWeights {
  // Weight for cost considerations (0-1)
  cost?: number;
  // Weight for speed/latency (0-1)
  speed?: number;
  // Weight for accuracy/quality (0-1)
  accuracy?: number;
  // Weight for context window size (0-1)
  contextWindow?: number;
}

/**
 * Model evaluation result from search/scoring.
 * Includes score and details about capability matching.
 *
 * @template TProvider - Provider name type
 */
export interface ScoredModel<TProvider extends string = string> {
  // The evaluated model
  model: ModelInfo<TProvider>;
  // Computed score (higher is better)
  score: number;
  // Required capabilities that matched
  matchedRequired: ModelCapability[];
  // Optional capabilities that matched
  matchedOptional: ModelCapability[];
  // Required capabilities that were missing
  missingRequired: ModelCapability[];
}

/**
 * Selected model with provider instance and configuration.
 * The result of model selection, ready to execute requests.
 *
 * @template TProviders - All available providers
 * @template TProviderName - Specific selected provider name
 */
export interface SelectedModel<
  TProviders extends Providers = Providers,
  TProviderName extends keyof TProviders = keyof TProviders
> {
  // Selected model information
  model: ModelInfo<TProviderName & string>;
  // Provider instance to use
  provider: TProviders[TProviderName];
  // Optional config override for this request
  providerConfig?: TProviders[TProviderName]['config'];
  // Selection score
  score: number;
}

export type SelectedModelFor<T extends AIBaseTypes> = SelectedModel<AIProviders<T>, AIProviderNames<T>>;

// ============================================================================
// AI Base Types Container
// ============================================================================

/**
 * Container for all type information about an AI instance
 * This is the single type parameter used throughout
 */
export type AIBaseTypes = AITypes<any, any, any, any, any, any, Providers>;

/**
 * Concrete instance of AIBaseTypes with specific types
 */
export type AITypes<
  TContext extends AIContextUser,
  TDefaultContext extends StrictPartial<TContext>,
  TProvidedContext extends StrictPartial<TContext>,
  TMetadata extends AIMetadataUser,
  TDefaultMetadata extends StrictPartial<TMetadata>,
  TProvidedMetadata extends StrictPartial<TMetadata>,
  TProviders extends Providers
> = {
  Context: TContext;
  DefaultContext: TDefaultContext;
  ProvidedContext: TProvidedContext;
  Metadata: TMetadata;
  DefaultMetadata: TDefaultMetadata;
  ProvidedMetadata: TProvidedMetadata;
  Providers: TProviders;
};

/**
 * Infer AIBaseTypes from AIConfig
 */
export type AITypesInfer<
  TContext extends object,
  TMetadata extends object,
  TProviders extends Providers,
  TConfig extends Omit<AIConfig<TContext, TMetadata, TProviders>, 'providers'>,
> = AITypes<
  TContext,
  TConfig['defaultContext'] extends (infer DC extends StrictPartial<TContext>) ? DC : {},
  TConfig['providedContext'] extends (ctx: StrictPartial<TContext>) => Promise<infer PC extends StrictPartial<TContext>> ? PC : {},
  TMetadata,
  TConfig['defaultMetadata'] extends (infer DM extends StrictPartial<TMetadata>) ? DM : {},
  TConfig['providedMetadata'] extends (metadata: any) => Promise<infer PM extends StrictPartial<TMetadata>> ? PM : {},
  TProviders
>;

// ============================================================================
// Context Types
// ============================================================================

/**
 * Extract provider names as string union
 */
export type AIProviderNames<T extends AIBaseTypes> = keyof AIProviders<T> & string;

/**
 * Range constraint for model selection criteria.
 * @template T - Type of the value being constrained
 */
export interface RangeConstraint<T> {
  // Minimum acceptable value (models without this metric or below this value are excluded)
  min?: T;
  // Maximum acceptable value (models without this metric or above this value are excluded)
  max?: T;
  // Target value for scoring (models closer to this value score higher)
  target?: T;
}

/**
 * Base metadata that all AI operations need.
 * Provides model selection criteria and constraints.
 *
 * @template TProviders - Provider types for type-safe provider filtering
 */
export interface AIBaseMetadata<TProviders extends Providers> {
  // Specific model to use (bypasses selection)
  model?: ModelInput;
  // Required capabilities (model must have all)
  required?: ModelCapability[];
  // Optional capabilities (preferred but not required)
  optional?: ModelCapability[];
  // Required parameters (model must support all)
  requiredParameters?: ModelParameter[];
  // Optional parameters (preferred but not required)
  optionalParameters?: ModelParameter[];
  // Provider allowlist/denylist
  providers?: {
    allow?: (keyof TProviders)[];
    deny?: (keyof TProviders)[];
  };
  // Pricing constraints (per 1M tokens)
  pricing?: RangeConstraint<ModelPricing>;
  // Context window constraints (in tokens)
  contextWindow?: RangeConstraint<number>;
  // Output token constraints (in tokens)
  outputTokens?: RangeConstraint<number>;
  // Performance metrics constraints
  metrics?: RangeConstraint<ModelMetrics>;
  // Scoring weights for model selection (takes priority over weightProfile)
  weights?: ModelSelectionWeights;
  // Named weight profile to use (from weightProfiles config)
  weightProfile?: string;
  // The tier to use to pick the best model
  tier?: ModelTier;
}

/**
 * Base metadata with any types - for providers & handlers.
 */
export type AIMetadataAny = AIBaseMetadata<Providers>;

/**
 * The type of user context that can be provided by the caller.
 */
export type AIMetadataUser = { [P in PropertyKey]: P extends keyof AIMetadataAny ? never : any };

/**
 * Base context that all AI operations get
 */
export type AIBaseContext<T extends AIBaseTypes> = {
  ai: AI<T>; // Typed as any to avoid circular reference, will be AI<T> at runtime
  metadata?: AIMetadata<T>;
  signal?: AbortSignal;
};

/**
 * Base context with any types - for providers & handlers.
 */
export type AIContextAny = Partial<AIBaseContext<AIBaseTypes>>// & { [custom: string | number | symbol]: any };

/**
 * The type of user context that can be provided by the caller.
 */
export type AIContextUser = { [P in PropertyKey]?: P extends keyof AIContextAny ? never : any };

/**
 * Full context = base context + user context
 */
export type AIContext<T extends AIBaseTypes> = Simplify<AIBaseContext<T> & Omit<T['Context'], keyof AIContextAny>>;

/**
 * Infers the context type from an AI instance
 */
export type AIContextInfer<A> = A extends AI<infer T> ? AIContext<T> : never;

/**
 * Full context for given user/context/provider types
 */
export type AIContextFor<
  TContext extends AIContextUser,
  TMetadata extends AIMetadataUser,
  TProviders extends Providers
> = AIContext<
  AITypesInfer<TContext, TMetadata, TProviders, 
    AIConfig<TContext, TMetadata, TProviders>
  >
> & AIContextAny;

/**
 * Required context that must be provided by caller
 * This relaxes properties that are satisfied by defaults or providers
 */
export type AIContextRequired<T extends AIBaseTypes> = Simplify<
  Partial<Omit<AIBaseContext<T>, 'ai'>> &
  Omit<Relax<T['Context'], T['DefaultContext'] & T['ProvidedContext']>, keyof AIContextAny>
>;

/**
 * Optional context parameter type for method signatures
 */
export type AIContextOptional<T extends AIBaseTypes> = OptionalParams<[AIContextRequired<T>]>;

/**
 * Full metadata = base metadata + user metadata
 */
export type AIMetadata<T extends AIBaseTypes> = Simplify<AIBaseMetadata<AIProviders<T>> & Omit<T['Metadata'], keyof AIMetadataAny>>;

/**
 * Required metadata that must be provided by caller
 */
export type AIMetadataRequired<T extends AIBaseTypes> = Simplify<
  AIBaseMetadata<AIProviders<T>> &
  Omit<Relax<T['Metadata'], T['DefaultMetadata'] & T['ProvidedMetadata']>, keyof AIMetadataAny>
>;

/**
 * Extract providers from AI types
 */
export type AIProviders<T extends AIBaseTypes> = T['Providers'];

/**
 * Extract provider type union from AI types
 */
export type AIProvider<T extends AIBaseTypes> = T['Providers'][keyof T['Providers']];

/**
 * Context passed to components (includes core context fields)
 */
export type Context<T extends AIBaseTypes> = CoreContext<
  AIContext<T>,
  AIMetadata<T>
>;

/**
 * Infers the component context type from an AI instance
 */
export type ContextInfer<A> = A extends AI<infer T> ? Context<T> : never;

/**
 * Component type for AI instance
 */
export type ComponentFor<T extends AIBaseTypes> = ComponentCompatible<
  AIContextRequired<T>,
  AIMetadataRequired<T>
>;

// ============================================================================
// Request/Response Types for Capabilities
// ============================================================================

/**
 * Request for generating images from text prompts.
 */
export interface ImageGenerationRequest extends BaseRequest {
  // Text description of desired image
  prompt: string;
  // Number of images to generate
  n?: number;
  // Image size
  // gpt-image-1: 1024x1024, 1536x1024, 1024x1536, auto
  // dall-e-2: 256x256, 512x512, 1024x1024
  // dall-e-3: 1024x1024, 1792x1024, 1024x1792
  size?: string;
  // Quality level (gpt-image-1, hd,standard=dall-e-3, standard=dall-e-2)
  quality?: 'low' | 'medium' | 'high';
  // Style preference (dall-e-3)
  style?: 'vivid' | 'natural'; 
  // Response format (dall-e-3, dall-e-2 supports both, gpt-image-1 only b64_json)
  responseFormat?: 'url' | 'b64_json';
  // Background type (gpt-image-1)
  background?: 'transparent' | 'opaque' | 'auto';
  // The number of partial images to generate for progress tracking for streaming operations (gpt-image-1)
  streamCount?: number;
  // Seed for reproducibility
  seed?: number;
  // Unique identifier for the user
  userIdentifier?: string;
}

/**
 * Request for editing existing images with text prompts.
 */
export interface ImageEditRequest extends BaseRequest {
  // Text description of desired edits
  prompt: string;
  // Source image to edit
  image: Resource;
  // Optional mask indicating edit region
  mask?: Resource;
  // Number of edited images to generate
  n?: number;
  // Output size
  size?: string;
  // Response format
  responseFormat?: 'url' | 'b64_json';
  // Seed for reproducibility
  seed?: number;
  // The number of partial images to generate for progress tracking for streaming operations
  streamCount?: number;
  // Unique identifier for the user
  userIdentifier?: string;
}

/**
 * Response from image generation/editing operations.
 */
export interface ImageGenerationResponse extends BaseResponse {
  // Generated images
  images: Array<{
    url?: string;
    b64_json?: string;
    revisedPrompt?: string;
  }>;
}

/**
 * Streaming chunk for image generation progress.
 */
export interface ImageGenerationChunk extends BaseChunk {
  // Partial image data
  imageData?: string;
  // Progress percentage (0-1)
  progress?: number;
  // Whether generation is complete
  done?: boolean;
  // Final image (when done)
  image?: {
    url?: string;
    b64_json?: string;
  };
}

/**
 * Request for transcribing audio to text.
 */
export interface TranscriptionRequest extends BaseRequest {
  // Audio data to transcribe
  audio: Resource;
  // Source language code (e.g., "en")
  language?: string;
  // Optional prompt to guide transcription
  prompt?: string;
  // Sampling temperature
  temperature?: number;
  // Output format
  responseFormat?: 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json';
  // Timestamp granularity
  timestampGranularities?: Array<'word' | 'segment'>;
}

/**
 * Response from audio transcription.
 */
export interface TranscriptionResponse extends BaseResponse {
  // Transcribed text
  text: string;
}

/**
 * Streaming chunk for transcription progress.
 */
export interface TranscriptionChunk extends BaseChunk {
  // Transcribed text chunk delta
  delta?: string;
  // The full text transcribed
  text?: string;
  // Segment information (after segment complete
  segment?: { start: number; end: number; speaker: string, text: string, id: string };
  // Status message
  status?: string;
}

/**
 * Request for generating speech from text.
 */
export interface SpeechRequest extends BaseRequest{
  // Text to convert to speech
  text: string;
  // Instructions for speech style/tone
  instructions?: string;
  // Voice identifier
  voice?: string;
  // Speech speed multiplier (0.25 - 4.0)
  speed?: number;
  // Audio format
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}

/**
 * Response from speech synthesis.
 */
export interface SpeechResponse extends BaseResponse {
  // Generated audio data
  audio: ReadableStream<any>;
  // Audio format
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}

/**
 * Request for generating text embeddings.
 */
export interface EmbeddingRequest extends BaseRequest {
  // Texts to embed
  texts: string[];
  // Output dimensions (if supported by model)
  dimensions?: number;
  // Encoding format
  encodingFormat?: 'float' | 'base64';
  // The unique identifier for the user
  userIdentifier?: string;
}

/**
 * Response from embedding generation.
 */
export interface EmbeddingResponse extends BaseResponse {
  // Generated embeddings
  embeddings: Array<{
    embedding: number[];
    index: number;
  }>;
}

/**
 * Request for analyzing images with vision models.
 */
export interface ImageAnalyzeRequest extends BaseRequest{
  // Analysis prompt/question
  prompt: string;
  // Image URLs or base64 data
  images: string[];
  // Maximum tokens in response
  maxTokens?: number;
  // Sampling temperature
  temperature?: number;
}

// ============================================================================
// Model Handler
// ============================================================================

/**
 * Model-specific handler that overrides default provider behavior.
 * Use handlers to provide custom implementations for specific models that differ
 * from the provider's standard API (e.g., special Replicate models).
 *
 * @template TContext - Context type passed to handler methods
 * @template TProvider - Provider name type
 *
 * @example
 * ```typescript
 * const handler: ModelHandler = {
 *   provider: 'replicate',
 *   modelId: 'stability-ai/sdxl',
 *   imageGenerate: {
 *     get: async (request, ctx) => {
 *       // Custom implementation for this specific model
 *       return customImageGeneration(request, ctx);
 *     }
 *   }
 * };
 * ```
 */
export interface ModelHandler<TContext extends AIContextAny = AIContextAny> {
  models: string[];

  chat?: {
    get?: <TRuntimeContext extends TContext>(request: Request, ctx: TRuntimeContext) => Promise<Response>;
    stream?: <TRuntimeContext extends TContext>(request: Request, ctx: TRuntimeContext) => AsyncIterable<Chunk>;
  };

  imageGenerate?: {
    get?: <TRuntimeContext extends TContext>(request: ImageGenerationRequest, ctx: TRuntimeContext) => Promise<ImageGenerationResponse>;
    stream?: <TRuntimeContext extends TContext>(request: ImageGenerationRequest, ctx: TRuntimeContext) => AsyncIterable<ImageGenerationChunk>;
  };

  imageEdit?: {
    get?: <TRuntimeContext extends TContext>(request: ImageEditRequest, ctx: TRuntimeContext) => Promise<ImageGenerationResponse>;
    stream?: <TRuntimeContext extends TContext>(request: ImageEditRequest, ctx: TRuntimeContext) => AsyncIterable<ImageGenerationChunk>;
  };

  imageAnalyze?: {
    get?: <TRuntimeContext extends TContext>(request: ImageAnalyzeRequest, ctx: TRuntimeContext) => Promise<Response>;
    streem?: <TRuntimeContext extends TContext>(request: ImageAnalyzeRequest, ctx: TRuntimeContext) => AsyncIterable<Chunk>;
  };

  transcribe?: {
    get?: <TRuntimeContext extends TContext>(request: TranscriptionRequest, ctx: TRuntimeContext) => Promise<TranscriptionResponse>;
    stream?: <TRuntimeContext extends TContext>(request: TranscriptionRequest, ctx: TRuntimeContext) => AsyncIterable<TranscriptionChunk>;
  };

  speech?: {
    get?: <TRuntimeContext extends TContext>(request: SpeechRequest, ctx: TRuntimeContext) => Promise<SpeechResponse>;
  };

  embed?: {
    get?: <TRuntimeContext extends TContext>(request: EmbeddingRequest, ctx: TRuntimeContext) => Promise<EmbeddingResponse>;
  };
}

/**
 * Model handler for AIBaseTypes instance
 */
export type ModelHandlerFor<T extends AIBaseTypes> = ModelHandler<AIContext<T>>;

/**
 * Model transformer response type - omits model and usage fields.
 */
export type ModelTransformerResponse<T> = Omit<T, 'model' | 'usage'>;

/**
 * Model transformer for providers with inconsistent request/response shapes.
 * Transforms standard requests/responses to/from provider-specific formats.
 * Useful for adapting providers like Replicate that have model-specific APIs.
 *
 * @template TRequest - A specific type for transformed requests if any
 * @template TResponse - A specific type for transformed responses if any
 * @template TChunk - A specific type for transformed streaming chunks if any
 */
export interface ModelTransformer<
  TRequest = object,
  TResponse = object,
  TChunk = object,
> {
  chat?: {
    convertRequest?: (request: Request, ctx: AIContextAny) => Promise<TRequest>;
    parseResponse?: (response: TResponse, ctx: AIContextAny) => Promise<ModelTransformerResponse<Response>>;
    parseChunk?: (chunk: TChunk, ctx: AIContextAny) => Promise<Chunk>;
  };

  imageGenerate?: {
    convertRequest?: (request: ImageGenerationRequest, ctx: AIContextAny) => Promise<TRequest>;
    parseResponse?: (response: TResponse, ctx: AIContextAny) => Promise<ModelTransformerResponse<ImageGenerationResponse>>;
    parseChunk?: (chunk: TChunk, ctx: AIContextAny) => Promise<ImageGenerationChunk>;
  };

  imageEdit?: {
    convertRequest?: (request: ImageEditRequest, ctx: AIContextAny) => Promise<TRequest>;
    parseResponse?: (response: TResponse, ctx: AIContextAny) => Promise<ModelTransformerResponse<ImageGenerationResponse>>;
    parseChunk?: (chunk: TChunk, ctx: AIContextAny) => Promise<ImageGenerationChunk>;
  };

  imageAnalyze?: {
    convertRequest?: (request: ImageAnalyzeRequest, ctx: AIContextAny) => Promise<TRequest>;
    parseResponse?: (response: TResponse, ctx: AIContextAny) => Promise<ModelTransformerResponse<Response>>;
    parseChunk?: (chunk: TChunk, ctx: AIContextAny) => Promise<Chunk>;
  };

  transcribe?: {
    convertRequest?: (request: TranscriptionRequest, ctx: AIContextAny) => Promise<TRequest>;
    parseResponse?: (response: TResponse, ctx: AIContextAny) => Promise<ModelTransformerResponse<TranscriptionResponse>>;
    parseChunk?: (chunk: TChunk, ctx: AIContextAny) => Promise<TranscriptionChunk>;
  };

  speech?: {
    convertRequest?: (request: SpeechRequest, ctx: AIContextAny) => Promise<TRequest>;
    parseResponse?: (response: TResponse, ctx: AIContextAny) => Promise<ModelTransformerResponse<SpeechResponse>>;
  };

  embed?: {
    convertRequest?: (request: EmbeddingRequest, ctx: AIContextAny) => Promise<TRequest>;
    parseResponse?: (response: TResponse, ctx: AIContextAny) => Promise<ModelTransformerResponse<EmbeddingResponse>>;
  };
}

// ============================================================================
// Model Source Interface
// ============================================================================

/**
 * External source of model information.
 * Model sources fetch model metadata from external registries (e.g., OpenRouter)
 * to enrich provider model information with pricing, capabilities, and metrics.
 *
 * @example
 * ```typescript
 * const openRouterSource: ModelSource = {
 *   name: 'openrouter',
 *   fetchModels: async () => {
 *     const response = await fetch('https://openrouter.ai/api/v1/models');
 *     return parseModels(response);
 *   }
 * };
 * ```
 */
export interface ModelSource {
  // Identifier for this model source
  name: string;
  // Fetch models from this source
  fetchModels(config?: Record<string, unknown>): Promise<ModelInfo[]>;
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * AI provider implementation interface.
 * Providers implement the actual communication with AI services (OpenAI, Anthropic, etc.).
 * They expose methods for different capabilities (chat, images, speech, etc.).
 *
 * @template TConfig - Provider-specific configuration type
 *
 * @example
 * ```typescript
 * const openai: Provider<OpenAIConfig> = {
 *   name: 'openai',
 *   config: { apiKey: process.env.OPENAI_API_KEY },
 *
 *   async listModels() {
 *     // Fetch available models from OpenAI
 *     return [...];
 *   },
 *
 *   async checkHealth() {
 *     // Verify API is accessible
 *     return true;
 *   },
 *
 *   createExecutor() {
 *     // Return chat completion function
 *     return async (request, ctx, metadata) => {
 *       // Make API call
 *       return response;
 *     };
 *   },
 *
 *   // ... other methods
 * };
 * ```
 */
export interface Provider<TConfig = any> {
  // Provider identifier
  name: string;
  // Provider configuration
  config: TConfig;
  // Provider priority for model selection, 0=highest priority, default priority=10
  priority?: number;
  // Default metadata for all requests to this provider
  defaultMetadata?: Partial<AIBaseMetadata<any>>;

  // List models available from this provider
  listModels?(config?: TConfig): Promise<ModelInfo[]>;
  // Health check for provider availability
  checkHealth(config?: TConfig): Promise<boolean>;

  createExecutor?(
    config?: TConfig
  ): Executor<AIContextAny, AIMetadataAny>;

  createStreamer?(
    config?: TConfig
  ): Streamer<AIContextAny, AIMetadataAny>;

  generateImage?(
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<ImageGenerationResponse>;

  generateImageStream?(
    request: ImageGenerationRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<ImageGenerationChunk>;

  editImage?(
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<ImageGenerationResponse>;

  editImageStream?(
    request: ImageEditRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<ImageGenerationChunk>;

  transcribe?(
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<TranscriptionResponse>;

  transcribeStream?(
    request: TranscriptionRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<TranscriptionChunk>;

  speech?(
    request: SpeechRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<SpeechResponse>;

  embed?(
    request: EmbeddingRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<EmbeddingResponse>;

  analyzeImage?(
    request: ImageAnalyzeRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): Promise<Response>;

  analyzeImageStream?(
    request: ImageAnalyzeRequest,
    ctx: AIContextAny,
    config?: TConfig
  ): AsyncIterable<Chunk>;
}

// ============================================================================
// AI Configuration
// ============================================================================

/**
 * Lifecycle hooks for AI operations.
 * Hooks allow you to intercept and modify AI operations at key points:
 * - Model selection
 * - Before/after requests
 * - Error handling
 *
 * @template T - AIBaseTypes container
 *
 * @example
 * ```typescript
 * const hooks: AIHooks<MyAITypes> = {
 *   beforeRequest: async (ctx, selected, tokens, cost) => {
 *     console.log(`Using ${selected.model.id}, estimated ${tokens} tokens, cost ${cost}`);
 *
 *     // Check budget
 *     if (ctx.user.budget < estimatedCost) {
 *       throw new Error('Insufficient budget');
 *     }
 *   },
 *
 *   afterRequest: async (ctx, selected, usage, cost) => {
 *     // Track usage in database
 *     await db.logUsage(ctx.user.id, usage, cost);
 *   },
 *
 *   onError: (type, message, error, ctx) => {
 *     logger.error(`AI Error [${type}]: ${message}`, error);
 *   }
 * };
 * ```
 */
export interface AIHooks<T extends AIBaseTypes> {
  /**
   * Called before model selection, allows modifying metadata.
   * Use this to dynamically adjust model selection criteria based on context.
   */
  beforeModelSelection?: (
    ctx: AIContext<T>,
    request: BaseRequest,
    metadata: AIMetadata<T>
  ) => Promise<AIMetadata<T>> | AIMetadata<T>;

  /**
   * Called after model selection, can override the selected model or config.
   * Return a modified SelectedModel to change the selection, or void to accept it.
   */
  onModelSelected?: (
    ctx: AIContext<T>,
    request: BaseRequest,
    selected: SelectedModelFor<T>
  ) => Promise<SelectedModelFor<T> | void> | SelectedModelFor<T> | void;

  /**
   * Called before making the API request.
   * Use this for budget checks, rate limiting, or logging.
   * Throw an error to cancel the request.
   */
  beforeRequest?: (
    ctx: AIContext<T>,
    request: BaseRequest,
    selected: SelectedModelFor<T>,
    estimatedUsage: Usage,
    estimatedCost: number
  ) => Promise<void> | void;

  /**
   * Called after successful request completion.
   * Use this to track usage, update budgets, or log metrics.
   */
  afterRequest?: (
    ctx: AIContext<T>,
    request: BaseRequest,
    response: BaseResponse,
    responseComplete: boolean,
    selected: SelectedModelFor<T>,
    usage: Usage,
    cost: number
  ) => Promise<void> | void;

  /**
   * Called when an error occurs in any AI operation.
   * Use this for centralized error logging and monitoring.
   */
  onError?: (
    errorType: string,
    message: string,
    error?: Error,
    ctx?: AIContext<T> | AIContextRequired<T>,
    request?: BaseRequest,
  ) => void;
}

/**
 * Configuration for creating an AI instance.
 * Defines providers, context, metadata, and model management settings.
 *
 * @template TContext - Custom context type
 * @template TMetadata - Custom metadata type
 * @template TProviders - Available providers
 *
 * @example
 * ```typescript
 * const config: AIConfig<AppContext, AppMetadata, typeof providers> = {
 *   // Context management
 *   defaultContext: {
 *     apiVersion: 'v1'
 *   },
 *   providedContext: async (ctx) => ({
 *     user: await getUser(ctx.userId),
 *     db: database
 *   }),
 *
 *   // Providers
 *   providers: { openai, anthropic },
 *
 *   // Model configuration
 *   models: customModels,
 *   modelOverrides: [
 *     {
 *       modelPattern: /gpt-4/,
 *       overrides: { pricing: customPricing }
 *     }
 *   ],
 *
 *   // Model sources
 *   modelSources: [openRouterSource],
 *
 *   // Selection profiles
 *   defaultWeights: { cost: 0.6, speed: 0.4 },
 *   profiles: {
 *     costPriority: { cost: 0.9, speed: 0.1 },
 *     performance: { cost: 0.1, speed: 0.5, accuracy: 0.4 }
 *   }
 * };
 * ```
 */
export interface AIConfig<
  TContext extends AIContextUser,
  TMetadata extends AIMetadataUser,
  TProviders extends Providers
> {
  // Default context values (always available)
  defaultContext?: StrictPartial<TContext>;
  // Async context provider (e.g., fetch from database)
  providedContext?: (ctx: StrictPartial<TContext>) => Promise<StrictPartial<TContext>>;
  
  // Default metadata values
  defaultMetadata?: StrictPartial<Omit<TMetadata, keyof AIMetadataAny> & AIBaseMetadata<TProviders>>;
  // Async metadata provider
  providedMetadata?: (metadata: StrictPartial<Omit<TMetadata, keyof AIMetadataAny> & AIBaseMetadata<TProviders>>) => Promise<StrictPartial<TMetadata> & AIBaseMetadata<TProviders>>;

  // Provider instances
  providers: TProviders;

  // Custom model registrations
  models?: ModelInfo[];
  // Model property overrides
  modelOverrides?: ModelOverride[];
  // Model-specific handlers
  modelHandlers?: ModelHandler<AIContextFor<TContext, TMetadata, TProviders>>[];
  // External model sources
  modelSources?: ModelSource[];

  // Default scoring weights for model selection
  defaultWeights?: ModelSelectionWeights;
  // Named weight profiles for model selection
  weightProfiles?: Record<string, ModelSelectionWeights>;

  tokens?: {
    textDivisor?: number;        // Default: 4
    textBase64Divisor?: number;  // Default: 3
    textFallback?: number;       // Default: 1000
    textMax?: number;            // Default: none
    imageDivisor?: number;       // Default: 1125
    imageBase64Divisor?: number; // Default: 1500
    imageFallback?: number;      // Default: 1360
    imageMax?: number;           // Default: 1360
    fileDivisor?: number;        // Default: 3
    fileBase64Divisor?: number;  // Default: 4
    fileFallback?: number;       // Default: 1000
    fileMax?: number;            // Default: none
    audioDivisor?: number;       // Default: 3
    audioBase64Divisor?: number; // Default: 4
    audioFallback?: number;      // Default: 200 (per minute)
    audioMax?: number;           // Default: none
  };

  // Default cost for unknown models (per 1M tokens)
  defaultCostPerMillionTokens?: number;
}

/**
 * Extract AIConfig type from AIBaseTypes
 */
export type AIConfigOf<T extends AIBaseTypes> = AIConfig<T['Context'], T['Metadata'], AIProviders<T>>;

// ============================================================================
// Library Stats
// ============================================================================

/**
 * Runtime statistics about the AI instance.
 * Provides insights into model usage and performance.
 */
export interface LibraryStats {
  // Total number of registered models
  totalModels: number;
  // Model count by provider
  modelsByProvider: Record<string, number>;
  // Total requests made
  totalRequests: number;
  // Successfully completed requests
  successfulRequests: number;
  // Failed requests
  failedRequests: number;
  // Average cost per request
  averageCost: number;
  // Average latency in milliseconds
  averageLatency: number;
}
