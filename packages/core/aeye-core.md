# @aeye/core

**Purpose:** Type-safe, composable primitives for building AI applications — `Prompt`, `Tool`, and `Agent` components, plus the shared type model (messages, requests, responses, usage). Tool arguments and prompt outputs are `@aeye/schema` (`a`) schemas, planned per request for the model they go to.

`@aeye/core` defines the *primitives and contracts*. It does **not** talk to any LLM provider itself. To actually run a prompt you supply an `execute` and/or `stream` function on the context — usually produced by `@aeye/ai` via `ai.buildCoreContext()`, or your own.

## When to use it

- You want provider-agnostic AI components (prompts, tools, agents) with full TypeScript inference.
- You need structured outputs validated by a schema, with automatic re-prompting (the model's own JSON, marked where it went wrong) on failure.
- You need native tool/function calling with configurable execution (sequential / parallel / immediate), retries, and iteration limits.
- You need one schema to be sent correctly to OpenAI / Anthropic / Google / xAI strict modes, and the answers decoded back to your code's shape.
- You are building a provider package or runtime (e.g. `@aeye/ai`) on top of the shared `Request`/`Response`/`Message` model.

If you just want to call models against configured providers with model selection and cost tracking, use `@aeye/ai` (which depends on this package).

## Installation & import

```bash
npm install @aeye/core @aeye/schema handlebars
```

```typescript
import { a, Prompt, Tool, Agent, withEvents } from '@aeye/core';   // `a` is @aeye/schema's builder
```

- Single entry point: `@aeye/core` (no subpath exports).
- There is a separate **browser** build (`./dist/browser.js`, auto-selected via the `browser` export condition) that excludes the Node-only resource helpers in `to.ts` (which depend on `fs`/`path`/`stream`). Everything else (`types`, `common`, `schema`, `tool`, `prompt`, `agent`) is available in both.
- Runtime deps: `@aeye/schema` (schemas) and `handlebars` (templates). `zod` remains only for the temporary bridge that accepts @aeye/gin / @aeye/query zod schemas (removed in step 2).

## Core concepts (read these first)

- **Component** — the common interface implemented by `Prompt`, `Tool`, and `Agent`: `{ kind, name, description, refs, run(), applicable(), metadata() }`.
- **`TContext` / `Context<TContext, TMetadata>`** — your app data (user, db, etc.) merged with core execution fields (`execute`, `stream`, `messages`, `signal`, retry counts, `runner`, …). Threaded through every call.
- **`TMetadata`** — execution settings (model, requirements) carried alongside the context.
- **Refs** — components a Tool/Agent depends on, passed positionally to `call`. Enables a typed component graph.
- **Schemas & requests** — one `a` schema, rendered per model; every request planned as a whole (strict slots, request totals, the tool cap) and never erroring.

## Documentation index

| File | Covers |
|------|--------|
| [`aeye-core-types.md`](./aeye-core-types.md) | The shared type model: `Component`, `Context`, `Message`, `Request`, `Response`, `Chunk`, `Usage`, `Executor`/`Streamer`, `Instance`/`Events`, plus `common.ts` utilities and `withEvents`. |
| [`aeye-core-prompts.md`](./aeye-core-prompts.md) | `Prompt` class, `PromptInput`, the `get()` modes, `PromptEvent` stream, tool execution, retries, reconfig, suspend/resume. |
| [`aeye-core-tools.md`](./aeye-core-tools.md) | `Tool` and `Agent` classes, `ToolInput`/`AgentInput`, `call`/`validate`/`applicable`, context-aware schemas, `ToolInterrupt`/`PromptSuspend`. |
| [`aeye-core-schema.md`](./aeye-core-schema.md) | Schemas on tools/prompts, the strict policy, `prepareRequest` / `sentTools` / `sentOutput`, the dispatcher, errors for the model (`errorFormat`), `{{encode}}` / `{{schema}}`, the zod bridge. |

## 60-second example

```typescript
import { Prompt } from '@aeye/core';

const summarizer = new Prompt({
  name: 'summarize',
  description: 'Summarizes text concisely',
  content: 'Summarize the following text:\n\n{{text}}',
  input: (input: { text: string }) => ({ text: input.text }),
  schema: a.object({
    summary: a.string().describe('A concise summary'),
    keyPoints: a.array(a.string()).describe('Main points'),
  }),
});

// `ctx` must carry an `execute` (and/or `stream`) function + messages.
const result = await summarizer.get(
  'result',
  { text: 'Long article text...' },
  { execute: yourAIExecutor, messages: [] },
);

console.log(result?.summary, result?.keyPoints);
```

## How it integrates with other @aeye packages

- **`@aeye/ai`** is the runtime. `await ai.buildCoreContext(requiredCtx)` returns a `Context` populated with `execute`, `stream`, and `estimateUsage`, ready to pass to any component's `run()`/`get()`. `ai.run(component, input, ctx)` builds the context and runs the component for you. `@aeye/ai` is also what enforces strict-mode model selection from the descriptors defined here.
- **Provider packages** implement against `Request`/`Response`/`Chunk`/`Message` from this package and plan each request for their model with `prepareRequest` (which pins the plan on `ToolDefinition.plan` / the response format, so the prompt decodes through it), then send `sentTools` / `sentOutput`.

## Key gotchas

- **`@aeye/core` cannot call a model on its own.** Without `execute`/`stream` on the context, a `Prompt` produces nothing. Tools and Agents run fine standalone via `.run()`.
- **`Prompt.get(mode, input?, ctx?)`** — modes `'result'` / `'tools'` return a `Promise`; `'stream'` / `'streamTools'` / `'streamContent'` return an `AsyncGenerator`. Default mode is `'result'`.
- **`schema` and many fields accept a function** `(input, ctx) => ...` for context-dependent behavior. Returning `false` from a Prompt `schema` disables structured output (plain text).
- **`strict` defaults to `1`** (prefer strict, allow lenient fallback), *not* `true`. Use `strict: true` only when strict is non-negotiable (it filters model selection in `@aeye/ai`).
- **Tool results are auto-paired** by default (`toolsComplete: true`) so providers don't reject unpaired `tool_calls`. `PromptSuspend` is the deliberate exception used for human-in-the-loop.
- The README at `packages/core/README.md` is the canonical narrative reference; full per-module API reference lives in `packages/docs/reference/core/`.
