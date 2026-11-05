# @aeye/openrouter

One-line purpose: OpenRouter provider for `@aeye/ai` — one API key, hundreds of models from many upstream providers (OpenAI, Anthropic, Google, xAI, Meta, Mistral, …) with provider routing, fallback models, plugins, server tools, ZDR, reasoning, media endpoints, and real cost reporting. Built as a subclass of `@aeye/openai`'s `OpenAIProvider`.

## When to use

- You want access to many models/providers through a single endpoint and key.
- You need routing control (preferred providers, fallbacks, price/throughput/latency sorting) or Zero Data Retention.
- You want a dynamic model registry with pricing/capabilities pulled from OpenRouter.

It also serves image generation/editing (through chat with the image modality), speech, transcription, and embeddings (through OpenRouter's OpenAI-compatible endpoints). Image and transcription streaming are not offered; those fall back to the non-streaming methods.

## Install / import

```bash
npm install @aeye/openrouter
```

`@aeye/openai`, `@aeye/ai`, `@aeye/core`, and `openai` (v7) ship as dependencies. Requires Node >= 22.

```typescript
import {
  OpenRouterProvider,
  type OpenRouterConfig,
  // dynamic model registry
  OpenRouterModelSource,
  type OpenRouterSourceConfig,
  fetchModels,
  fetchZDRModels,
  fetchEndpointMetrics,
  convertOpenRouterModel,
} from '@aeye/openrouter';
```

The provider's registry name is `openrouter`.

## Register with an `@aeye/ai` instance

```typescript
import { AI } from '@aeye/ai';
import { OpenRouterProvider } from '@aeye/openrouter';

const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const ai = AI.with().providers({ openrouter }).create({ /* ... */ });

// Model ids use provider/model form
await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hi' }] },
  { metadata: { model: 'anthropic/claude-sonnet-4.5' } }
);

await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hi' }] },
  { metadata: { model: 'google/gemini-2.5-flash' } }
);
```

## Authentication / credentials

- `apiKey` is required on the config (inherited from `OpenAIConfig`). Use `process.env.OPENROUTER_API_KEY`.
- `createClient` sets the base URL to `https://openrouter.ai/api/v1` (override via `baseURL`).
- The standalone `OpenRouterModelSource`, `fetchModels`, and `fetchZDRModels` will fall back to `process.env.OPENROUTER_API_KEY` if no key is passed.
- Optional attribution headers: `defaultParams.siteUrl` → `HTTP-Referer`, `defaultParams.appName` → `X-Title`.

## Configuration (`OpenRouterConfig`)

`OpenRouterConfig extends Omit<OpenAIConfig, 'api'>`, so the OpenAI fields apply (`apiKey`, `baseURL`, `organization`, `project`, `store`, `retry`, `retryEvents`, `hooks`, `defaultModels`) except `api`: requests always go through Chat Completions. It adds `defaultParams`:

```typescript
const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    siteUrl: 'https://myapp.com',  // -> HTTP-Referer
    appName: 'my-app',             // -> X-Title
    providers: {
      order: ['Anthropic', 'OpenAI'],     // preferred upstream order
      allowFallbacks: true,               // -> allow_fallbacks
      requireParameters: false,           // -> require_parameters
      dataCollection: 'deny',             // 'deny' | 'allow' -> data_collection
      zdr: true,                          // zero data retention
      enforceDistillableText: false,      // -> enforce_distillable_text
      only: ['Anthropic'],                // whitelist upstreams
      ignore: ['Together'],               // blacklist upstreams
      quantizations: ['bf16', 'fp16'],    // int4|int8|fp4|mxfp4|nvfp4|fp6|fp8|mxfp8|fp16|bf16|fp32|unknown
      sort: 'price',                      // 'price' | 'throughput' | 'latency' | 'exacto', or { by, partition: 'model' | 'none' }
      preferredMinThroughput: 50,         // -> preferred_min_throughput (tokens/s, median)
      preferredMaxLatency: 2,             // -> preferred_max_latency (seconds, median)
      maxPrice: { prompt: 10, completion: 30, image: 0 }, // $/M tokens (image: $/image); also audio, request
    },
    fallbackModels: ['openai/gpt-5.4-mini'], // -> models
    plugins: [{ id: 'response-healing' }],   // file-parser | response-healing | context-compression
  },
});
```

`defaultParams.providers` is mapped onto OpenRouter's `provider` request object (camelCase → snake_case is handled internally). `transforms` is deprecated: `transforms: ['middle-out']` is sent as the `context-compression` plugin. `requireParameters` left undefined is switched on automatically for strict `json_schema` requests.

## Provider routing

```typescript
const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    providers: {
      order: ['Anthropic'],   // try Anthropic first
      allowFallbacks: true,   // then fall back to others
      sort: 'throughput',     // optimize for speed
    },
  },
});
```

## Reasoning

If a request sets `request.reason`, the provider emits OpenRouter's `reasoning` object: `enabled: true`, either `max_tokens` (from `maxTokens`) or `effort` (clamped to the model's `reasoningEfforts`), never both, plus `exclude`, `summary`, `mode`, and `context`. No separate `reasoning_effort` is sent. Reasoning text and `reasoning_details` are parsed back onto `response.reasoning` (and streamed via chunks), and replayed from assistant messages on later turns.

