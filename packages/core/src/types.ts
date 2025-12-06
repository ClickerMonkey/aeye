import z from "zod";
import { Resolved } from "./common";
import { AnyPrompt, PromptEvent } from "./prompt";
import { extend } from "zod/mini";

/**
 * Utility type for representing tuples (arrays with at least zero elements).
 *
 * @template T - The element type of the tuple.
 */
export type Tuple<T> = [] | [T, ...T[]];

/**
 * Simplifies complex intersection types into a flat, readable type.
 * Useful for improving TypeScript hints and error messages.
 *
 * @template T - The type to simplify
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Overrides properties in TBase with those from TOverride.
 *
 * @template TBase - The base type.
 * @template TOverride - The type with properties to override.
 */
export type Extend<TBase, TOverride> = TBase & TOverride; // Simplify<TBase & Omit<TOverride, keyof TBase>>;

/**
 * T plus any extra properties.
 */
export type Plus<T> = T & { [P in PropertyKey]: P extends keyof T ? T[P] : any };

/**
 * Extracts the required keys from an object type.
 *
 * @template T - The object type to extract required keys from.
 */
export type RequiredKeys<T> = {
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K
}[keyof T];

/**
 * Converts function parameters into optional arguments if they have no required keys.
 * This allows methods to accept optional parameters elegantly.
 *
 * @template P - The parameter tuple type.
 * @example
 * function<A, B, C>(...[a, b, c]: OptionalParams<[A, B, C]>): void
 */
export type OptionalParams<P> = 
  P extends []
    ? []
    : P extends [infer F]
      ? RequiredKeys<F> extends never ? [param?: F] : [param: F]
      : P extends [...infer F, infer R]
        ? RequiredKeys<R> extends never
          ? [...OptionalParams<F>, param?: R]
          : [...F, R]
        : never;

/**
* The base interface for AI components.
* 
* @template TName - The name of the component, typed for inference in parent components.
* @template TInput - The input type for the component.
* @template TOutput - The output type for the component.
* @template TContext - The context type needed for the component's operation.
* @template TMetadata - The metadata type needed during execution/streaming.
*/
export interface Component<
  TContext = {},
  TMetadata = {},
  TName extends string = string,
  TInput extends object = {},
  TOutput = string,
  TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>> = [],
> {

  /**
   * The component kind/type. Base kinds are prompt, tool, and agent.
   */
  kind: string;
  
  /**
  * The name of the component. Typed so parent components can infer child component names.
  */
  name: TName;
  
  /**
  * A brief description of the component.
  * 
  * This may or may not be used directly by the component or its parents, but is useful for documentation and understanding the component's purpose.
  */
  description: string;
  
  /**
  * References to other components that this component depends on.
  * 
  * Useful for understanding the potential hierarchy or graph of components.
  */
  refs: TRefs;
  
  /**
  * Executes the component with the given context and input.
  * 
  * @param ctx - The context for the component's operation.
  * @param input - The input for the component.
  * @returns A promise that resolves to the output of the component.
  */
  run<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[input, ctx]: OptionalParams<[TInput, TCoreContext]>): TOutput;

  /**
   * Determines if the component is applicable in the given context.
   * 
   * @param ctx - The context to check applicability against.
   */
  applicable<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[ctx]: OptionalParams<[TCoreContext]>): Promise<boolean>;

  /**
   * Returns metadata for the component based on the input and context.
   * Metadata is typically used during execution/streaming to provide additional context.
   * 
   * @param input - The input for the component.
   * @param ctx - The context for the component's operation.
   * @returns The metadata for the component.
   */
  metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[input, ctx]: OptionalParams<[TInput, TCoreContext]>): Promise<TMetadata>;
}

/**
 * A type representing a tuple of AI components that are all compatible with the given context and metadata.
 */
export type ComponentTuple<TContext, TMetadata, TComponents extends Tuple<AnyComponent>> = TComponents & {
  [K in keyof TComponents]: TComponents[K] extends Component<infer U, infer V, any, any, any, any>
    ? TContext extends U
      ? TMetadata extends V
        ? TComponents[K]
        : never
      : never
    : never
};

/**
 * A type representing any AI component that is compatible with the given context and metadata.
 */
