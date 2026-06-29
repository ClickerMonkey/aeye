# @aeye/core — Type model & utilities

The shared, provider-agnostic type model (`src/types.ts`) plus helper functions (`src/common.ts`) and Node resource helpers (`src/to.ts`). All re-exported from `@aeye/core`.

## Component interface

Every primitive implements `Component`:

```typescript
interface Component<TContext = {}, TMetadata = {}, TName extends string = string,
  TInput extends object = {}, TOutput = string,
  TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>> = []> {
  kind: string;                 // 'prompt' | 'tool' | 'agent' (or custom)
  name: TName;
  description: string;
  refs: TRefs;
  run(...[input, ctx]: OptionalParams<[TInput, Context<...>]>): TOutput;
  applicable(...[ctx]): Promise<boolean>;
  metadata(): TMetadata;
  metadata(input?, ctx?): TMetadata | Promise<TMetadata>;
}
```

Useful generic helpers exported alongside it: `AnyComponent`, `ComponentCompatible<C,M>`, `ComponentTuple`, and extractors `ComponentContext<C>`, `ComponentMetadata<C>`, `ComponentInput<C>`, `ComponentOutput<C>`, `ComponentRefs<C>`, `ComponentsAll<C>` (transitive refs), `Names<T>`. Type plumbing: `Tuple<T>` (`[] | [T, ...T[]]`), `Simplify`, `Extend`, `Plus`, `RequiredKeys`, `OptionalParams` (makes trailing params optional when they have no required keys — why `run()`/`get()` can be called with no args).

## Context

`Context<TContext, TMetadata>` = your `TContext` intersected with core execution fields:

```typescript
type Context<TContext, TMetadata> = TContext & {
  messages?: Message[];
  execute?: Executor<TContext, TMetadata>;
  stream?: Streamer<TContext, TMetadata>;
  signal?: AbortSignal;
  estimateUsage?: (message: Message) => Usage | undefined;
  maxOutputTokens?: number;     // reserve tokens for the model's output
  contextWindow?: number;       // override window size for trimming
  outputRetries?: number;       // default 2
  forgetRetries?: number;       // context-trim retries, default 1
  toolRetries?: number;         // default 2
  instance?: Instance<any>;     // current execution instance
  runner?: Runner;              // override how components execute (see withEvents)
  toolCallId?: string;          // set by the prompt loop before a tool's call()
};
```

`Executor` / `Streamer` are the functions you must supply to actually run a prompt:

```typescript
type Executor<TContext, TMetadata> =
  (request: Request, context, metadata?, signal?: AbortSignal) => Promise<Response>;

type Streamer<TContext, TMetadata> =
  (request: Request, context, metadata?, signal?: AbortSignal) => AsyncGenerator<Chunk, Response>;
```

## Messages & content

```typescript
type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

interface Message {
  role: MessageRole;
  content: string | MessageContent[];
  tokens?: number;          // used for automatic context trimming
  name?: string;
  toolCallId?: string;      // role: 'tool' — links result to a ToolCall
  toolCalls?: ToolCall[];   // role: 'assistant' — model wants to call tools
  refusal?: string;
  reasoning?: Reasoning;
  cache?: Record<string, any>;
}

interface MessageContent {           // type: 'text' | 'image' | 'file' | 'audio'
  type: MessageContentType;
  content: Resource;                 // string | URL | Blob | Uint8Array | stream | ...
  format?: string;                   // 'png', 'mp3', 'pdf', ...
}

interface ToolCall { id: string; name: string; arguments: string; } // arguments = JSON string
interface ToolDefinition {
  name: string; description?: string;
  parameters: z.ZodType<object>;     // raw Zod; strictify applied lazily by provider
  strict?: boolean | number;
  descriptor?: string;               // FormatDescriptor id chosen at request build time
}
```

## Request & Response

