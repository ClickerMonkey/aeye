import z from 'zod'; // zod 4

interface ReplicateTransformer {
  chat?: {
    convertRequest?: (request: Request, ctx: AIContextAny) => Promise<any>;
    parseResponse?: (response: object, ctx: AIContextAny) => Promise<ModelTransformerResponse<Response>>;
    parseChunk?: (chunk: any, ctx: AIContextAny) => Promise<Chunk>;
  };

  imageGenerate?: {
    convertRequest?: (request: ImageGenerationRequest, ctx: AIContextAny) => Promise<any>;
    parseResponse?: (response: any, ctx: AIContextAny) => Promise<ModelTransformerResponse<ImageGenerationResponse>>;
    parseChunk?: (chunk: any, ctx: AIContextAny) => Promise<ImageGenerationChunk>;
  };

  imageEdit?: {
    convertRequest?: (request: ImageEditRequest, ctx: AIContextAny) => Promise<any>;
    parseResponse?: (response: any, ctx: AIContextAny) => Promise<ModelTransformerResponse<ImageGenerationResponse>>;
    parseChunk?: (chunk: any, ctx: AIContextAny) => Promise<ImageGenerationChunk>;
  };

  imageAnalyze?: {
    convertRequest?: (request: ImageAnalyzeRequest, ctx: AIContextAny) => Promise<any>;
    parseResponse?: (response: any, ctx: AIContextAny) => Promise<ModelTransformerResponse<Response>>;
    parseChunk?: (chunk: any, ctx: AIContextAny) => Promise<Chunk>;
  };

  transcribe?: {
    convertRequest?: (request: TranscriptionRequest, ctx: AIContextAny) => Promise<any>;
    parseResponse?: (response: any, ctx: AIContextAny) => Promise<ModelTransformerResponse<TranscriptionResponse>>;
    parseChunk?: (chunk: any, ctx: AIContextAny) => Promise<TranscriptionChunk>;
  };

  speech?: {
    convertRequest?: (request: SpeechRequest, ctx: AIContextAny) => Promise<any>;
    parseResponse?: (response: any, ctx: AIContextAny) => Promise<ModelTransformerResponse<SpeechResponse>>;
  };

  embed?: {
    convertRequest?: (request: EmbeddingRequest, ctx: AIContextAny) => Promise<any>;
    parseResponse?: (response: any, ctx: AIContextAny) => Promise<ModelTransformerResponse<EmbeddingResponse>>;
  };
}
type AIContextAny = {
  ai: {} // special type, not important for implementation
  metadata?: {
    model?: ModelInput;
    // others
  };
  signal?: AbortSignal;
}
type ModelTransformerResponse<T> = Omit<T, 'model' | 'usage'>;
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
interface Message { 
  role: MessageRole;
  content: string | MessageContent[];
  tokens?: number;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  refusal?: string;
  cache?: Record<string, any>;
}
type MessageContentType = 'text' | 'image' | 'file' | 'audio';
interface MessageContent {
  type: MessageContentType;
  content: Resource;
  format?: string;
}
interface ToolDefinition {
  name: string;
  description?: string;
  parameters: z.ZodType<object>;
  strict?: boolean;
}
interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { tool: string };
type ResponseFormat =
  | 'text'
  | 'json'
  | { type: z.ZodType<object, object>, strict: boolean };
