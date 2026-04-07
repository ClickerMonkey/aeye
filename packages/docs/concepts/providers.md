# Providers

Providers are the bridge between @aeye and AI services. Each provider implements a common interface and handles the specifics of communicating with its respective API.

## Provider Interface

Every provider implements the `Provider` interface:

```typescript
interface Provider<TConfig = any> {
  readonly name: string;
  readonly config: TConfig;

  // Capabilities (optional — implement what the service supports)
  createExecutor?(): Executor;     // Non-streaming chat
  createStreamer?(): Streamer;     // Streaming chat
  generateImage?(): Function;      // Image generation
  editImage?(): Function;          // Image editing
  analyzeImage?(): Function;       // Image analysis
  generateSpeech?(): Function;     // Text-to-speech
  transcribe?(): Function;         // Speech-to-text
  embed?(): Function;              // Embeddings
  listModels?(): Promise<ModelInfo[]>; // Model discovery
  checkHealth?(): Promise<boolean>;    // Health check
}
```

## Available Providers

| Provider | Package | Capabilities |
|----------|---------|-------------|
| [OpenAI](/providers/openai) | `@aeye/openai` | Chat, Vision, Images, Speech, Transcription, Embeddings, Reasoning |
| [OpenRouter](/providers/openrouter) | `@aeye/openrouter` | Multi-provider access to hundreds of models |
| [Replicate](/providers/replicate) | `@aeye/replicate` | Open-source models with adapter system |
| [AWS Bedrock](/providers/aws) | `@aeye/aws` | Claude, Llama, Mistral, Titan, Stability AI |
| [Custom](/providers/custom) | `@aeye/openai` | Any OpenAI-compatible API |

## Capability Detection

@aeye automatically detects what each provider can do based on which methods it implements:

```typescript
// These capabilities are detected automatically:
// chat, streaming, vision, image, audio, hearing,
// embedding, tools, json, structured, reasoning, zdr
```

This information feeds into [model selection](/concepts/models) — a model is only considered if its provider supports the required capabilities.

## Provider Priority

When multiple providers offer the same model, the first provider registered takes priority:

```typescript
const ai = AI.with()
  .providers({
    openai,      // highest priority
    openrouter,  // second
    aws,         // third
  })
  .create();
```

## Provider Hooks

Each provider supports its own hook system for intercepting requests at the provider level:

```typescript
const openai = new OpenAIProvider({
  apiKey: '...',
  hooks: {
    chat: {
      beforeRequest: (request, params, ctx, metadata) => {
        console.log('OpenAI request:', params);
      },
      afterRequest: (request, response, responseComplete, ctx, metadata) => {
        console.log('OpenAI response:', responseComplete);
      },
      onError: (request, params, error, ctx, metadata) => {
        console.error('OpenAI error:', error);
      },
    },
  },
});
```

These are separate from [AI-level hooks](/concepts/hooks), which fire for all providers.
