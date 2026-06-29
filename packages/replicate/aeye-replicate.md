# @aeye/replicate

One-line purpose: Replicate provider for `@aeye/ai` — run any open-source model hosted on Replicate (LLMs, SDXL/Flux image models, Whisper, TTS, embeddings) through a per-model **ModelTransformer** adapter system.

## When to use

- You want to call community/open-source models on Replicate (`owner/name`) via the unified `@aeye/ai` API.
- You need image generation/editing/analysis, transcription, speech, or embeddings from models that each have their own bespoke input/output schema.

Replicate has no consistent API across models, so **every model you use must have a transformer** registered in config that converts the `@aeye` request to that model's input and parses its output back.

## Install / import

```bash
npm install @aeye/replicate replicate
```

`@aeye/ai`, `@aeye/core`, and `replicate` ship as dependencies.

```typescript
import {
  ReplicateProvider,
  type ReplicateConfig,
  type ReplicateTransformer,
  type ReplicateHooks,
} from '@aeye/replicate';
```

The provider's registry name is `replicate`.

## Register with an `@aeye/ai` instance

```typescript
import { AI } from '@aeye/ai';
import { ReplicateProvider } from '@aeye/replicate';

const replicate = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: {
    // keyed by Replicate model id "owner/name"
    'meta/meta-llama-3-70b-instruct': llamaTransformer,
  },
});

const ai = AI.with().providers({ replicate }).create({ /* ... */ });

await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hi' }] },
  { metadata: { model: 'meta/meta-llama-3-70b-instruct' } }
);
```

## Authentication / credentials

- `apiKey` is **required** and is passed to the `replicate` SDK as `auth`. Conventionally `process.env.REPLICATE_API_KEY` (the package does not auto-read any env var — you pass it).
- `baseUrl` (note lowercase `u`) optionally overrides the Replicate API host.

## Configuration (`ReplicateConfig`)

| Field | Type | Notes |
|-------|------|-------|
| `apiKey` | `string` (required) | Replicate API token (sent as `auth`) |
| `baseUrl` | `string` | Optional API host override |
| `transformers` | `Record<string, ReplicateTransformer>` | Map of `owner/name` → adapter. **Required for any model you call** |
| `hooks` | `ReplicateHooks` | Per-operation `beforeRequest` / `afterRequest` / `onError` (the `input` arg is the raw Replicate payload) |

## Model transformers (the core concept)

A `ReplicateTransformer` is a `ModelTransformer` (from `@aeye/ai`) with one entry per capability. The provider looks up `transformer.<capability>` and uses its converters:

| Operation | Transformer key | Converters used |
|-----------|-----------------|-----------------|
| `ai.chat.get` | `chat` | `convertRequest`, `parseResponse` |
| `ai.chat.stream` | `chat` | `convertRequest`, `parseChunk` |
| `ai.image.generate` | `imageGenerate` | `convertRequest`, `parseResponse` (+ `parseChunk` for stream) |
| `ai.image.edit` | `imageEdit` | `convertRequest`, `parseResponse` |
| image analyze | `imageAnalyze` | `convertRequest`, `parseResponse` |
| `ai.transcribe` | `transcribe` | `convertRequest`, `parseResponse` |
| `ai.speech` | `speech` | `convertRequest`, `parseResponse` |
| `ai.embed` | `embed` | `convertRequest`, `parseResponse` |

Minimal hand-written transformer for a chat model:

```typescript
const llamaTransformer: ReplicateTransformer = {
  chat: {
    // map @aeye Request -> Replicate model input
    convertRequest: async (request, ctx) => ({
      prompt: request.messages.map(m => `${m.role}: ${m.content}`).join('\n'),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    }),
    // map Replicate output -> @aeye Response
    parseResponse: async (output, ctx) => ({
      content: Array.isArray(output) ? output.join('') : String(output),
    }),
    // optional: map a streamed event -> @aeye Chunk
    parseChunk: async (event, ctx) => ({ content: String(event) }),
  },
};
```

Pre-built transformer collections may be available from a model-adapter package (e.g. an `@aeye/models` export) — pass them straight into `transformers`.

## Execution model

- The provider resolves the model from `request.model` → request metadata → `ctx.metadata.model`. Missing model throws.
- It calls `client.run('owner/name', { input })` for non-streaming ops and `client.stream(...)` for streaming, where `input` is whatever your transformer's `convertRequest` returns.
- `response.model` is stamped automatically from the requested model.

## Supported capabilities

Chat (+ streaming), image generation (+ streaming), image editing (+ streaming), image analysis (+ streaming), transcription (+ streaming), speech, and embeddings — **each gated on a transformer existing for that model and capability.**

`listModels()` pulls models from a few featured Replicate collections (`text-to-image`, `image-to-text`, `text-to-speech`, `speech-to-text`); you can still call any model by full `owner/name` regardless of what `listModels` returns.

## Gotchas

- **No transformer = hard error.** Calling a model with no `transformers[model]` entry, or one missing the required `convertRequest`/`parseResponse` (or `parseChunk` for streaming), throws immediately.
- Model ids must be `owner/name` (the SDK is invoked with a `${string}/${string}` id).
- No retry config and no custom error classes — Replicate/SDK errors propagate (after `hooks.onError`).
- Version pinning / reproducibility is the transformer's responsibility (encode a pinned version in the model id or input).
- `apiKey` is required by the type; nothing reads `REPLICATE_API_KEY` for you.
