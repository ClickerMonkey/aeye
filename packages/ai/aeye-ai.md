# @aeye/ai

> Multi-provider AI library: a single typed instance that selects models, runs chat/image/speech/transcribe/embed requests, tracks cost, and binds tools/prompts/agents — built on `@aeye/core`.

## When to use it

Use `@aeye/ai` as the main entry point of an aeye application. You create one `AI` instance, register one or more provider packages (`@aeye/openai`, `@aeye/aws`, `@aeye/openrouter`, `@aeye/replicate`, or a custom `Provider`), and then call typed APIs. The instance handles automatic model selection by capability/cost/speed, per-call context + metadata injection, lifecycle hooks (budgets, logging), and cost estimation.

- Use `@aeye/ai` for: provider-agnostic chat/embeddings/images/speech, model selection, cost tracking, and AI-bound `tool`/`prompt`/`agent` components.
- Use `@aeye/core` directly for: the underlying `Tool`/`Prompt`/`Agent` classes, `Request`/`Response`/`Chunk`/`Message` types, and strict-mode descriptors (`@aeye/ai` re-exports the request/response types you need).

## Installation & import

```bash
npm install @aeye/ai @aeye/core
npm install @aeye/openai openai      # or @aeye/aws, @aeye/openrouter, @aeye/replicate
npm install @aeye/models             # optional: curated model table + strict overrides
```

There is **one** export path. Everything is imported from the package root — there are no subpath exports.

```typescript
import {
  AI, ModelRegistry, getProviderCapabilities, resolveStrictFormat,
  isModelInfo, detectTier,
  // types:
  type Provider, type ModelInfo, type ModelOverride, type ModelSource,
  type ModelHandler, type AIConfig, type AIHooks, type ModelCapability,
} from '@aeye/ai';
```

## Core concepts

- **AI instance** (`AI<T>`): central object. Holds `config`, `registry`, the API surfaces, `providers`, `components`, and `hooks`.
- **Providers**: objects implementing the `Provider<TConfig>` interface. Each implements only the methods for the capabilities it supports (`createExecutor`/`createStreamer` for chat, `embed`, `speech`, `transcribe`, `generateImage`, etc.). Capabilities are auto-detected from which methods exist.
- **Context** (`TContext`): your app data threaded through every call. Resolved by merging `defaultContext` → `providedContext(ctx)` → per-call required context → `{ ai }`. Fields satisfied by defaults/provided are not required at call time.
- **Metadata** (`TMetadata` + `AIBaseMetadata`): controls model selection (`model`, `required`/`optional` capabilities, `requiredParameters`, `providers.allow/deny`, `pricing`/`contextWindow`/`outputTokens`/`metrics` constraints, `weights`, `weightProfile`, `tier`) plus your custom fields. Merged like context.
- **Registry** (`ModelRegistry`): stores `ModelInfo` records keyed by both `id` and `provider/id`, applies overrides, scores and selects models.
- **APIs**: `chat`, `image.{generate,edit,analyze}`, `speech`, `transcribe`, `embed`, `models`. Each request API has `get()` (await) and `stream()` (async iterable); **`embed` has only `get()`**. Selection/hooks/cost logic is shared via `BaseAPI`.
- **Components**: `ai.tool()`, `ai.prompt()`, `ai.agent()` wrap the `@aeye/core` classes and auto-inject the executor/streamer/context.

## Creating an instance

`AI.with<TContext, TMetadata>().providers(providers).create(config)` — a 3-step fluent builder that infers the full type container `T`. Both generics default to `{}`.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';

interface AppContext { userId: string; user?: User }

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

const ai = AI.with<AppContext>()
  .providers({ openai })            // keys become provider identifiers ('openai')
  .create({
    providedContext: async (ctx) => ({ user: await getUser(ctx.userId) }),
    defaultWeights: { cost: 0.5, speed: 0.3, accuracy: 0.2 },
  });
```

Constructing `new AI(config)` directly is also valid but loses inference; prefer the builder.

### Key `AIConfig` fields

| Field | Purpose |
|-------|---------|
| `providers` | Required. `Record<string, Provider>`. |
| `defaultContext` / `providedContext` | Static + async-resolved context. |
| `defaultMetadata` / `providedMetadata` | Static + async-resolved metadata. |
| `models` | `ModelInfo[]` registered up front (e.g. from `@aeye/models`). |
| `modelOverrides` | `ModelOverride[]` patched onto matching models (by `provider`/`modelId`/`modelPattern`). |
| `modelHandlers` | Per-model custom implementations (`ModelHandler`). |
| `modelSources` | External `ModelSource[]` fetched on `models.refresh()`. |
| `defaultWeights` / `weightProfiles` | Default and named scoring weights. |
| `defaultCostPerMillionTokens` | Fallback price for unknown models (default `5.0`). |
| `tokens` | Token-estimation divisors per content type. |

## Using the request APIs

All request APIs follow `api.get(request, ctx?)` / `api.stream(request, ctx?)`. The second arg is the **required context** (only the fields not satisfied by defaults/provided), and may carry `metadata` and `signal`.

```typescript
// Chat (await)
const res = await ai.chat.get(
  { messages: [{ role: 'user', content: 'What is TypeScript?' }], temperature: 0.7, maxTokens: 512 },
  { userId: 'u1' }
);
console.log(res.content, res.usage?.cost, res.finishReason);