export type ComponentCompatible<TContext, TMetadata> = AnyComponent extends infer R
  ? R extends Component<infer U extends TContext, infer V extends TMetadata, any, any, any, any>
    ? Component<U, V, any, any, any, any>
    : never
  : never;

// Component<TContext, TMetadata, any, any, any, any>;

/**
 * A type representing any AI component.
 */
export type AnyComponent = Component<any, any, any, any, any, any>;

/**
 * Extracts contact type from a given AI component.
 */
export type ComponentContext<C extends AnyComponent> = C extends Component<infer TContext, infer t0, infer t1, infer t2, infer t3, infer t4> ? TContext : {};

/**
 * Extracts metadata type from a given AI component.
 */
export type ComponentMetadata<C extends AnyComponent> = C extends Component<infer t0, infer TMetadata, infer t1, infer t2, infer t3, infer t4> ? TMetadata : {};

/**
 * Extracts input type from a given AI component.
 */
export type ComponentInput<C extends AnyComponent> = C extends Component<infer t0, infer t1, infer t2, infer TInput, infer t3, infer t4> ? TInput : never;

/**
 * Extracts output type from a given AI component.
 */
export type ComponentOutput<C extends AnyComponent> = C extends Component<infer t0, infer t1, infer t2, infer t3, infer TOutput, infer t4> ? TOutput : never;

/**
 * Extracts refs type from a given AI component.
 */
export type ComponentRefs<C extends AnyComponent> = C extends Component<infer t0, infer t1, infer t2, infer t3, infer t4, infer TRefs> ? TRefs : never;

/**
 * All components referenced directly or indirectly by a given component.
 */
export type ComponentsAll<C extends AnyComponent> = C extends Component<infer t0, infer t1, infer t2, infer t3, infer t4, infer TRefs>
  ? C | TRefs[number] | ComponentsAll<TRefs[number]>
  : never;

/**
 * Extracts the names of a tuple of components.
 */
export type Names<T extends Tuple<AnyComponent>> = 
  T extends Tuple<infer C extends Component<infer t0, infer t1, infer TName, infer t2, infer t3, infer t4>>
    ? TName
    : never;

/**
 * Function type for executing AI requests synchronously (non-streaming).
 *
 * @template TContext - The context type for the request.
 * @template TMetadata - The metadata type for the request.
 * @param request - The AI request parameters.
 * @param context - The context for the request.
 * @param metadata - Optional metadata for the request.
 * @param signal - Optional abort signal for cancellation.
 * @returns A promise resolving to the complete AI response.
 */
export type Executor<
  TContext,
  TMetadata
> = <TRuntimeContext extends TContext, TRuntimeMetadata extends TMetadata>(request: Request, context: TRuntimeContext, metadata?: TRuntimeMetadata, signal?: AbortSignal) => Promise<Response>;

/**
 * Function type for executing AI requests with streaming support.
 *
 * @template TContext - The context type for the request.
 * @template TMetadata - The metadata type for the request.
 * @param request - The AI request parameters.
 * @param context - The context for the request.
 * @param metadata - Optional metadata for the request.
 * @param signal - Optional abort signal for cancellation.
 * @returns An async generator yielding response chunks and returning the final response.
 */
export type Streamer<
  TContext,
  TMetadata
> = <TRuntimeContext extends TContext, TRuntimeMetadata extends TMetadata>(request: Request, context: TRuntimeContext, metadata?: TRuntimeMetadata, signal?: AbortSignal) => AsyncGenerator<Chunk, Response>;

