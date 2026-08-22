# @aeye/openrouter

One-line purpose: OpenRouter provider for `@aeye/ai` — one API key, hundreds of models from many upstream providers (OpenAI, Anthropic, Google, Meta, Mistral, …) with provider routing, fallbacks, ZDR, reasoning, and real cost reporting. Built as a subclass of `@aeye/openai`'s `OpenAIProvider`.

## When to use

- You want access to many models/providers through a single endpoint and key.
- You need routing control (preferred providers, fallbacks, price/throughput/latency sorting) or Zero Data Retention.
- You want a dynamic model registry with pricing/capabilities pulled from OpenRouter.

Do **not** use it for image generation, image editing, transcription, speech, or embeddings — those operations are explicitly disabled (see Gotchas).

## Install / import

```bash
npm install @aeye/openrouter
```

`@aeye/openai`, `@aeye/ai`, `@aeye/core`, and `openai` ship as dependencies.

```typescript
import {
  OpenRouterProvider,
  type OpenRouterConfig,
  // dynamic model registry
  OpenRouterModelSource,
  type OpenRouterSourceConfig,
  fetchModels,
  fetchZDRModels,
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
  { metadata: { model: 'anthropic/claude-3.5-sonnet' } }
);

await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hi' }] },
  { metadata: { model: 'google/gemini-2.0-flash' } }
);
```

## Authentication / credentials

- `apiKey` is required on the config (inherited from `OpenAIConfig`). Use `process.env.OPENROUTER_API_KEY`.
- `createClient` sets the base URL to `https://openrouter.ai/api/v1` (override via `baseURL`).
- The standalone `OpenRouterModelSource`, `fetchModels`, and `fetchZDRModels` will fall back to `process.env.OPENROUTER_API_KEY` if no key is passed.
- Optional attribution headers: `defaultParams.siteUrl` → `HTTP-Referer`, `defaultParams.appName` → `X-Title`.

## Configuration (`OpenRouterConfig`)

`OpenRouterConfig extends OpenAIConfig`, so all OpenAI fields apply (`apiKey`, `baseURL`, `organization`, `project`, `store`, `retry`, `retryEvents`, `hooks`, `defaultModels`). It adds `defaultParams`:

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
      only: ['Anthropic'],                // whitelist upstreams
      ignore: ['Together'],               // blacklist upstreams
      quantizations: ['bf16', 'fp16'],    // int4|int8|fp4|fp6|fp8|fp16|bf16|fp32|unknown
      sort: 'price',                      // 'price' | 'throughput' | 'latency'
      maxPrice: { prompt: 10, completion: 30, image: 0 }, // $/M tokens (image: $/image)
    },
    transforms: ['middle-out'],           // context transforms
  },
});
```

`defaultParams.providers` is mapped onto OpenRouter's `provider` request object (camelCase → snake_case is handled internally).

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

If a request sets `request.reason`, the provider emits OpenRouter's `reasoning` object (`enabled: true`, plus `effort` and `max_tokens`). Reasoning text and `reasoning_details` are parsed back onto `response.reasoning` (and streamed via chunks).

## Dynamic model registry (`OpenRouterModelSource`)

Use OpenRouter as a `ModelSource` to populate the registry with live pricing, capabilities, context windows, and ZDR flags:

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

`fetchModels(apiKey?)` and `fetchZDRModels(apiKey?)` are exported for direct use.

## Supported capabilities

Capabilities depend on the selected model, but the provider class supports: **chat, streaming, tools, structured output / JSON mode, reasoning, vision** (per model). Capabilities are auto-detected from each model's input/output modalities and `supported_parameters` during model conversion.

Explicitly **unsupported** (overridden to `undefined`): image generation, image generation streaming, image editing, transcription, transcription streaming, speech, embeddings.

## Cost tracking

OpenRouter returns actual spend, surfaced on usage:

```typescript
const response = await ai.chat.get({ messages });
console.log(response.usage?.cost); // real cost reported by OpenRouter
```

(Available on both non-streaming responses and streamed usage chunks.)

## Gotchas

- **Chat-only provider.** `generateImage`, `editImage`, `transcribe`, `speech`, and `embed` are set to `undefined` — calling those operations on this provider will not work; use OpenAI/AWS/Replicate for them.
- Model ids are `provider/model` slugs (e.g. `anthropic/claude-3.5-sonnet`), not raw OpenAI ids.
- Strict/structured output behavior is inherited from `OpenAIProvider` (best-effort, silent lenient fallback), but the accepted dialects are widened here: `supportedStrictFamilies = {'openai', 'anthropic', 'google'}`, because the model id's `family/…` prefix names the upstream that actually serves the request. This applies to **tool** schemas as well as `response_format`; before 0.4.x the inherited `{'openai'}` quietly forced every non-OpenAI model's tools through LENIENT.
- Assistant reasoning is split into a separate preceding message during conversion to work around OpenRouter not round-tripping reasoning attached to content — expect an extra assistant message in transformed payloads.
- ZDR (`zdr: true` / `dataCollection: 'deny'`) only constrains upstreams that honor it; combine with `only`/`ignore` for strict guarantees.
