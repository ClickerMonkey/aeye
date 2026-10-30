# OpenRouter Provider

OpenRouter provides unified access to hundreds of AI models from multiple providers (OpenAI, Anthropic, Google, xAI, Meta, Mistral, and more) with a single API key.

## Installation

```bash
npm install @aeye/openrouter
```

Requires Node >= 22.

## Configuration

```typescript
import { OpenRouterProvider } from '@aeye/openrouter';

const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    appName: 'my-app',
    siteUrl: 'https://myapp.com',
    providers: {
      order: ['Anthropic', 'OpenAI'],      // preferred provider order
      allowFallbacks: true,                 // allow automatic fallbacks
      requireParameters: false,             // strict parameter support (auto-on for strict schemas when unset)
      dataCollection: 'deny',              // 'deny' | 'allow'
      zdr: true,                           // zero data retention
      enforceDistillableText: false,       // only providers that allow training on outputs
      only: ['Anthropic', 'OpenAI'],       // whitelist
      ignore: ['Together'],                 // blacklist
      quantizations: ['bf16', 'fp16'],     // preferred quantizations
      sort: 'price',                       // 'price' | 'throughput' | 'latency' | 'exacto', or { by, partition }
      preferredMinThroughput: 50,          // tokens/second, median
      preferredMaxLatency: 2,              // seconds, median
      maxPrice: {
        prompt: 10,       // max $/M prompt tokens
        completion: 30,   // max $/M completion tokens
      },
    },
    fallbackModels: ['openai/gpt-5.4-mini'], // tried in order if the requested model fails
    plugins: [{ id: 'response-healing' }],   // 'file-parser' | 'response-healing' | 'context-compression'
  },
  defaultModels: {
    rerank: 'cohere/rerank-v3.5',            // default
    decision: 'typesafe/jev-1.14',           // default
  },
});
```

`transforms` is deprecated: OpenRouter replaced it with plugins, and `transforms: ['middle-out']` is sent as the `context-compression` plugin.

## Key Features

### Multi-Provider Access

Access models from many providers through one API:

```typescript
const ai = AI.with().providers({ openrouter }).create();

// Use any model
await ai.chat.get(
  { messages },
  { metadata: { model: 'anthropic/claude-sonnet-4.5' } }
);

await ai.chat.get(
  { messages },
  { metadata: { model: 'google/gemini-2.5-flash' } }
);
```

### Provider Routing

Control which underlying providers serve your requests:

```typescript
const openrouter = new OpenRouterProvider({
  apiKey: '...',
  defaultParams: {
    providers: {
      order: ['Anthropic'],           // prefer Anthropic
      allowFallbacks: true,            // fall back to others if unavailable
      sort: { by: 'throughput', partition: 'none' }, // fastest endpoint across fallback models
    },
  },
});
```

`sort: 'exacto'` prefers the providers with the best tool-calling accuracy.

### Zero Data Retention (ZDR)

Enable ZDR for privacy-sensitive workloads:

```typescript
const openrouter = new OpenRouterProvider({
  apiKey: '...',
  defaultParams: {
    providers: {
      dataCollection: 'deny',
      zdr: true,
    },
  },
});
```

### Reasoning

`reason` goes as one `reasoning` object with either a token budget (`maxTokens`) or an `effort`, never both (`maxTokens` wins), plus `exclude`, `summary`, `mode`, and `context`. Reasoning returned on an assistant message is replayed on later turns.

### Server Tools

`hostedTools` run as OpenRouter server tools through chat:

| Hosted tool | Sent as |
|---|---|
| `web_search` (`maxResults`, `allowedDomains`, `blockedDomains`) | `openrouter:web_search` |
| `web_fetch` | `openrouter:web_fetch` |
| `image_generation` | `openrouter:image_generation` |

`file_search`, `code_interpreter`, and `mcp` are rejected. Server tool calls are counted in `usage.tools`.

### Other Request Features