```typescript
interface Request extends BaseRequest {   // BaseRequest: { model?: ModelInput; extra?: ... }
  name?: string;
  messages: Message[];
  temperature?: number;           // 0.0–2.0
  maxTokens?: number;
  topP?: number;                  // 0.0–1.0
  frequencyPenalty?: number;      // -2.0–2.0
  presencePenalty?: number;       // -2.0–2.0
  stop?: string | string[];
  logProbabilities?: boolean;
  logitBias?: Record<string, number>;
  tools?: ToolDefinition[];
  toolsOneAtATime?: boolean;
  toolChoice?: ToolChoice;        // 'auto' | 'none' | 'required' | { tool: string }
  responseFormat?: ResponseFormat;// 'text' | 'json' | { type: ZodType, strict, descriptor? }
  reason?: { effort?: 'low'|'medium'|'high'; maxTokens?: number };
  cacheKey?: string;
  userKey?: string;
}

interface Response extends BaseResponse {  // BaseResponse: { usage?, model, extra? }
  content: string;
  toolCalls?: ToolCall[];
  finishReason: FinishReason;     // 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'refusal'
  refusal?: string;
  reasoning?: Reasoning;
}

interface Chunk extends BaseChunk {        // streaming delta
  content?: string;
  toolCallNamed?: ToolCall;       // name fully received
  toolCallArguments?: ToolCall;   // args streaming
  toolCall?: ToolCall;            // fully received
  finishReason?: FinishReason;
  refusal?: string;
  reasoning?: Reasoning;
}
```

## Usage

`Usage` mirrors model pricing for cost tracking — per-modality token counts (`text`, `audio`, `image`, `reasoning`, `embeddings`) plus an optional `cost` in dollars. See `src/types.ts` for the full shape.

## Instances & Events (lifecycle tracking)

```typescript
type InstanceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';

interface Instance<C extends AnyComponent> {
  parent?: Instance<AnyComponent>;
  id: string; component: C; context; input; status: InstanceStatus;
  started?; running?; completed?;       // timestamps (ms)
  error?; output?; children?: Instance<...>[];
}

interface Events<TRoot extends AnyComponent> {
  onStatus?: (node: Instance<...>) => void;
  onChild?: (node, child) => void;
  onPromptEvent?: (instance, event: PromptEvent<...>) => void;
}
```

A `Runner` wraps every component execution. Use `withEvents(events)` to build one:

```typescript
import { withEvents } from '@aeye/core';

const runner = withEvents({
  onStatus: (i) => console.log(`${i.component.name}: ${i.status}`),
  onPromptEvent: (_i, e) => { if (e.type === 'usage') console.log('tokens', e.usage); },
});

await prompt.get('result', { text: 'hi' }, { execute, messages: [], runner });
```

## `common.ts` utilities

- `resolveFn(fn, reprocess?)` — normalizes a `Fn<R, A>` (value | promise | function) into `(...args) => Promise<R>`. The pattern behind every `schema`/`config`/`input`/`*Fn` field.
- Usage helpers: `accumulateUsage(target, add)`, `getInputTokens`, `getOutputTokens`, `getTotalTokens`, `accumulateReasoning`, `getReasoningText`.
- Conversion helpers: `getModel(input)`, `getResponseFromChunks(chunks, model?)`, `getChunksFromResponse(response)`.
- Async helpers: `isPromise`, `isAsyncGenerator`, `isSettled`, `resolve`, `yieldAll`, `consumeAll`.
- `Fn<R, A>`, `FnResult`, `FnArgs`, `FnResolved`, `Resolved<T>` type helpers.

## `to.ts` resource helpers (Node only — excluded from the browser build)

`getResourceFormat`, `toURL`, `toBase64`, `toText`, `toStream`, `toReadableStream`, `toFile` — convert a `Resource` (string, URL, Blob, Uint8Array, stream, file path, …) to the form a provider needs. Import these only in Node contexts; the browser entry omits them.
