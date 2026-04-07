# @aeye/core — Prompt

The `Prompt` class manages the full lifecycle of an AI interaction including template rendering, tool calling, output parsing, and retries.

## Constructor

```typescript
new Prompt<TContext, TMetadata, TName, TInput, TOutput, TTools>(input: PromptInput)
```

See [Prompts component page](/components/prompts) for the full `PromptInput` configuration reference.

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'prompt'` | Component kind |
| `name` | `TName` | Prompt name |
| `description` | `string` | Prompt description |
| `refs` | `TTools` | Tool components |
| `input` | `PromptInput` | Full configuration |

## Methods

### `get(mode?, input?, ctx?)`

Convenient method to get output in various modes:

```typescript
// Get structured result (waits for completion)
const result = await prompt.get('result', input, ctx);

// Get tool outputs
const tools = await prompt.get('tools', input, ctx);

// Stream all events
const stream = await prompt.get('stream', input, ctx);

// Stream tool events only
const toolStream = await prompt.get('streamTools', input, ctx);

// Stream text content only
const textStream = await prompt.get('streamContent', input, ctx);
```

#### Get Types

| Mode | Return Type | Description |
|------|-------------|-------------|
| `'result'` | `Promise<TOutput \| undefined>` | Parsed structured output |
| `'tools'` | `Promise<PromptToolOutput[]>` | Array of tool results |
| `'stream'` | `AsyncGenerator<PromptEvent>` | All events |
| `'streamTools'` | `AsyncGenerator<PromptToolEvent>` | Tool events only |
| `'streamContent'` | `AsyncGenerator<string>` | Text chunks only |

### `run(input?, ctx?)`

Execute and stream all events:

```typescript
for await (const event of prompt.run(input, ctx)) {
  // handle events
}
```

### `applicable(ctx?)`

Check if the prompt is available in the given context.

### `metadata(input?, ctx?)`

Get prompt metadata.

## Events {#events}

Events emitted during `run()` / `get('stream')`:

| Event | Value Type | Description |
|-------|-----------|-------------|
| `request` | `Request` | AI request about to be sent |
| `textPartial` | `string` | Text chunk from streaming |
| `text` | `string` | Complete text for this iteration |
| `textComplete` | `string` | All accumulated text |
| `textReset` | `string` | Text reset (error/retry) |
| `refusal` | `string` | Model refusal message |
| `reason` | `Reasoning` | Complete reasoning trace |
| `reasonPartial` | `Reasoning` | Reasoning chunk |
| `toolParseName` | `{ id, name }` | Tool name parsed |
| `toolParseArguments` | `{ id, name, args }` | Tool args streaming |
| `toolStart` | `{ name, input }` | Tool execution starting |
| `toolOutput` | `{ tool, result }` | Tool completed |
| `toolInterrupt` | `{ tool, message }` | Tool interrupted |
| `toolSuspend` | `{ tool, message }` | Tool suspended prompt |
| `toolError` | `{ tool, error }` | Tool failed |
| `message` | `Message` | Message added |
| `complete` | `TOutput` | Final output |
| `suspend` | `string` | Prompt suspended |
| `requestUsage` | `Usage` | Usage for this request |
| `responseTokens` | `number` | Output token count |
| `usage` | `Usage` | Final accumulated usage |

## Iteration Budget

```
maxIterations = outputRetries + forgetRetries + toolIterations + toolRetries + 1
```

Defaults: `2 + 1 + 3 + 2 + 1 = 9`

## Reconfiguration

The `reconfig` callback receives `PromptReconfigInput`:

```typescript
interface PromptReconfigInput {
  iteration: number;
  maxIterations: number;
  toolParseErrors: number;
  toolCallErrors: number;
  toolSuccesses: number;
  toolRetries: number;
  outputRetries: number;
  forgetRetries: number;
  tools: Set<string>;
}
```

And can return `PromptReconfig`:

```typescript
interface PromptReconfig {
  config?: Partial<Request>;
  maxIterations?: number;  // 0 = stop immediately, >0 = iterations from now
  toolRetries?: number;
  outputRetries?: number;
  forgetRetries?: number;
}
```
