# AI Class

The central class of `@aeye/ai`. Manages providers, model registry, APIs, and component factories.

## Creation

```typescript
const ai = AI.with<TContext, TMetadata>()
  .providers(providers)
  .create(config?);
```

See [AI Instance](/concepts/ai-instance) for detailed configuration.

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `config` | `AIConfigOf<T>` | Full configuration |
| `registry` | `ModelRegistry` | Model registry instance |
| `chat` | `ChatAPI` | Chat completions API |
| `image` | `ImageAPI` | Image APIs (generate, edit, analyze) |
| `speech` | `SpeechAPI` | Text-to-speech API |
| `transcribe` | `TranscribeAPI` | Speech-to-text API |
| `embed` | `EmbedAPI` | Embeddings API |
| `models` | `ModelsAPI` | Model search and selection |
| `providers` | `AIProviders` | Provider instances |
| `components` | `Component[]` | Registered components |
| `hooks` | `AIHooks` | Lifecycle hooks |

## Methods

### `withHooks(hooks)`

Set lifecycle hooks. Returns `this` for chaining.

```typescript
ai.withHooks({
  beforeModelSelection: async (ctx, request, metadata) => metadata,
  onModelSelected: async (ctx, request, selected) => {},
  beforeRequest: async (ctx, request, selected, usage, cost) => {},
  afterRequest: async (ctx, request, response, complete, selected, usage, cost) => {},
  onError: (type, message, error, ctx, request) => {},
});
```

### `prompt(input)`

Create an AI-bound prompt:

```typescript
const myPrompt = ai.prompt({
  name: 'myPrompt',
  description: '...',
  content: '...',
  // ... all PromptInput options
});
```

### `tool(input)`

Create an AI-bound tool:

```typescript
const myTool = ai.tool({
  name: 'myTool',
  description: '...',
  schema: z.object({ /* ... */ }),
  call: async (input) => { /* ... */ },
});
```

### `agent(input)`

Create an AI-bound agent:

```typescript
const myAgent = ai.agent({
  name: 'myAgent',
  description: '...',
  refs: [tool1, prompt1] as const,
  call: async (input, [t, p], ctx) => { /* ... */ },
});
```

### `buildContext(requiredCtx)`

Build merged context: `defaultContext → providedContext → requiredCtx`

### `selectModel(metadata)`

Select a model using the registry.

### `estimateMessageUsage(message)`

Estimate token usage for a message.

### `estimateRequestUsage(request)`

Estimate token usage for a full request.

### `calculateCost(model, usage)`

Calculate dollar cost from model pricing and usage.

### `extend(config)`

Create an extended AI instance with additional context/metadata types.

### `stats()`

Get aggregate statistics:

```typescript
interface LibraryStats {
  totalModels: number;
  modelsByProvider: Record<string, number>;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageCost: number;
  averageLatency: number;
}
```

### `run(component, input, ctx?)`

Run any component with AI context injection.
