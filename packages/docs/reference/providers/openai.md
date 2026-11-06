# @aeye/openai — API Reference

## `OpenAIProvider`

```typescript
class OpenAIProvider<TConfig extends OpenAIConfig = OpenAIConfig>
  implements Provider<TConfig>
```

Requires Node >= 22 and the `openai` SDK v7.

### Constructor

```typescript
new OpenAIProvider(config: OpenAIConfig)
```

### `OpenAIConfig`

```typescript
interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  store?: boolean;
  api?: 'auto' | 'chat' | 'responses'; // default 'auto'
  retry?: RetryConfig;
  retryEvents?: RetryEvents;
  defaultModels?: {
    chat?: ModelInput;
    imageGenerate?: ModelInput;   // default 'gpt-image-2'
    imageEdit?: ModelInput;       // default 'gpt-image-2'
    imageAnalyze?: ModelInput;    // default 'gpt-5.4-mini'
    transcription?: ModelInput;   // default 'gpt-transcribe'
    speech?: ModelInput;          // default 'gpt-4o-mini-tts'
    embedding?: ModelInput;       // default 'text-embedding-3-small'
    decision?: ModelInput;        // default 'gpt-6-luna'
    rerank?: ModelInput;          // no default; used by subclasses with a /rerank endpoint (OpenRouter)
  };
  hooks?: OpenAIHooks;
}
```

With `api: 'auto'`, chat uses Chat Completions unless the model is Responses-only (`metadata.responsesOnly` in its registry entry, or by id: codex, pre-5.6 pro, deep-research, computer-use), the request has `hostedTools`, a tool sets `format`, `defer`, or `async`, `reason` sets `mode`, `summary`, or `context`, or the request has tools and a reasoning `effort` other than `none`; then it uses the Responses API.

Subclasses can override the protected `defaults` property to supply their own default model ids.

### `RetryConfig`

```typescript
interface RetryConfig {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
  retryableStatuses?: number[];
  timeout?: number;
}
```

### `OpenAIHooks`

```typescript
type OpenAIHooks = {
  [K in keyof OpenAIOperations]?: {
    beforeRequest?: (request, params, ctx, metadata) => void;
    afterRequest?: (request, params, response, ctx, metadata) => void;
    onError?: (request, params, error, ctx, metadata) => void;
  };
};
// Operations: chat, responses, imageGenerate, imageEdit, transcribe, speech, embed, rerank, decide
```

Image analysis runs as chat, so it reports through the `chat` (or `responses`) hooks. OpenAI itself has no rerank endpoint; the `rerank` hooks (with `RerankParams`: `model`, `query`, `documents`, `top_n`) serve OpenAI-compatible subclasses such as `OpenRouterProvider`.

### Extending

| Protected member | Purpose |
|---|---|
| `chatHeaders(params)` | Extra HTTP headers for a Chat Completions request; none by default (`OpenRouterProvider` adds `x-anthropic-beta` for strict tools) |
| `send(op, run, request, params, call)` | Runs an API call with retries inside the operation's `beforeRequest` / `onError` hooks; a context-window rejection becomes `ContextWindowError` |
| `finish(op, run, request, params, response)` | Reports a response to the operation's `afterRequest` hook and returns it |

### Decisions and Batches

| Method | Calls |
|---|---|
| `decide(request, ctx, config?)` | `POST /v1/decisions` (`decide` hooks) |
| `submitBatch(requests, ctx, config?)` | uploads JSONL to `/v1/files`, then `POST /v1/batches` with `completion_window: '24h'` |
| `getBatch(job, ctx, config?)` | `GET /v1/batches/{id}`, then the output and error files once complete |

Subclasses can override the protected `createBatch(batch, run)` and `retrieveBatch(job, run)` to submit and read batches another way, and reuse `batchResults(lines, total, run)` to map result lines (`BatchOutputLine`) to `BatchResult`s in request order. `BatchSubmission` and `BatchOutputLine` are exported for this; `OpenRouterProvider` uses them for its inline batches.

The Decisions API wire types (`OpenAIDecisionQuestion`, `OpenAIDecisionAnswer`, `OpenAIDecisionParams`, `OpenAIDecision`) live in `src/decisions.ts` and are not exported. The System One shape OpenRouter's decisions endpoint speaks is exported: `SystemOneDecisionParams` (`model`, `state`, `questions` by name), `SystemOneQuestion`, and `toSystemOneQuestion(question)` (a predicate becomes a `noul` question; choices and levels become `criteria`).

### Tools

- `toolChoice: { allowed, required? }` is sent as `allowed_tools` on Chat Completions and Responses.
- Tools with `format` become Responses custom tools (`{ type: 'custom', format }`); on Chat Completions a grammar tool is a one-field function whose description carries the grammar.
- `defer` sets `defer_loading` and adds the hosted `tool_search` tool; `async` sets the tool's `async` flag.
- `toolsOneAtATime` sends `parallel_tool_calls: false`; otherwise Chat Completions omits the parameter (o3 rejects it), and Responses sends `true` with any tools.
- An assistant turn of only tool calls goes with no content (`content: null` on Chat Completions), not an empty text part.

### Reasoning replay

Responses reasoning is returned with `reasoning.provider` set to the provider's `name`, and replayed as `reasoning` input items only when the assistant message's reasoning names this provider or none (`replaysTo` from `@aeye/core`).

## Error Types

| Class | Description |
|-------|-------------|
| `ProviderError` | Base provider error |
| `ProviderAuthError` | Authentication failure |
| `RateLimitError` | Rate limit exceeded |
| `ProviderRateLimitError` | Provider-specific rate limit |
| `ProviderQuotaError` | Account quota exceeded |
| `ContextWindowError` | Input exceeds context window |