// Chat (stream)
for await (const chunk of ai.chat.stream({ messages: [{ role: 'user', content: 'Count to 5' }] }, { userId: 'u1' })) {
  if (chunk.content) process.stdout.write(chunk.content);
}
```

Vision/audio capabilities are auto-required from message content (an `image` part adds `'vision'`, an `audio` part adds `'hearing'`); `reason`, `responseFormat`, and `tools` add the matching capabilities/parameters during selection.

```typescript
// Embeddings (get only)
const e = await ai.embed.get({ texts: ['hello', 'world'], dimensions: 1536 });
e.embeddings.forEach(({ embedding, index }) => console.log(index, embedding.length));

// Images
await ai.image.generate.get({ prompt: 'a cat astronaut', n: 1, size: '1024x1024', quality: 'high' });
await ai.image.edit.get({ prompt: 'add a sunset', image: buf, mask: maskBuf, size: '1024x1024' });
await ai.image.analyze.get({ prompt: 'describe this', images: ['https://...jpg'] }); // routes through a vision chat model

// Speech / Transcription
const speech = await ai.speech.get({ text: 'Hello there', voice: 'alloy', speed: 1.0 });
const text = await ai.transcribe.get({ audio: audioBuf, language: 'en' });
```

Request/response shapes are exported types: `Request`/`Response`/`Chunk`/`Message` (re-exported from core), plus `EmbeddingRequest`/`EmbeddingResponse`, `ImageGenerationRequest`/`ImageEditRequest`/`ImageGenerationResponse`/`ImageGenerationChunk`, `ImageAnalyzeRequest`, `SpeechRequest`/`SpeechResponse`, `TranscriptionRequest`/`TranscriptionResponse`/`TranscriptionChunk`.

## Model selection & the Models API

When `request.model` / `metadata.model` is set, that model is used directly. Otherwise the registry scores **applicable** models (those passing required capabilities, provider allow/deny, and range constraints) using weighted `cost`/`speed`/`accuracy`/`contextWindow` (weights resolve as `metadata.weights` → `metadata.weightProfile` → config `defaultWeights` → `{ cost:0.5, speed:0.3, accuracy:0.2 }`). Optional capabilities/parameters act as preference multipliers, not filters.

```typescript
ai.models.list(providedOnly?)                 // all (or only provider-backed) ModelInfo[]
ai.models.get('gpt-4o' | 'openai/gpt-4o')     // ModelInfo | undefined
ai.models.search({ required: ['chat','structured'], weights: { cost: 0.6, speed: 0.4 } }) // ScoredModel[]
ai.models.select(criteria)                     // SelectedModel | undefined
await ai.models.refresh()                      // re-fetch from providers + modelSources
```

`ModelCapability` = `'chat' | 'tools' | 'vision' | 'json' | 'structured' | 'streaming' | 'reasoning' | 'image' | 'audio' | 'hearing' | 'embedding' | 'zdr' | 'toolsStrict'`. `ModelTier` = `'flagship' | 'efficient' | 'legacy' | 'experimental'`.

## Tools, prompts & agents

`ai.tool()`, `ai.prompt()`, `ai.agent()` return enhanced `@aeye/core` `Tool`/`Prompt`/`Agent` instances with the AI executor/streamer/context auto-wired (you don't pass `types`). Every created component is pushed to `ai.components`.

```typescript
import z from 'zod';

const searchKnowledge = ai.tool({
  name: 'searchKnowledge',
  description: 'Search the knowledge base',
  schema: z.object({ query: z.string(), limit: z.number().optional() }),
  call: async ({ query, limit = 5 }, _refs, ctx) => ({ results: await search(query, limit) }),
});

const assistant = ai.prompt({
  name: 'assistant',
  description: 'Answers using the knowledge base',
  content: 'Use searchKnowledge then answer.\n\nQuestion: {{question}}',
  input: (i: { question: string }) => ({ question: i.question }),
  tools: [searchKnowledge],
  schema: z.object({ answer: z.string(), sources: z.array(z.string()) }),
});

const result = await assistant.get('result', { question: 'How does X work?' }, { userId: 'u1' });
for await (const t of assistant.get('streamContent', { question: '...' })) process.stdout.write(t);