- `cacheBreakpoint` on content goes as `cache_control`, which OpenRouter translates for each upstream provider.
- `modalities` including `'image'` asks image-output models for images; they come back on `response.images`, streamed or not.
- `userKey` goes as `user`.
- `moderate` is not sent (OpenRouter ignores OpenAI's inline moderation).
- Requests always go through Chat Completions (`OpenRouterConfig` has no `api` option); routing, plugins, server tools, and reasoning options all work there.

### Tools

- `toolChoice: { allowed, required? }` is emulated: only the allowed tools are sent, with `tool_choice` `required` or `auto`. OpenRouter ignores `allowed_tools` (models still call the other tools, and some upstreams reject it), so the cache benefit of sending every tool is lost.
- Free-text tools (`format`) are sent as a function with one `input` field; a grammar is appended to the description, so the model is asked, not forced, to follow it.
- `defer` and `async` are not offered; those tools are sent as ordinary tools.

### Images, Speech, Transcription, Embeddings

- Images generate and edit through chat with the image modality (default `google/gemini-2.5-flash-image`); `size` becomes an aspect ratio, and edit `image` + `references` are sent as input images. No image streaming.
- Embeddings (default `openai/text-embedding-3-small`), speech, and transcription (default `openai/gpt-transcribe`) use OpenRouter's OpenAI-compatible endpoints. Speech has no default model. No transcription streaming.
- Image analysis defaults to `openai/gpt-5.4-mini`.

### Reranking

`ai.rerank` calls OpenRouter's `/rerank` endpoint, which serves Cohere, Voyage, Qwen, and NVIDIA Nemotron rerankers (default `cohere/rerank-v3.5`). The cost OpenRouter reports comes back as `usage.cost`. See [Reranking](/guides/rerank).

```typescript
const { results } = await ai.rerank.get({ query: 'refund policy', documents, topN: 3 });
```

### Decisions

`ai.decide` calls OpenRouter's alpha decisions endpoint (outside the versioned API). It serves System One models such as `typesafe/jev-1.14` (the default) and `jaredpalmer/kev-4b`, plus `openai/gpt-6-luna-decisions`, `liquid/d1`, the Perplexity deciders, and others. A conversation `input` is sent as chat messages, and the cost OpenRouter reports comes back as `usage.cost`. See [Decisions](/guides/decisions).

### Batches

`ai.batch.submit` posts the requests inline to `/batches` as Chat Completions calls; `ai.batch.get` returns the results inline once the batch completes, in request order. See [Batches](/guides/batch).

### Model Source

Use OpenRouter as a dynamic model registry:

```typescript
import { OpenRouterModelSource } from '@aeye/openrouter';

const ai = AI.with()
  .providers({ openrouter })
  .create({
    modelSources: [
      new OpenRouterModelSource({
        apiKey: process.env.OPENROUTER_API_KEY!,
      }),
    ],
  });

// Fetches latest models with pricing, capabilities, and metrics
await ai.models.refresh();
```

The source lists every output modality (chat, image, speech, transcription, embedding, rerank, and decision models; the `rerank` and `decisions` modalities map to the `rerank` and `decision` capabilities), reads capabilities from each modality (`files`, `videoInput`, `audio`, `hearing`, ...), cache read/write, audio, image-token, and web-search pricing, accepted reasoning efforts, and `expiration_date` as `retiresAt`.

## Capabilities

All capabilities are available depending on the underlying model:
- Chat, Vision, Files, Video input, Tools, Streaming, Reasoning
- Structured Output, JSON mode
- Image generation and editing, Audio output
- Speech, Transcription, Embeddings
- Reranking, Decisions, Batches
- Zero Data Retention

## Cost Tracking

OpenRouter reports actual cost in responses:

```typescript
const response = await ai.chat.get({ messages });
console.log(response.usage?.cost); // actual cost from OpenRouter, including the upstream bill for BYOK requests
```