/**
* The context type for AI components, combining TContext and the inputs this AI system requires to operate.
*/
export type Context<TContext, TMetadata> = TContext & 
{
  /**
   * Messages in the context
   */
  messages?: Message[];

  /**
  * Executor and Streamer for this context
  */
  execute?: Executor<TContext, TMetadata>;
  
  /**
  * Streamer for this context
  */
  stream?: Streamer<TContext, TMetadata>;

  /**
   * An optional AbortSignal to cancel operations.
   */
  signal?: AbortSignal;

  /**
   * An optional function to estimate usage for a message. 
   * 
   * This handles non-text data types (images, audio, files) more accurately than just token counting.
   * If this is not provided, and the message has no tokens - it will use the average available tokens per message.
   * 
   * @param message - The message to estimate usage for.
   * @returns The estimated usage statistics.
   */
  estimateUsage?: (message: Message) => Usage | undefined;

  /**
   * The default number of completion tokens to reserve when calculating available prompt tokens.
   */
  maxOutputTokens?: number;

  /**
   * The context window size restriction to impose, if any.
   */
  contextWindow?: number;

  /** 
   * Number of attempts to get the output in the right format and to pass validation. Defaults to 2. 
   */
  outputRetries?: number;

  /** 
   * Number of attempts that will be made to forget context messages of the past in order to complete the request. Defaults to 1.
   */
  forgetRetries?: number;

  /**
   * Number of attempts to retry tool calls upon failure. Defaults to 2.
   */
  toolRetries?: number;

  /**
   * The current instance of the component being executed, if any.
   */
  instance?: Instance<any>;

  /**
   * A custom component runner that can override how components are executed.
   */
  runner?: Runner;
}

/**
 * A custom component runner that can override how components are executed.
 * 
 * @param component - The component to run.
 * @param ctx - The context for the component's operation.
 * @param input - The input for the component.
 * @param getOutput - A function that returns the output of the component.
 * @returns 
 */
export type Runner = <
  TComponent extends AnyComponent,
  TContext extends ComponentContext<TComponent>,
  TMetadata extends ComponentMetadata<TComponent>,
  TCoreContext extends Context<TContext, TMetadata>,
  >(
  component: TComponent, 
  input: ComponentInput<TComponent>, 
  ctx: TCoreContext, 
  // @ts-ignore
  getOutput: (ctx: TCoreContext, events?: Events<TComponent>) => ComponentOutput<TComponent>
) => ComponentOutput<TComponent>

/**
 * A resource that can be converted to a URL, Base64 string, text, or Readable.
 */
export type Resource = 
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
;

/**
 * The role of a message in a conversation with an AI system.
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Represents a message in a conversation with an AI system.
 * Messages can come from different roles and contain various types of content.
 */
export interface Message
{
  /** The role of the message sender */
  role: MessageRole;
  /** Content can be a simple string or an array of structured content parts */
  content: string | MessageContent[];
  /** Number of tokens in the content, if known. Used for automatic trimming when token limits are exceeded. */
  tokens?: number;
  /** Optional name of the sender for the given role */
  name?: string;
  /** Used for tool call results (when role='tool') */
  toolCallId?: string;
  /** Used to acknowledge an assistant is running tools (when role='assistant') */
  toolCalls?: ToolCall[];
  /** Used for refusals (when role='assistant') */
  refusal?: string;
  /** Used to pass cache data along with the message */
  cache?: Record<string, any>;
}

/**
 * The type of content within a message.
 */
export type MessageContentType = 'text' | 'image' | 'file' | 'audio';

/**
 * Structured content part within a message.
 * Supports multiple content types including text, images, files, and audio.
 */
export interface MessageContent
{
  /** The type of content */
  type: MessageContentType;
  /** The actual content data */
  content: Resource;
  /** Format of the content if known (e.g., 'png', 'mp3', 'pdf') */
  format?: string;
}

/**
 * Defines a tool that can be called by the AI system.
 * Tools extend the AI's capabilities by allowing it to interact with external systems.
 */
export interface ToolDefinition
{
  /** Tool name, must be unique within the request */
  name: string;
  /** Description of what the tool does */
  description?: string;
  /** Zod schema defining the tool's input parameters */
  parameters: z.ZodType<object>;
  /** Whether to require AI to strictly follow the schema. True by default. */
  strict?: boolean;
}

/**
 * Represents a tool invocation by the AI system.
 * The AI provides the tool name and arguments, which are then executed and results returned.
 */
export interface ToolCall
{
  /** Unique identifier for this tool call, used to match results back to the request */
  id: string;
  /** Name of the tool to call */
  name: string;
  /** The arguments for the tool call as a JSON string */
  arguments: string;
}

/**
 * Tool choice options.
 * 
 * - `auto`: Let the model decide whether to use a tool or not.
 * - `none`: Do not use any tools.
 * - `required`: Use a tool for this request.
 * - `{ tool: 'name' }`: Specify a particular tool to use by name.
 */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { tool: string };

