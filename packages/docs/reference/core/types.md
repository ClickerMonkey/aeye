# @aeye/core — Types

Core types used throughout the @aeye library.

## Message Types

### `Message`

A conversation message.

```typescript
interface Message {
  role: MessageRole;
  content: string | MessageContent[];
  name?: string;
  tokens?: number;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  refusal?: string;
  reasoning?: Reasoning;
  cache?: boolean;
}
```

### `MessageRole`

```typescript
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
```

### `MessageContent`

```typescript
interface MessageContent {
  type: MessageContentType;
  content: Resource;
  format?: string;
  name?: string;              // file name shown to the model
  detail?: ContentDetail;     // how closely to look at image/file content
  cacheBreakpoint?: boolean;  // end of a reusable prefix the provider should cache
}

type MessageContentType = 'text' | 'image' | 'file' | 'audio' | 'video';
type ContentDetail = 'auto' | 'low' | 'high' | 'original';
```

### `Resource`

A flexible type for content that can be provided in many formats:

```typescript
type Resource =
  | string                    // text, URL, or base64 data URI
  | AsyncIterable<Uint8Array> // stream
  | Blob | Uint8Array | URL
  | ArrayBuffer | DataView | Buffer
  | { blob(): Blob }
  | { url(): string }
  | { read(): AsyncIterable<Uint8Array> };
```

## Request / Response

### `Request`

```typescript
interface Request {
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
  reason?: Reason;
  cacheKey?: string;
  userKey?: string;
  seed?: number;                      // repeatable sampling, where supported
  verbosity?: Verbosity;              // 'low' | 'medium' | 'high'
  serviceTier?: ServiceTier;          // 'auto' | 'default' | 'flex' | 'fast' | 'scale'
  metadata?: Record<string, string>;  // tags the provider stores with the request
  modalities?: OutputModality[];      // 'text' | 'image' | 'audio'; text only by default
  audio?: AudioOutput;                // { voice, format? } when modalities includes audio
  hostedTools?: HostedTool[];         // tools the provider runs itself
  moderate?: boolean;                 // run the provider's moderation over input and output
}
```

### `HostedTool`

A tool the provider runs itself. Providers that can't run a given type reject the request.

```typescript
type HostedTool =
  | { type: 'web_search'; maxResults?: number; allowedDomains?: string[]; blockedDomains?: string[] }
  | { type: 'web_fetch' }
  | { type: 'file_search'; vectorStoreIds: string[]; maxResults?: number }
  | { type: 'code_interpreter' }
  | { type: 'image_generation' }
  | { type: 'mcp'; label: string; url: string; headers?: Record<string, string>; allowedTools?: string[] };
```

### `Response`

```typescript
interface Response {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: FinishReason;
  refusal?: string;
  reasoning?: Reasoning;
  citations?: Citation[];       // { url, title?, start?, end? }
  images?: GeneratedImage[];    // { url?, b64_json?, revisedPrompt? }
  audio?: GeneratedAudio;       // { id?, data?, transcript?, format? }
  moderation?: Moderation;      // { input?, output? }: { flagged, categories }
  serviceTier?: ServiceTier;
  usage?: Usage;
  model?: Model;
}
```

### `Chunk`

A streaming response fragment:

```typescript
interface Chunk {
  content?: string;
  toolCallNamed?: { id: string; name: string; arguments: string };
  toolCallArguments?: { id: string; name: string; arguments: string };
  toolCall?: ToolCall;
  finishReason?: FinishReason;
  refusal?: string;
  reasoning?: Reasoning;
  citations?: Citation[];
  images?: GeneratedImage[];    // completed images
  audio?: GeneratedAudio;       // partial audio, concatenated in order
  moderation?: Moderation;
  serviceTier?: ServiceTier;
  usage?: Usage;
  model?: Model;
}
```

### `FinishReason`

```typescript
type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'refusal';
```

### `ResponseFormat`

```typescript
type ResponseFormat = 'text' | 'json' | { type: z.ZodType; strict: boolean };
```

### `ReasoningEffort` / `Reason`