interface Usage {
  text?: {
    input?: number;
    output?: number;
    cached?: number;
  };
  audio?: {
    input?: number;
    output?: number;
    seconds?: number;
  };
  image?: {
    input?: number;
    output?: {
      quality: string;
      size: { width: number; height: number; };
      count: number;
    }[];
  };
  reasoning?: {
    input?: number;
    output?: number;
    cached?: number;
  };
  embeddings?: {
    count?: number;
    tokens?: number;
  };
  cost?: number;
}
type ReasoningEffort = 'low' | 'medium' | 'high';
interface Request extends BaseRequest {
  name?: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string | string[];
  logProbabilities?: boolean;
  logitBias?: Record<string, number>;
  tools?: ToolDefinition[];
  toolsOneAtATime?: boolean;
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  reason?: { effort?: ReasoningEffort, maxTokens?: number };
  cacheKey?: string;
  userKey?: string;
}
type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'refusal';
interface Model {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}
type ModelInput = string | Model;
interface BaseRequest {
  model?: ModelInput;
  extra?: Record<string, any>;
}
interface BaseResponse {
  usage?: Usage;
  model: ModelInput;
}
interface BaseChunk {
  usage?: Usage;
  model?: ModelInput;
}
interface Response extends BaseResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: FinishReason;
  refusal?: string;
  reasoning?: string;
}
interface Chunk extends BaseChunk {
  content?: string;
  toolCallNamed?: ToolCall;
  toolCallArguments?: ToolCall;
  toolCall?: ToolCall;
  finishReason?: FinishReason;
  refusal?: string;
  reasoning?: string;
}
interface ImageGenerationRequest extends BaseRequest {
  prompt: string;
  n?: number;
  size?: string;
  quality?: 'low' | 'medium' | 'high';
  style?: 'vivid' | 'natural'; 
  responseFormat?: 'url' | 'b64_json';
  background?: 'transparent' | 'opaque' | 'auto';
  streamCount?: number;
  seed?: number;
  userIdentifier?: string;
}
interface ImageEditRequest extends BaseRequest {
  prompt: string;
  image: Resource;
  mask?: Resource;
  n?: number;
  size?: string;
  responseFormat?: 'url' | 'b64_json';
  seed?: number;
  streamCount?: number;
  userIdentifier?: string;
}
interface ImageGenerationResponse extends BaseResponse {
  images: Array<{
    url?: string;
    b64_json?: string;
    revisedPrompt?: string;
  }>;
}
interface ImageGenerationChunk extends BaseChunk {
  imageData?: string;
  progress?: number;
  done?: boolean;
  image?: {
    url?: string;
    b64_json?: string;
  };
}
interface TranscriptionRequest extends BaseRequest {
  audio: Resource;
  language?: string;
  prompt?: string;
  temperature?: number;
  responseFormat?: 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json';
  timestampGranularities?: Array<'word' | 'segment'>;
}
interface TranscriptionResponse extends BaseResponse {
  text: string;
}
interface TranscriptionChunk extends BaseChunk {
  delta?: string;
  text?: string;
  segment?: { start: number; end: number; speaker: string, text: string, id: string };
  status?: string;
}
interface SpeechRequest extends BaseRequest{
  text: string;
  instructions?: string;
  voice?: string;
  speed?: number;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}
interface SpeechResponse extends BaseResponse {
  audio: ReadableStream<any>;
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
}
// Read the inputs with embeddingInputs(request) (or embeddingTexts(request, modelId) for
// text-only models, which refuses images); isEmbeddingImage(input) tells an image, and
// embeddingImageURL(input) gives its URL (http(s) or data URL). All from '@aeye/ai'.
interface EmbeddingImage { image: Resource; mimeType?: string }
type EmbeddingInput = string | EmbeddingImage;
interface EmbeddingRequest extends BaseRequest {
  inputs?: EmbeddingInput[];
  texts?: string[];
  dimensions?: number;
  encodingFormat?: 'float' | 'base64';
  userIdentifier?: string;
}
interface EmbeddingResponse extends BaseResponse {
  embeddings: Array<{
    embedding: number[];
    index: number;
  }>;
}
interface ImageAnalyzeRequest extends BaseRequest{
  prompt: string;
  images: string[];
  maxTokens?: number;
  temperature?: number;
}
type Resource = 
 | string // plain text, or data URL, or http(s) URL, or file:// URL
 | AsyncIterable<Uint8Array> // fs.ReadStream, ReadableStream
 | Blob // File
 | Uint8Array 
 | URL
 | ArrayBuffer
 | DataView
 | Buffer
 | { blob(): Promise<Blob> | Blob }
 | { url(): string }
 | { read(): Promise<ReadableStream> | ReadableStream }