/**
* Response format options.
* 
* - `text`: Plain text response.
* - `json`: JSON formatted response.
* - `z.ZodType<object, object>`: A Zod schema defining the expected response structure.
*/
export type ResponseFormat =
  | 'text'
  | 'json'
  | { type: z.ZodType<object, object>, strict: boolean };

/**
 * Statistics about usage for an AI request.
 * Structured to match ModelPricing for accurate cost calculation and usage tracking.
 * All token counts are specified per modality (text, audio, image, reasoning, embeddings).
 */
export interface Usage
{
  /** Text token usage (chat, completion, etc.) */
  text?: {
    /** Input tokens used (prompt) */
    input?: number;
    /** Output tokens used (completion) */
    output?: number;
    /** Cached tokens used, if applicable */
    cached?: number;
  };
  /** Audio usage */
  audio?: {
    /** Input tokens used (for audio processing) */
    input?: number;
    /** Output tokens used (for audio generation) */
    output?: number;
    /** Duration in seconds (for time-based pricing) */
    seconds?: number;
  };
  /** Image usage */
  image?: {
    /** Input tokens/images used (for image analysis) */
    input?: number;
    /** Output images generated */
    output?: {
      /** Quality level (e.g., 'low', 'medium', 'high', 'hd', 'standard') */
      quality: string;
      /** Image dimensions */
      size: { width: number; height: number; };
      /** Number of images at this quality/size */
      count: number;
    }[];
  };
  /** Reasoning token usage (for models with extended reasoning like o1) */
  reasoning?: {
    /** Input tokens used for reasoning */
    input?: number;
    /** Output reasoning tokens used */
    output?: number;
    /** Cached reasoning tokens, if applicable */
    cached?: number;
  };
  /** Embeddings usage */
  embeddings?: {
    /** Number of embeddings generated */
    count?: number;
    /** Total tokens processed for embeddings */
    tokens?: number;
  };
  /** Total cost of the request in dollars, if calculated */
  cost?: number;
}

/**
 * Effort level for reasoning-capable AI models.
 * Higher effort may produce better results but takes longer and uses more tokens.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Parameters for an AI request.
 * Configures the model's behavior, available tools, and output format.
 */
export interface Request extends BaseRequest
{
  /** Optional name to identify the request. Could be the component name. */
  name?: string;
  /** Messages in the conversation history */
  messages: Message[];
  /** Temperature setting for response generation (0.0 to 2.0, higher = more random) */
  temperature?: number;
  /** Maximum tokens for the output */
  maxTokens?: number;
  /** Nucleus sampling parameter (0.0 to 1.0) */
  topP?: number;
  /** Frequency penalty to reduce repetition (-2.0 to 2.0) */
  frequencyPenalty?: number;
  /** Presence penalty to encourage new topics (-2.0 to 2.0) */
  presencePenalty?: number;
  /** Stop sequences to end the response */
  stop?: string | string[];
  /** Whether to return log probabilities of the output tokens or not */
  logProbabilities?: boolean;
  /** Modify the likelihood of specified tokens appearing in the completion. */
  logitBias?: Record<string, number>;
  /** Tools available for this request */
  tools?: ToolDefinition[];
  /** Use tools one at a time instead of parallel execution */
  toolsOneAtATime?: boolean;
  /** Tool choice strategy for this request */
  toolChoice?: ToolChoice;
  /** The expected response format. Defaults to text. */
  responseFormat?: ResponseFormat;
  /** Reasoning configuration for reasoning-capable models */
  reason?: { effort?: ReasoningEffort, maxTokens?: number };
  /** A key that can help optimize cache hit rates */
  cacheKey?: string;
  /** Uniquely identifies the user */
  userKey?: string;
}

/**
 * Indicates why an AI response finished generating.
 *
 * - `stop`: Natural completion of the response
 * - `length`: Maximum token limit reached
 * - `tool_calls`: Model wants to call tools
 * - `content_filter`: Content was filtered by safety systems
 * - `refusal`: Model refused to respond
 */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'refusal';

/**
 * Information about an AI model.
 */
export interface Model 
{
  // Model unique identifier
  id: string;
  // Maximum context window size in tokens
  contextWindow?: number;
  // Maximum output tokens (if different from context window)
  maxOutputTokens?: number;
}

