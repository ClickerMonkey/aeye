# AI Instance

The `AI` class is the central entry point for @aeye. It manages providers, models, context, and all API surfaces.

## Builder Pattern

Create an AI instance using the fluent builder:

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';

const ai = AI.with<MyContext, MyMetadata>()
  .providers({ openai: new OpenAIProvider({ apiKey: '...' }) })
  .create({
    // optional configuration
  });
```

### `AI.with<TContext, TMetadata>()`

The generic parameters define your application's type-safe context and metadata:

- **`TContext`** — custom data threaded through every AI operation (database connections, user info, etc.)
- **`TMetadata`** — custom metadata that can be defined on prompts, tools, and agents to influence their behavior. Metadata flows into model selection (capabilities, weights, constraints) and is available in all lifecycle hooks. Components define metadata via `metadata` or `metadataFn`, and it merges with AI-level defaults and per-request overrides to control which model is selected, how the request is configured, and how hooks respond.

Both are optional and default to `{}`.

### `.providers(providers)`

Pass an object mapping provider names to provider instances. The keys become the provider identifiers used throughout the library:

```typescript
.providers({
  openai,      // available as 'openai'
  openrouter,  // available as 'openrouter'
  aws,         // available as 'aws'
})
```

### `.create(config?)`

Creates the AI instance with optional configuration:

```typescript
.create({
  defaultContext: { /* ... */ },
  providedContext: async (ctx) => { /* ... */ },
  defaultMetadata: { /* ... */ },
  providedMetadata: async (meta) => { /* ... */ },
  models: [],
  modelOverrides: [],
  modelHandlers: [],
  modelSources: [],
  defaultWeights: { cost: 0.4, speed: 0.3, accuracy: 0.3 },
  weightProfiles: {},
  tokens: { /* token estimation config */ },
  defaultCostPerMillionTokens: 5.0,
})
```

## Properties

### API Surfaces

| Property | Type | Description |
|----------|------|-------------|
| `ai.chat` | [`ChatAPI`](/reference/ai/chat-api) | Chat completions (text, vision, tools) |
| `ai.image.generate` | [`ImageGenerateAPI`](/reference/ai/image-api) | Image generation |
| `ai.image.edit` | [`ImageEditAPI`](/reference/ai/image-api) | Image editing |
| `ai.image.analyze` | [`ImageAnalyzeAPI`](/reference/ai/image-api) | Image analysis (vision) |
| `ai.speech` | [`SpeechAPI`](/reference/ai/speech-api) | Text-to-speech |
| `ai.transcribe` | [`TranscribeAPI`](/reference/ai/transcribe-api) | Speech-to-text |
| `ai.embed` | [`EmbedAPI`](/reference/ai/embed-api) | Text embeddings |
| `ai.models` | [`ModelsAPI`](/reference/ai/models-api) | Model registry and search |

Each API has `.get()` and `.stream()` methods (except `embed` which only has `.get()`).

### Infrastructure

| Property | Type | Description |
|----------|------|-------------|
| `ai.config` | `AIConfigOf<T>` | The full resolved configuration passed to `.create()` |
| `ai.registry` | [`ModelRegistry`](/reference/ai/registry) | The model registry — manages model registration, search, scoring, and selection |
| `ai.providers` | `Record<string, Provider>` | Direct access to provider instances by name |
| `ai.components` | `Component[]` | All components (tools, prompts, agents) created via `ai.tool()`, `ai.prompt()`, `ai.agent()` |
| `ai.hooks` | [`AIHooks`](/concepts/hooks) | Currently attached lifecycle hooks |
| `ai.tokens` | `Record<ContentType, TokenConfig>` | Token estimation settings per content type (text, image, audio, file) with `divisor`, `base64Divisor`, `fallback`, and optional `max` |

## Component Factories

Create AI-bound components with full type inference:

```typescript
const myTool = ai.tool({ /* ... */ });
const myPrompt = ai.prompt({ /* ... */ });
const myAgent = ai.agent({ /* ... */ });
```

These are enhanced versions of the `@aeye/core` classes with automatic executor/streamer injection from the AI instance. Every component created this way is also tracked in `ai.components`.

## Methods

### `withHooks(hooks)`

Attach lifecycle hooks. Returns `this` for chaining.

```typescript
ai.withHooks({
  beforeModelSelection: async (ctx, request, metadata) => metadata,
  onModelSelected: async (ctx, request, selected) => {},
  beforeRequest: async (ctx, request, selected, usage, cost) => {},
  afterRequest: async (ctx, request, response, complete, selected, usage, cost) => {},
  onError: (type, message, error, ctx, request) => {},
});
```

See [Hooks & Lifecycle](/concepts/hooks) for details.

### `run(component, input, ctx?)`

Run any component with AI context automatically injected:

```typescript
const result = await ai.run(myAgent, { query: 'hello' }, ctx);
```

This builds the full context (with executor/streamer) and runs the component. For prompts, it also merges component-level metadata into the context.

### `buildContext(requiredCtx)`

Build the full merged context: `defaultContext → providedContext → requiredCtx → { ai: this }`.

```typescript
const ctx = await ai.buildContext({ userId: 'user123' });
// ctx has all default fields + provided fields + { userId, ai }
```

### `buildCoreContext(requiredCtx)`

Like `buildContext` but also injects `execute`, `stream`, and `estimateUsage` functions from the ChatAPI. This is what prompts use internally to get their AI execution capabilities.

### `buildMetadata(requiredMetadata)`

Build merged metadata: `defaultMetadata → providedMetadata → requiredMetadata`.

### `mergeMetadata(...metadatas)`

Merge multiple metadata objects. Some fields merge specially:
- `required` / `optional` capabilities — unioned (deduplicated)
- `providers.allow` / `providers.deny` — unioned
- `weights` — later values override earlier ones
- Scalar fields — later values win

### `selectModel(metadata)`

Select the best model from the registry based on metadata constraints and weights. Used internally by API classes.

### `estimateMessageUsage(message)`

Estimate token usage for a single message based on content type and length:

```typescript
const usage = ai.estimateMessageUsage({
  role: 'user',
  content: [
    { type: 'text', content: 'Describe this image' },
    { type: 'image', content: 'https://example.com/photo.jpg' },
  ],
});
// { text: { input: 5 }, image: { input: 500 } }
```

### `estimateRequestUsage(request)`

Estimate total token usage for a full request (sums all messages).

### `calculateCost(model, usage)`

Calculate dollar cost from a model's pricing and a usage object. Handles text, audio, image, reasoning, and embedding pricing, plus per-request fixed costs.

### `matchesOverride(model, override)`

Check if a `ModelOverride` applies to a given model (by provider, modelId, or modelPattern regex).

### `stats()`

Get aggregate statistics:

```typescript
const stats = ai.stats();
console.log(stats.totalModels);        // number of registered models
console.log(stats.modelsByProvider);   // { openai: 15, openrouter: 200, ... }
console.log(stats.totalRequests);      // cumulative request count
console.log(stats.averageCost);        // average cost per request ($)
console.log(stats.averageLatency);     // average latency per request (ms)
```

### `extend(config?)`

Create an extended AI instance with additional context and metadata types. The new instance shares the base configuration but can add its own defaults, models, overrides, and handlers. All config arrays (models, overrides, handlers) are merged additively.

```typescript
const chatAi = ai.extend<{ chat: Chat }>({
  defaultContext: { chat: currentChat },
  modelOverrides: [{ modelPattern: /gpt-4/, overrides: { tier: 'flagship' } }],
});

// chatAi has all original providers + new context type
const chatAgent = chatAi.agent({ /* ... */ });
```