## Server tools and other request features

- `hostedTools` run as OpenRouter server tools through chat: `web_search` → `openrouter:web_search` (`maxResults`, `allowedDomains`, `blockedDomains` → `excluded_domains`), `web_fetch` → `openrouter:web_fetch`, `image_generation` → `openrouter:image_generation`. `file_search`, `code_interpreter`, and `mcp` throw `ProviderError`. Calls are counted in `usage.tools`.
- `cacheBreakpoint` on content goes as `cache_control: { type: 'ephemeral' }`.
- `modalities` with `'image'` is passed through; images come back on `response.images` (streamed or not).
- `userKey` goes as `user`. `moderate` is not sent (OpenRouter ignores OpenAI's inline moderation).

## Dynamic model registry (`OpenRouterModelSource`)

Use OpenRouter as a `ModelSource` to populate the registry with live pricing, capabilities, context windows, and ZDR flags. It lists every output modality (chat, image, speech, transcription, and embedding models); capabilities come from each modality (`vision`, `files`, `videoInput`, `hearing`, `image`, `audio`, `embedding`); pricing covers cache read/write, audio, image tokens, and web search per call; `reasoningEfforts` and `retiresAt` (from `expiration_date`) are filled in:

```typescript
import { OpenRouterModelSource } from '@aeye/openrouter';

const ai = AI.with()
  .providers({ openrouter })
  .create({
    modelSources: [
      new OpenRouterModelSource({
        apiKey: process.env.OPENROUTER_API_KEY!,
        includeZDR: true, // default true; fetches the ZDR endpoint too
      }),
    ],
  });

await ai.models.refresh();
```

`fetchModels(apiKey?)`, `fetchZDRModels(apiKey?)`, and `fetchEndpointMetrics(modelId, apiKey?)` (best median latency in ms, throughput in tokens/s, and uptime across a model's providers) are exported for direct use.

## Supported capabilities

Capabilities depend on the selected model, but the provider class supports: **chat, streaming, tools, hosted (server) tools, structured output / JSON mode, reasoning, vision, files, video input, image generation and editing, audio output, speech, transcription, embeddings** (per model). Capabilities are auto-detected from each model's input/output modalities and `supported_parameters` during model conversion.

Default models: `google/gemini-2.5-flash-image` (image generate/edit), `openai/gpt-5.4-mini` (image analysis), `openai/gpt-transcribe`, `openai/text-embedding-3-small`; speech and chat have none.

Not offered (overridden to `undefined`, so the non-streaming method is used): image generation streaming, image edit streaming, transcription streaming.

## Cost tracking

OpenRouter returns actual spend, surfaced on usage:

```typescript
const response = await ai.chat.get({ messages });
console.log(response.usage?.cost); // real cost reported by OpenRouter, including the upstream bill for BYOK requests
```

(Available on both non-streaming responses and streamed usage chunks.)

## Gotchas

- **Images go through chat.** `generateImage` / `editImage` send a chat request with `modalities: ['image', 'text']` (running through the chat hooks); `size` becomes an `image_config.aspect_ratio`, and an edit's `image` + `references` are sent as input images. GPT Image options such as `quality` and `outputFormat` are not sent.
- Model ids are `provider/model` slugs (e.g. `anthropic/claude-sonnet-4.5`), not raw OpenAI ids.
- Strict/structured output behavior is inherited from `OpenAIProvider` (best-effort, silent fallback to the family's non-strict descriptor), but the accepted dialects are widened here: `supportedStrictFamilies = {'openai', 'anthropic', 'google', 'xai'}`, because the model id's `family/…` prefix names the upstream that actually serves the request. This applies to **tool** schemas as well as `response_format`; before 0.4.x the inherited `{'openai'}` quietly forced every non-OpenAI model's tools through LENIENT.
- Assistant reasoning is split into a separate preceding message during conversion to work around OpenRouter not round-tripping reasoning attached to content — expect an extra assistant message in transformed payloads.
- ZDR (`zdr: true` / `dataCollection: 'deny'`) only constrains upstreams that honor it; combine with `only`/`ignore` for strict guarantees.
