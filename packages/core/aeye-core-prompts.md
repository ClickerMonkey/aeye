# @aeye/core — Prompt

`Prompt` (`src/prompt.ts`) generates an AI response from a Handlebars-templated message, optionally calls tools in a loop, and validates structured output against a Zod schema with automatic re-prompting.

```typescript
class Prompt<TContext = {}, TMetadata = {}, TName extends string = string,
  TInput extends object = {}, TOutput extends object | string = string,
  TTools extends Tuple<ToolCompatible<TContext, TMetadata>> = [],
  TDecoded extends unknown = TOutput>
  implements Component<...>
```

`TDecoded` is the decoded type a custom `parse` produces from the model's structured output — **any** value (a built AST/class instance, a number, an array, …), not just an object or string; it types `validate` and the decoded output. It defaults to the wire `TOutput` when no custom `parse` is supplied — `schema` always stays the wire type.

A `Prompt` only does real work when the context supplies `execute` and/or `stream` (see [types doc](./aeye-core-types.md)). Without them, get/run yields nothing.

## `PromptInput` (constructor config)

| Field | Type | Notes |
|------|------|-------|
| `name` | `string` | Unique identifier. |
| `description` | `string` | Informational. |
| `content` | `string` | Handlebars template. `{{tools}}` is auto-appended (wrapped in `<tools>`) when tools exist and you didn't include it. |
| `input?` | `Fn<Record<string,any>, [TInput?, ctx]>` | Maps raw input → template variables. |
| `schema?` | `Fn<ZodType<TOutput> \| false, [TInput?, ctx]>` | Output schema. `false` → plain-text output. Omitted → text. |
| `parse?` | `(raw, ctx) => TDecoded \| Error \| Promise<…>` | **Custom output parser that REPLACES Zod.** Receives the raw `JSON.parse`-d structured value and fully owns turning it into the decoded `TDecoded`; return (or throw) an `Error` to reject it — routed through the same `outputRetries` channel a Zod failure would, surfacing the error's own `.message` (no Zod vocabulary, since Zod never runs). Lets a caller (e.g. `@aeye/query`'s parser) return a built AST plus compiler-style diagnostics. Only runs where Zod validation runs today (a structured, non-`ZodString` `schema` is present); `schema` is still required and still drives the model wire format. Absent ⇒ unchanged Zod path. |
| `strict?` | `boolean \| number` | Strict-mode policy, default `1`. See [schema doc](./aeye-core-schema.md). |
| `config?` | `Fn<Partial<Request> \| false, [TInput?, ctx]>` | Per-request overrides (temperature, model, toolChoice, …). `false` ⇒ prompt not compatible. |
| `reconfig?` | `(stats: PromptReconfigInput, ctx) => PromptReconfig` | Adapt config after each iteration based on runtime stats. |
| `tools?` | `TTools` | Tools the model may call. |
| `toolExecution?` | `'sequential' \| 'parallel' \| 'immediate'` | Default `immediate`. |
| `toolRetries?` | `number` | Retry failed tool calls. Default 2. |
| `toolIterations?` | `number` | Max tool-calling loop iterations. Default 3. |
| `toolsMax?` | `number` | Stop sending tools after this many successes. |
| `toolsOnly?` | `boolean` | Only call tools, don't generate text. |
| `toolsComplete?` | `boolean` | Auto-synthesize tool results for unpaired `tool_calls` (abort/interrupt). Default `true`. |
| `outputRetries?` | `number` | Retries to get valid structured output. Defaults to ctx (2). |
| `forgetRetries?` | `number` | Context-trimming retries. Defaults to ctx (1). |
| `validationErrorMaxLength?` | `number` | Truncate validation errors fed back to the model. Default 4096. |
| `retool?` | `Fn<RetoolResult, [TInput?, ctx]>` | Dynamically select tools (by name or object), or `false` if incompatible. |
| `dynamic?` | `boolean` | Re-resolve input/content/config/schema/tools each iteration; `undefined` ends the loop. |
| `excludeMessages?` | `boolean` | Don't include `ctx.messages` when rendering. |
| `onToolResult?` | `(event: ToolResultEvent<TContext, TMetadata, TTools>) => unknown \| Promise<unknown>` | Intercept each tool's **success** result before the model sees it; the return value is what's presented (serialized like any tool result). Model-facing only. See [Tool result transformer](#tool-result-transformer). |
| `metadata?` / `metadataFn?` | `TMetadata` / fn | Execution metadata (model, requirements). |
| `validate?` | `(output, ctx) => void \| Promise<void>` | Post-parse hook; throw to re-prompt. |
| `applicable?` | `(ctx) => boolean \| Promise<boolean>` | Availability check. |

`PromptReconfigInput` stats include: `iteration`, `maxIterations`, `toolParseErrors`, `toolCallErrors`, `tools` (names), `toolSuccesses`, and remaining `toolRetries` / `outputRetries` / `forgetRetries`. `PromptReconfig` lets you return `{ config?, maxIterations?, toolRetries?, outputRetries?, forgetRetries? }`.

## Methods

```typescript
get(mode?: PromptGetType, input?: TInput, ctx?: Context): PromptGet<mode, TOutput, TTools>
run(input?: TInput, ctx?: Context): AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined>
applicable(ctx?: Context): Promise<boolean>
metadata(input?, ctx?): TMetadata | Promise<TMetadata>
```

### `get()` modes

| Mode (default `'result'`) | Returns |
|------|---------|
| `'result'` | `Promise<TOutput \| undefined>` — final structured output |
| `'tools'` | `Promise<PromptToolOutput<TTools>[] \| undefined>` — `{ tool, result }[]` |
| `'stream'` | `AsyncGenerator<PromptEvent, TOutput \| undefined>` — all events |
| `'streamTools'` | `AsyncGenerator<PromptToolOutput, TOutput \| undefined>` |
| `'streamContent'` | `AsyncGenerator<string, TOutput \| undefined>` — text deltas only |

`run()` is equivalent to `get('stream', …)`.

```typescript
// Structured result
const r = await prompt.get('result', { text: 'hi' }, { execute, messages: [] });

// Stream text deltas
for await (const chunk of prompt.get('streamContent', { text: 'hi' }, { stream, messages: [] })) {
  process.stdout.write(chunk);
}

// Stream all events
for await (const e of prompt.get('stream', { text: 'hi' }, { stream, messages: [] })) {
  if (e.type === 'textPartial') process.stdout.write(e.content);
  else if (e.type === 'toolStart') console.log('tool:', e.tool.name);
  else if (e.type === 'toolOutput') console.log('result:', e.result);
  else if (e.type === 'complete') console.log('output:', e.output);
}
```

## `PromptEvent` union

Every event carries `request: Request`. Types:

- `request` (`+ iterations`), `textPartial`, `text`, `textComplete`, `textReset` (`+ reason?`)
- `refusal`, `reason` / `reasonPartial` (reasoning trace)
- `toolParseName`, `toolParseArguments` (`+ args`), `toolArgRepairAttempt` (`+ fields, success`)
- tool lifecycle: `toolStart`, `toolOutput` (`+ result` raw, `+ toModel` presented value), `toolInterrupt`, `toolSuspend`, `toolError` (`+ error, rawArgs?`) — each carries `tool` + `args`
- `message` (`+ message`), `suspend`, `complete` (`+ output`)
- `requestUsage`, `responseTokens`, `usage` (`+ usage`)

## Prompt with tools

```typescript
const advisor = new Prompt({
  name: 'travelAdvisor',
  description: 'Plans a trip',
  content: 'Plan a trip to {{destination}}. Use getWeather to check conditions.',
  input: (i: { destination: string }) => ({ destination: i.destination }),
  tools: [getWeather],                 // see aeye-core-tools.md
  toolExecution: 'parallel',
  toolIterations: 3,
  schema: z.object({
    recommendations: z.array(z.string()),
    packingList: z.array(z.string()),
  }),
});

const advice = await advisor.get('result', { destination: 'Paris' }, { execute, messages: [] });
```

## Tool result transformer

`onToolResult` intercepts each tool's **successful** result *before* it's handed to the model and returns what the model sees instead. It's fully type-safe: `event` is a discriminated union over the prompt's tools, so **narrowing on `event.tool` types both `event.result` and `event.args`** for that tool. The default (unmatched) branch is the catch-all.

```typescript
const prompt = new Prompt({
  name: 'searcher',
  description: 'Searches and answers',
  content: 'Answer using search.',
  tools: [searchTool, mathTool],       // searchTool → { hits, ids }, mathTool → number
  onToolResult: (event) => {
    if (event.tool === 'search') {
      // event.result is the search result; event.args is { query }
      return `Found ${event.result.hits} hits for "${event.args.query}"`;
    }
    // catch-all: here event is the `math` member (event.result: number)
    return event.result;              // pass-through
  },
});
```

- **The return value is what's presented.** It's serialized exactly like an untransformed result — a `string` is used verbatim, anything else is `JSON.stringify`-d — into the `role: 'tool'` message. To pass through unchanged, `return event.result`.
- **Model-facing only.** `get('tools')`, `streamTools`, and the `toolOutput` event's `result` field always report the RAW result. The presented value is additionally exposed on the `toolOutput` event as `toModel` (equal to `result` when no handler is set).
- **v1 = success results only.** Errored / suspended / interrupted / synthetic (`toolsComplete`) tool slots BYPASS the handler and keep their existing content. (A future v2 could add a `status: 'success' | 'error'` discriminant so handlers can transform errors too.)
- **A handler that throws** is treated as a tool error for that slot — the model sees the error content — so the `tool_call` ↔ `role: 'tool'` pairing guarantee still holds. The raw result stays available on `get('tools')`/`streamTools`.
- `async` handlers are awaited.

Compile-time safety: referencing a non-existent tool name, or accessing a field not on the narrowed tool's `result`/`args`, fails to compile.

## Token / context-window management

When the rendered messages plus reserved output tokens exceed the window, the prompt trims older messages and retries (`forgetRetries`). Supply `estimateUsage` for accuracy:

```typescript
await prompt.get('result', { text }, {
  execute, messages: history,
  maxOutputTokens: 2048,
  estimateUsage: (m) => ({ text: { input: Math.ceil(String(m.content).length / 4) } }),
});
```

## Suspend / resume (human-in-the-loop)

A tool can `throw new PromptSuspend(...)` to stop the loop *without* writing a tool result. The caller receives a `suspend` event whose `request.messages` includes the assistant message with the pending tool call. Persist those messages, do the external work (approval, etc.), append the `role: 'tool'` result message, then re-run the prompt with the combined messages as `ctx.messages`. `PromptSuspend` is never auto-paired even with `toolsComplete: true`.

## Gotchas

- Default `get` mode is `'result'`; pass the mode explicitly when streaming.
- `schema` returning `false` disables structured output — output is the raw text string.
- `config`/`retool` returning `false` marks the prompt incompatible with the context.
- `toolsMax` is a soft cap unless `toolsOneAtATime` (request flag) is set — it stops *offering* tools after the threshold.
- Validation errors (Zod / JSON / `validate`) are truncated to `validationErrorMaxLength` before being shown to the model.