/**
 * Input type for specifying a model, either by ID or full Model object.
 */
export type ModelInput = string | Model;

/**
 * Base request for an AI operation.
 */
export interface BaseRequest
{
  // Optional model to use for this request
  model?: ModelInput;
  // Optional provider-specific configuration
  extra?: Record<string, any>;
}

/**
 * Base response from an AI request.
 */
export interface BaseResponse
{
  /** Usage statistics for this request **/
  usage?: Usage;
  /** Model used for this response **/
  model: ModelInput;
  /** Provider-specific extra response data **/
  extra?: Record<string, any>;
}

/**
 * Base chunk of a streaming AI response.
 */
export interface BaseChunk
{
  /** Usage statistics (sent at the end) */
  usage?: Usage;
  /** Model used for this chunk **/
  model?: ModelInput;
}

/**
 * Complete response from an AI request.
 * Contains the generated content, any tool calls, and metadata about the response.
 */
export interface Response extends BaseResponse
{
  /** The main text content of the response */
  content: string;
  /** Any tool calls requested by the model */
  toolCalls?: ToolCall[];
  /** Why the response finished generating */
  finishReason: FinishReason;
  /** Refusal reason if the model declined to respond */
  refusal?: string;
  /** Reasoning trace for reasoning-capable models */
  reasoning?: string;
}

/**
 * A chunk of a streaming AI response.
 * Chunks are sent incrementally as the model generates the response.
 *
 * Most fields are partial updates, except:
 * - `finishReason` is sent when the response is complete
 * - `toolCallNamed` is sent when a tool call name is fully received
 * - `toolCall` is sent when a tool call is fully received
 */
export interface Chunk extends BaseChunk
{
  /** Partial text content received */
  content?: string;
  /** Sent when a tool call name is fully received */
  toolCallNamed?: ToolCall;
  /** Sent as tool call arguments are being streamed */
  toolCallArguments?: ToolCall;
  /** Sent when a tool call is fully received */
  toolCall?: ToolCall;
  /** Sent when the response is finished */
  finishReason?: FinishReason;
  /** Partial refusal reason */
  refusal?: string;
  /** Partial reasoning trace */
  reasoning?: string;
}

/**
 * A status of an instance of a component.
 * 
 * - `pending` is the first status emitted immediately
 * - `running` is the status emitted once input has been evaluated and actual component execution is about to be ran. started is set at this time.
 * - `completed` is the status emitted on success, completed & output are set here.
 * - `failed` is the status emitted on complete failure, completed & error are set here.
 * - `interuppted` is the status emitted while it was running and an interrupt signal was sent, completed & error are set here.
 */
export type InstanceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

/**
 * An instance of a component execution.
 */
export interface Instance<C extends AnyComponent> 
{
  // The parent of this instance, if any
  parent?: Instance<AnyComponent>;
  // A unique identifier for this instance within a scope
  id: string;
  // The component being executed
  component: C;
  // The context for this instance
  context: ComponentContext<C>;
  // The input for this instance
  input: ComponentInput<C>;
  // The current status of this instance
  status: InstanceStatus;
  // Timestamps for tracking execution
  started?: number;
  // The time the instance started running
  running?: number;
  // The time the instance completed
  completed?: number;
  // Any error that occurred during execution
  error?: any;
  // The output of the instance, if completed successfully
  output?: Resolved<ComponentOutput<C>>;
  // Child instances, if any
  children?: Instance<ComponentRefs<C>>[];
}

/**
 * Events related to component instances.
 */
export interface Events<
  TRoot extends AnyComponent, 
  TNodes extends ComponentsAll<TRoot> = ComponentsAll<TRoot>
> {
  // An event when the status of a node changes
  onStatus?: (node: Instance<TNodes>) => void;
  // An event when a child instance is created
  onChild?: <N extends TNodes>(node: Instance<N>, child: Instance<ComponentRefs<N>>) => void;
  // An event when a prompt node generates a new prompt event
  onPromptEvent?: <N extends Extract<TNodes, AnyPrompt>>(instance: Instance<N>, event: PromptEvent<ComponentOutput<N>, ComponentRefs<N>>) => void;
}
