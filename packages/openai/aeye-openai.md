# @aeye/openai

One-line purpose: OpenAI provider for the `@aeye/ai` framework — chat (Chat Completions or the Responses API), vision, reasoning, tools, hosted tools, structured output, audio output, image generation/edit, transcription, speech, and embeddings via the official `openai` SDK. Also the base class for any OpenAI-compatible provider.

## When to use

- You want to call OpenAI (GPT-5.x, GPT-6, GPT-4.1, gpt-audio, GPT Image, gpt-transcribe, TTS, text-embedding-3-*) through `@aeye/ai`.
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

`@aeye/ai` and `@aeye/core` are peer/runtime dependencies (they ship as `dependencies`). The `openai` SDK (v7) and `zod` are also dependencies. Requires Node >= 22.

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
  { metadata: { model: 'openai/gpt-5.4-mini' } }
);
```

You can also use the provider directly without the `AI` facade:

```typescript
const executor = openai.createExecutor();
const res = await executor(
  { messages: [{ role: 'user', content: 'Hello!' }] },
  {},                 // AIContext
  { model: 'gpt-5.4-mini' } // AIMetadata
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
| `api` | `'auto' \| 'chat' \| 'responses'` | Which API chat uses. `auto` (default) picks Responses for Responses-only models (registry `metadata.responsesOnly`, else by id: codex, pre-5.6 pro, deep-research, computer-use), `hostedTools`, or `reason.mode`/`summary`/`context` |
| `retry` | `RetryConfig` | Per-provider retry (maxRetries, initialDelay, retryableStatuses, etc.) |
| `retryEvents` | `RetryEvents` | Retry lifecycle callbacks (e.g. `onRetry`) |
| `hooks` | `OpenAIHooks` | Per-operation `beforeRequest` / `afterRequest` / `onError` |
| `defaultModels` | object | Fallback model per capability: `chat`, `imageGenerate`, `imageEdit`, `imageAnalyze`, `transcription`, `speech`, `embedding`. Built-in defaults (the protected `defaults` property, overridable by subclasses): `gpt-image-2`, `gpt-5.4-mini` (image analysis), `gpt-transcribe`, `gpt-4o-mini-tts`, `text-embedding-3-small`; no chat default |

Retry config can also be overridden per request via `request.extra.retry` / `request.extra.retryEvents`.

### Hooks

`OpenAIHooks` has a block per operation in `OpenAIOperations`: `chat`, `responses`, `imageGenerate`, `imageEdit`, `transcribe`, `speech`, `embed`. Image analysis runs as chat and reports through the `chat` (or `responses`) hooks. Each block may define `beforeRequest(request, params, ctx, metadata)`, `afterRequest(request, params, response, ctx, metadata)`, and `onError(request, params, error, ctx, metadata)`. The `params` argument is the raw OpenAI SDK params, so you can inspect/mutate the exact wire payload.

## Supported capabilities

| Capability | API surface | Models |
|-----------|-------------|--------|
| Chat (+ streaming) | `ai.chat.get` / `ai.chat.stream` | GPT-5.x, GPT-6, GPT-4.1, o3 |
| Vision / files | `ai.chat` with `image` / `file` content (`detail`, `name`) | GPT-5.x, GPT-6, GPT-4.1 |
| Reasoning | `ai.chat` with `request.reason` — `effort` (`none`..`max`, clamped to the model's `reasoningEfforts`) → `reasoning_effort`; `summary`/`mode`/`context` use Responses | GPT-5.x, GPT-6, o3 |
| Tools / function calling | `ai.chat` with `tools` | GPT-5.x, GPT-6, GPT-4.1 |
| Hosted tools | `ai.chat` with `hostedTools` (Responses): `web_search` (allowedDomains only), `file_search`, `code_interpreter`, `image_generation`, `mcp`; `web_fetch` rejected | Responses models |
| Structured output | `ai.chat` with a schema `responseFormat` | GPT-5.x, GPT-6, GPT-4.1 (strict json_schema) |
| Audio output | `ai.chat` with `modalities: ['text', 'audio']` + `audio: { voice, format }` | `gpt-audio-1.5` |
| Image generation (+ stream) | `ai.image.generate` | GPT Image (`gpt-image-2`) |
| Image edit (+ stream) | `ai.image.edit` (`image` + `references`, `mask`, `inputFidelity`) | GPT Image (`gpt-image-2`) |
| Transcription (+ stream) | `ai.transcribe` (incl. `diarized_json` + `knownSpeakers`) | `gpt-transcribe`, `gpt-4o-transcribe-diarize`, `whisper-1` |
| Speech / TTS | `ai.speech` (any voice, incl. custom voice ids) | `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd` |
| Embeddings | `ai.embed` | `text-embedding-3-small` / `-large` |

Other request fields passed through: `seed`, `verbosity`, `serviceTier`, `metadata` (Chat Completions sends it only when `store` is on), `moderate` (inline `omni-moderation-latest`), `cacheBreakpoint` on content. Responses carry `citations`, `images`, `audio`, `moderation`, `serviceTier`; `usage` counts cache writes, audio, reasoning, and hosted tool calls once each.

Through Responses, reasoning comes back encrypted (`include: reasoning.encrypted_content`, unless `store` is on) as `openai-responses-v1` reasoning details and is replayed from the assistant message's `reasoning` on later turns.

### Strict / structured output

The provider only emits OpenAI-shaped strict schemas (`supportedStrictFamilies = {'openai'}`). Strict mode for a tool or structured output engages only when the resolved model's strict format is `openai` **and** the model declares the `toolsStrict` / `structured` capability; otherwise it silently falls back to the family's non-strict descriptor. When selection supplies only a model id (no `ModelInfo`), the family is still resolved from the id, so the family's non-strict dialect is kept; strict needs the `ModelInfo` capabilities. A shared `SchemaBudget` is used so tools and the response format cooperate on per-request limits.

That default is correct for api.openai.com, which speaks exactly one dialect. **A subclass that fronts other providers' models must widen it** — `supportedStrictFamilies` is the gate on the whole family resolution, so leaving it at `{'openai'}` sends every other family's tool schemas out as LENIENT no matter what the model declares. `OpenRouterProvider` sets `{'openai', 'anthropic', 'google', 'xai'}` for this reason; `AWSProvider` sets `{'openai', 'anthropic', 'google'}`.

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
- `usesResponses(request, modelId, config, model?)` — decide when chat goes to the Responses API.
- `defaults` — the built-in default model id per operation.

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