// Or run any component with context injected:
const out = await ai.run(assistant, { question: '...' }, { userId: 'u1' });
```

`ai.agent({ name, description, refs, call })` composes other components; `call(input, [..refs], ctx)` receives the resolved refs tuple and the full AI context.

## Provider & core integration

- **Provider packages** export classes implementing the core `Provider` interface, e.g. `new OpenAIProvider({ apiKey })`, `new OpenRouterProvider({ apiKey })`, `new AWSProvider(...)`, `new ReplicateProvider(...)`. You map them under arbitrary keys in `.providers({ ... })`; the key is the provider identifier used in `metadata.providers.allow/deny`, model IDs (`provider/model`), and `ai.providers`.
- **`@aeye/models`** provides a curated `models` array and a `strictSupport` `ModelOverride[]`. Splat both so selection knows real pricing/capabilities and which models truly support strict tool/output mode:

  ```typescript
  import { models, strictSupport } from '@aeye/models';
  const ai = AI.with().providers({ openai }).create({ models, modelOverrides: [...strictSupport] });
  ```
- **`@aeye/core`** supplies the building blocks `@aeye/ai` re-exports (`Request`, `Response`, `Chunk`, `Message`, `Usage`, `Executor`, `Streamer`, `ToolInput`, `PromptInput`, `AgentInput`, `Component*`). Strict-mode descriptor mechanics live in core; `@aeye/ai` only wires the `strict` flag into selection (`true` → required `toolsStrict`, numeric/omitted → optional preference). Custom format families are registered in core via `registerDescriptor`.

### Hooks

Attach with `.withHooks(...)` (returns `this`) or via `config.hooks`-style assignment. Hooks run around every request:

```typescript
ai.withHooks({
  beforeModelSelection: async (ctx, request, metadata) => metadata,         // adjust criteria
  onModelSelected: async (ctx, request, selected) => {/* return to override */},
  beforeRequest: async (ctx, request, selected, estimatedUsage, estimatedCost) => {
    if (ctx.user && estimatedCost > ctx.user.budget) throw new Error('over budget'); // throw to cancel
  },
  afterRequest: async (ctx, request, response, complete, selected, usage, cost) => {/* track */},
  onError: (type, message, error, ctx, request) => console.error(type, message),
});
```

## Extending instances

`ai.extend<TExtraContext, TExtraMetadata>(config?)` returns a new `AI` sharing providers/config, with merged defaults and additively-merged `models`/`modelOverrides`/`modelHandlers`. Useful for feature-scoped context.

```typescript
const chatAI = ai.extend<{ chatId: string }>({ defaultContext: {} });
```

## Other exports

- `ModelRegistry` — the registry class (`getModel`, `registerModel(s)`, `listModels`, `providedModels`, `searchModels`, `selectModel`, `getProvider`, `getProviderCapabilities`, `getStrictFormat`, `refresh`). Accessible as `ai.registry`.
- `getProviderCapabilities(provider)` → `Set<ModelCapability>` inferred from provider methods.
- `resolveStrictFormat(model)` → strict dialect family or `undefined` (checks `strictFormat`, then `provider`, then `id` prefix).
- `isModelInfo(input)` — type guard distinguishing a full `ModelInfo` from a model reference.
- `detectTier(name)`, `detectCapabilitiesFromModality(modality, id)`, `detectZDRFromModeration(isModerated)` — heuristics used as fallbacks during refresh.
- `ai.stats()` → `LibraryStats` (model counts, cumulative requests, average cost/latency).

## Gotchas

- **`embed` has no `stream()`** — only `embed.get()`. Image/speech "streaming" may fall back to a single chunk if the provider lacks a true streamer (the base API converts executor↔streamer automatically).
- **Capabilities are per-provider AND per-model.** A required capability must be supported by both the model (`ModelInfo.capabilities`) and the provider (auto-detected from its methods), or the model is filtered out. Missing the right provider method → "No compatible model found".
- **Models registered under two keys** (`id` and `provider/id`); colliding registrations are merged, not replaced. Use `provider/model` IDs to disambiguate across providers.
- **`refresh()` clears and re-fetches** all models. Models passed via `config.models` are preserved because they are also added as an internal `'config'` model source.
- **Pricing is per 1M tokens** (image output pricing is per-image by quality/size; `perRequest` is a flat add-on). `estimate*Usage` is heuristic (char-count divisors), not a real tokenizer — treat estimated cost as approximate.
- **Selection without registered models fails** — with no `models`/`modelSources`/provider `listModels`, only an explicit `metadata.model` will resolve. Call `models.refresh()` or pass `config.models` first.
- **`strict: true` is a hard filter**; numeric or omitted `strict` is only a scoring preference. Without `@aeye/models` `strictSupport` overrides (or explicit `strictFormat`), models default to lenient even if the API supports strict.
- **Builder generics carry no runtime data** — `AI.with<Ctx, Meta>()` only types the instance; actual defaults come from `.create(config)`.
</content>
</invoke>
