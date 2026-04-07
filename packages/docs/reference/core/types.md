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
}

type MessageContentType = 'text' | 'image' | 'file' | 'audio';
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
  stop?: string[];
  logProbabilities?: boolean;
  logitBias?: Record<string, number>;
  tools?: ToolDefinition[];
  toolsOneAtATime?: boolean;
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  reason?: ReasoningEffort;
  cacheKey?: string;
  userKey?: string;
}
```

### `Response`

```typescript
interface Response {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: FinishReason;
  refusal?: string;
  reasoning?: Reasoning;
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

### `ReasoningEffort`

```typescript
type ReasoningEffort = 'low' | 'medium' | 'high';
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
  text?: { input?: number; output?: number; cached?: number };
  audio?: { input?: number; output?: number; seconds?: number };
  image?: { input?: number; output?: ImageOutputUsage[] };
  reasoning?: { input?: number; output?: number; cached?: number };
  embeddings?: { count?: number; tokens?: number };
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
