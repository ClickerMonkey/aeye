# @aeye/openai

One-line purpose: OpenAI provider for the `@aeye/ai` framework — chat, vision, reasoning, tools, structured output, image generation/edit, transcription, speech, and embeddings via the official `openai` SDK. Also the base class for any OpenAI-compatible provider.

## When to use

- You want to call OpenAI (GPT-4o, GPT-4, o-series, DALL-E, gpt-image, Whisper, TTS, text-embedding-3-*) through `@aeye/ai`.
- You need a base class to build an OpenAI-compatible provider (Azure OpenAI, OpenRouter, local OpenAI-shaped endpoints). `@aeye/openrouter` is built this way.

## Install / import

```bash
npm install @aeye/openai openai
```

```typescript
import {
  OpenAIProvider,
  type OpenAIConfig,
  type OpenAIHooks,
  // error classes (from @aeye/openai)
  ProviderError,
  ProviderAuthError,
  RateLimitError,
  ProviderRateLimitError,
  ProviderQuotaError,
  ContextWindowError,
} from '@aeye/openai';
```

`@aeye/ai` and `@aeye/core` are peer/runtime dependencies (they ship as `dependencies`). The `openai` SDK and `zod` are also dependencies.

## Register with an `@aeye/ai` instance

A provider is registered by passing it into `AI.with().providers({...})`. The key you give it is the provider's local name in the registry.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

const ai = AI.with()
  .providers({ openai })
  .create({ /* AI config: modelSources, hooks, defaultContext, ... */ });

// Chat
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.content);

// Explicit model selection is done via metadata, not the provider
const r2 = await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hi' }] },
  { metadata: { model: 'openai/gpt-4o' } }
);
```

You can also use the provider directly without the `AI` facade:

```typescript
const executor = openai.createExecutor();
const res = await executor(
  { messages: [{ role: 'user', content: 'Hello!' }] },
  {},                 // AIContext
  { model: 'gpt-4o' } // AIMetadata
);
```

## Authentication / credentials

- `apiKey` is **required** on `OpenAIConfig` (typed `string`). Conventionally supply `process.env.OPENAI_API_KEY`.
- `organization` and `project` map to the OpenAI SDK's `organization` / `project` options.
- `baseURL` lets you point at an OpenAI-compatible endpoint (e.g. Azure). There is no special env var handling in this package — credentials come from the config object you pass.

## Configuration (`OpenAIConfig`)

| Field | Type | Notes |
|-------|------|-------|
| `apiKey` | `string` (required) | OpenAI API key |
| `baseURL` | `string` | Custom/compatible endpoint |
| `organization` | `string` | Org ID |
| `project` | `string` | Project ID |
| `store` | `boolean` | Allow OpenAI to store call contents. Defaults to `false` |
| `retry` | `RetryConfig` | Per-provider retry (maxRetries, initialDelay, retryableStatuses, etc.) |
| `retryEvents` | `RetryEvents` | Retry lifecycle callbacks (e.g. `onRetry`) |
| `hooks` | `OpenAIHooks` | Per-operation `beforeRequest` / `afterRequest` / `onError` |
| `defaultModels` | object | Fallback model per capability: `chat`, `imageGenerate`, `imageEdit`, `imageAnalyze`, `transcription`, `speech`, `embedding` |

Retry config can also be overridden per request via `request.extra.retry` / `request.extra.retryEvents`.

### Hooks

`OpenAIHooks` has a block per operation: `chat`, `imageGenerate`, `imageEdit`, `imageAnalyze`, `transcribe`, `speech`, `embed`. Each block may define `beforeRequest(request, params, ctx, metadata)`, `afterRequest(request, params, response, ctx, metadata)`, and `onError(request, params, error, ctx, metadata)`. The `params` argument is the raw OpenAI SDK params, so you can inspect/mutate the exact wire payload.

## Supported capabilities

| Capability | API surface | Models |
|-----------|-------------|--------|
| Chat (+ streaming) | `ai.chat.get` / `ai.chat.stream` | GPT-4o, GPT-4, GPT-3.5, o-series |
| Vision | `ai.chat` with `image` content | GPT-4o / GPT-4V |
| Reasoning | `ai.chat` with `request.reason.effort` → `reasoning_effort` | o1, o3-mini, etc. |
| Tools / function calling | `ai.chat` with `tools` | GPT-4o, GPT-4 |
| Structured output | `ai.chat` with a schema `responseFormat` | GPT-4o (strict json_schema) |
| Image generation | `ai.image.generate` | `dall-e-2`, `dall-e-3`, `gpt-image-*` |
| Image edit | `ai.image.edit` | `dall-e-2`, `gpt-image-*` |
| Transcription (+ stream) | `ai.transcribe` | `whisper-1`, gpt-4o transcribe |
| Speech / TTS | `ai.speech` | `tts-1`, `tts-1-hd`, gpt-4o-mini-tts |
| Embeddings | `ai.embed` | `text-embedding-3-small` / `-large` |

### Strict / structured output

The provider only emits OpenAI-shaped strict schemas (`supportedStrictFamilies = {'openai'}`). Strict mode for a tool or structured output engages only when the resolved model's strict format is `openai` **and** the model declares the `toolsStrict` / `structured` capability; otherwise it silently falls back to a lenient (non-strict) schema. A shared `SchemaBudget` is used so tools and the response format cooperate on per-request limits.

## Usage examples

```typescript
// Vision
await ai.chat.get({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', content: 'Describe this image' },
      { type: 'image', content: 'https://example.com/cat.png' },
    ],
  }],
});