```typescript
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ReasoningEffort = typeof REASONING_EFFORTS[number];

interface Reason {
  effort?: ReasoningEffort;
  maxTokens?: number;                                // budget, for budget-based providers
  mode?: 'pro';                                      // more compute on the same model
  context?: 'auto' | 'all_turns' | 'current_turn';   // keep earlier turns' reasoning
  summary?: 'auto' | 'concise' | 'detailed';         // readable reasoning summary
  exclude?: boolean;                                 // reason without returning it
}
```

## Tool Types

### `ToolDefinition`

Schema sent to AI models:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: z.ZodType;
  strict?: boolean;
}
```

### `ToolCall`

Returned by the model when it wants to call a tool:

```typescript
interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}
```

### `ToolChoice`

```typescript
type ToolChoice = 'auto' | 'none' | 'required' | { tool: string };
```

## Usage

### `Usage`

```typescript
interface Usage {
  text?: { input?: number; output?: number; cached?: number; cacheWrite?: number };
  audio?: { input?: number; output?: number; seconds?: number };
  image?: { input?: number; tokens?: number; output?: ImageOutputUsage[] };
  reasoning?: { input?: number; output?: number; cached?: number };
  embeddings?: { count?: number; tokens?: number };
  tools?: Partial<Record<HostedToolType, number>>; // hosted tool calls by type
  cost?: number;
}
```

## Reasoning

### `Reasoning`

```typescript
interface Reasoning {
  content?: string;
  details?: ReasoningDetail[];
}
```

### `ReasoningDetail`

```typescript
interface ReasoningDetail {
  id?: string;
  type: string;
  format: string;
  index?: number;
  summary?: string;
  text?: string;
  data?: string;
  signature?: string;
}
```

## Execution Types

### `Executor`

Non-streaming execution function:

```typescript
type Executor<TContext, TMetadata> = (
  request: Request,
  ctx: Partial<Context<TContext, TMetadata>>,
  model: Model
) => Promise<Response>;
```

### `Streamer`

Streaming execution function:

```typescript
type Streamer<TContext, TMetadata> = (
  request: Request,
  ctx: Partial<Context<TContext, TMetadata>>,
  model: Model
) => AsyncGenerator<Chunk, Response | undefined>;
```

### `Model`

```typescript
interface Model {
  id: string;
  contextWindow: number;
  maxOutputTokens: number;
}
```

### `ModelInput`

```typescript
type ModelInput = string | Model;
```

## Component Types

### `Component`

Base interface for all components:

```typescript
interface Component<TContext, TMetadata, TName, TInput, TOutput, TRefs> {
  kind: 'tool' | 'prompt' | 'agent';
  name: TName;
  description: string;
  refs: TRefs;
  run(...[input, ctx]): TOutput;
  applicable?(...[ctx]): Promise<boolean>;
  metadata?(input?, ctx?): TMetadata | Promise<TMetadata>;
}
```

### Type Extraction

```typescript
type ComponentContext<C>  // Extract TContext from a Component
type ComponentMetadata<C> // Extract TMetadata
type ComponentInput<C>    // Extract TInput
type ComponentOutput<C>   // Extract TOutput
type ComponentRefs<C>     // Extract TRefs
type AnyComponent         // Component<any, any, any, any, any, any>
```

## Instance Types

### `Instance`

Tracks component execution:

```typescript
interface Instance<C extends AnyComponent> {
  parent?: Instance<AnyComponent>;
  id: string;
  component: C;
  context: any;
  input: any;
  status: InstanceStatus;
  started?: number;
  running?: number;
  completed?: number;
  error?: string;
  output?: any;
  children: Instance<AnyComponent>[];
}

type InstanceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
```

### `Events`

```typescript
interface Events<TRoot, TNodes> {
  onStatus?: (instance: Instance<TNodes>) => void;
  onChild?: (parent: Instance<TNodes>, child: Instance<TNodes>) => void;
  onPromptEvent?: (instance: Instance<AnyPrompt>, event: PromptEvent) => void;
}
```
