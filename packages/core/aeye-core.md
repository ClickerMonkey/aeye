# @aeye/core

**Purpose:** Type-safe, composable primitives for building AI applications — `Prompt`, `Tool`, and `Agent` components, plus the shared type model (messages, requests, responses, usage) and a Zod→JSON-Schema layer that handles per-provider strict-mode dialects.

`@aeye/core` defines the *primitives and contracts*. It does **not** talk to any LLM provider itself. To actually run a prompt you supply an `execute` and/or `stream` function on the context — usually produced by `@aeye/ai` via `ai.buildCoreContext()`, or your own.

## When to use it

- You want provider-agnostic AI components (prompts, tools, agents) with full TypeScript inference.
- You need structured outputs validated by Zod, with automatic re-prompting on validation failure.
- You need native tool/function calling with configurable execution (sequential / parallel / immediate), retries, and iteration limits.
- You need a single Zod schema to emit correct JSON Schema for OpenAI / Anthropic / Google strict modes.
- You are building a provider package or runtime (e.g. `@aeye/ai`) on top of the shared `Request`/`Response`/`Message` model.

If you just want to call models against configured providers with model selection and cost tracking, use `@aeye/ai` (which depends on this package).

## Installation & import

```bash
npm install @aeye/core zod handlebars
```

```typescript
import { Prompt, Tool, Agent, withEvents } from '@aeye/core';
import z from 'zod';
```

- Single entry point: `@aeye/core` (no subpath exports).
- There is a separate **browser** build (`./dist/browser.js`, auto-selected via the `browser` export condition) that excludes the Node-only resource helpers in `to.ts` (which depend on `fs`/`path`/`stream`). Everything else (`types`, `common`, `schema`, `tool`, `prompt`, `agent`) is available in both.
- `peerDependencies` in practice: `zod` (^4) and `handlebars` (^4) are runtime deps used for schemas and prompt templates.

## Core concepts (read these first)

- **Component** — the common interface implemented by `Prompt`, `Tool`, and `Agent`: `{ kind, name, description, refs, run(), applicable(), metadata() }`.
- **`TContext` / `Context<TContext, TMetadata>`** — your app data (user, db, etc.) merged with core execution fields (`execute`, `stream`, `messages`, `signal`, retry counts, `runner`, …). Threaded through every call.
- **`TMetadata`** — execution settings (model, requirements) carried alongside the context.
- **Refs** — components a Tool/Agent depends on, passed positionally to `call`. Enables a typed component graph.
- **Strict mode / FormatDescriptor** — one Zod schema, many provider JSON-Schema dialects.

## Documentation index

| File | Covers |
|------|--------|
| [`aeye-core-types.md`](./aeye-core-types.md) | The shared type model: `Component`, `Context`, `Message`, `Request`, `Response`, `Chunk`, `Usage`, `Executor`/`Streamer`, `Instance`/`Events`, plus `common.ts` utilities and `withEvents`. |
| [`aeye-core-prompts.md`](./aeye-core-prompts.md) | `Prompt` class, `PromptInput`, the `get()` modes, `PromptEvent` stream, tool execution, retries, reconfig, suspend/resume. |
| [`aeye-core-tools.md`](./aeye-core-tools.md) | `Tool` and `Agent` classes, `ToolInput`/`AgentInput`, `call`/`validate`/`applicable`, context-aware schemas, `ToolInterrupt`/`PromptSuspend`. |
| [`aeye-core-schema.md`](./aeye-core-schema.md) | Strict mode: `FormatDescriptor`, `toJSONSchema`, `strictify`, `registerDescriptor`, the built-in descriptors, `SchemaBudget`, `analyzeSchema`. |

## 60-second example

```typescript
import { Prompt } from '@aeye/core';
import z from 'zod';

const summarizer = new Prompt({
  name: 'summarize',
  description: 'Summarizes text concisely',
  content: 'Summarize the following text:\n\n{{text}}',
  input: (input: { text: string }) => ({ text: input.text }),
  schema: z.object({
    summary: z.string().describe('A concise summary'),
    keyPoints: z.array(z.string()).describe('Main points'),
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
- **Provider packages** implement against `Request`/`Response`/`Chunk`/`Message` from this package and choose a `FormatDescriptor` per request (pinning its `id` on `request.responseFormat.descriptor` / `ToolDefinition.descriptor`).

## Key gotchas

- **`@aeye/core` cannot call a model on its own.** Without `execute`/`stream` on the context, a `Prompt` produces nothing. Tools and Agents run fine standalone via `.run()`.
- **`Prompt.get(mode, input?, ctx?)`** — modes `'result'` / `'tools'` return a `Promise`; `'stream'` / `'streamTools'` / `'streamContent'` return an `AsyncGenerator`. Default mode is `'result'`.
- **`schema` and many fields accept a function** `(input, ctx) => ...` for context-dependent behavior. Returning `false` from a Prompt `schema` disables structured output (plain text).
- **`strict` defaults to `1`** (prefer strict, allow lenient fallback), *not* `true`. Use `strict: true` only when strict is non-negotiable (it filters model selection in `@aeye/ai`).
- **Tool results are auto-paired** by default (`toolsComplete: true`) so providers don't reject unpaired `tool_calls`. `PromptSuspend` is the deliberate exception used for human-in-the-loop.
- The README at `packages/core/README.md` is the canonical narrative reference; full per-module API reference lives in `packages/docs/reference/core/`.