// Tools
import { z } from 'zod';
await ai.chat.get({
  messages: [{ role: 'user', content: 'Weather in SF?' }],
  tools: [{
    name: 'get_weather',
    description: 'Get current weather',
    parameters: z.object({ location: z.string() }),
  }],
  toolChoice: 'auto',
});

// Image generation
await ai.image.generate.get({ prompt: 'A sunset over mountains', size: '1024x1024' });

// Embeddings
await ai.embed.get({ texts: ['Hello world'] });
```

## Extending for OpenAI-compatible providers

`OpenAIProvider<TConfig>` is designed for subclassing. Override:

- `createClient(config)` — point at a different `baseURL` / set custom headers.
- `convertModel(model)` — enrich `ModelInfo`.
- `listModels(config)` — custom model discovery.
- `augmentChatRequest` / `augmentChatMessage` / `augmentChatContent` / `augmentChatChunk` / `augmentChatResponse` — inject provider-specific params and parse extra response fields.
- `augmentImageGenerateRequest`, `augmentImageEditRequest`, `augmentTranscriptionRequest`, `augmentSpeechRequest`, `augmentEmbeddingRequest`.
- `supportedStrictFamilies` — widen accepted strict descriptor families.

```typescript
class AzureProvider extends OpenAIProvider {
  readonly name = 'azure';
  protected createClient(config: OpenAIConfig) {
    return new OpenAI({ apiKey: config.apiKey, baseURL: 'https://my.openai.azure.com/v1' });
  }
}
```

## Gotchas

- `apiKey` is required by the type; this package does not auto-read `OPENAI_API_KEY` for you (you pass it in).
- Model is required at request time — supply it via `request.model`, `ctx.metadata.model`, request metadata, or `defaultModels`. Missing model throws `ProviderError`.
- `store` defaults to `false`; set it explicitly if you rely on OpenAI storing calls.
- Context-window overflow is not thrown on the chat path — the executor/streamer returns a `Response` with `finishReason: 'length'` instead.
- Streaming chat always sends `stream_options.include_usage: true` so usage arrives in trailing chunks.
- Retry types (`RetryConfig`, `RetryEvents`) are accepted structurally via `OpenAIConfig` but are not re-exported from the package entry point.
