# @aeye/openrouter — API Reference

## `OpenRouterProvider`

Extends `OpenAIProvider` with OpenRouter-specific features.

```typescript
class OpenRouterProvider extends OpenAIProvider<OpenRouterConfig>
```

### `OpenRouterConfig`

Extends `OpenAIConfig` (minus `api`) with:

```typescript
interface OpenRouterConfig extends Omit<OpenAIConfig, 'api'> {
  defaultParams?: {
    siteUrl?: string;
    appName?: string;
    providers?: {
      order?: string[];
      allowFallbacks?: boolean;
      requireParameters?: boolean;      // auto-on for strict json_schema when undefined
      dataCollection?: 'deny' | 'allow';
      zdr?: boolean;
      enforceDistillableText?: boolean; // only providers that allow training on outputs
      only?: string[];
      ignore?: string[];
      quantizations?: OpenRouterQuantization[]; // 'int4' | 'int8' | 'fp4' | 'mxfp4' | 'nvfp4' | 'fp6' | 'fp8' | 'mxfp8' | 'fp16' | 'bf16' | 'fp32' | 'unknown'
      sort?: OpenRouterSort | { by: OpenRouterSort; partition?: 'model' | 'none' }; // 'price' | 'throughput' | 'latency' | 'exacto'
      preferredMinThroughput?: number;  // tokens/second, median
      preferredMaxLatency?: number;     // seconds, median
      maxPrice?: { prompt?: number; completion?: number; image?: number; audio?: number; request?: number };
    };
    fallbackModels?: string[];          // sent as `models`
    plugins?: OpenRouterPlugin[];       // file-parser | response-healing | context-compression
    /** @deprecated `middle-out` is sent as the `context-compression` plugin */
    transforms?: string[];
  };
}
```

`OpenRouterConfig` omits `OpenAIConfig`'s `api` option: requests always go through Chat Completions, where routing, plugins, server tools, and reasoning options work.

Default models (`defaultModels`, from `OpenAIConfig`): `imageGenerate` / `imageEdit` `google/gemini-2.5-flash-image`, `imageAnalyze` `openai/gpt-5.4-mini`, `transcription` `openai/gpt-transcribe`, `embedding` `openai/text-embedding-3-small`, `rerank` `cohere/rerank-v3.5`, `decision` `typesafe/jev-1.14`. Speech has no default.

### Methods beyond `OpenAIProvider`

| Method | Calls |
|---|---|
| `rerank(request, ctx, config?)` | `POST /rerank` (`top_n` from `topN`; `relevance_score` becomes `score`; `usage.cost` from the response) |
| `decide(request, ctx, config?)` | `POST /api/alpha/decisions` (input as `state`; predicates go as `noul` questions, choices and levels as `criteria`) |
| `submitBatch(requests, ctx, config?)` | `POST /batches` with the requests inline (always Chat Completions) |
| `getBatch(job, ctx, config?)` | `GET /batches/{id}`; results are inline once complete; the batch's `usage` cost becomes `job.cost` |

Rerank and decide run the provider's `hooks.rerank` and `hooks.decide`. The decide hooks receive System One parameters (`state`, and `questions` by name); on OpenAI they receive the Decisions API's (`input`, and a `questions` array), so check `'state' in params` to tell them apart.

### Tools

`buildChatParams` applies `withAllowedTools` from `@aeye/core`: a `{ allowed, required? }` tool choice sends only the allowed tools, because OpenRouter ignores `allowed_tools`. Free-text tools go as one-field functions with any grammar in the description; `defer` and `async` are not sent.

`chatHeaders` adds `x-anthropic-beta: structured-outputs-2025-11-13` whenever a tool is strict, so OpenRouter keeps `strict` on tools bound for Anthropic. `augmentChatRequest` puts a `Respond in JSON.` system message first when the response format isn't `text` and no message mentions JSON.

### Reasoning

Reasoning parsed from responses and chunks is marked `provider: 'openrouter'`. `convertMessages` replays it as `reasoning` / `reasoning_details` on the assistant message it came with (once, even when a message was split into parts), and only when `replaysTo(reasoning, 'openrouter')`: reasoning named for another provider is dropped.

## `OpenRouterModelSource`

Dynamic model source for fetching available models:

```typescript
class OpenRouterModelSource implements ModelSource {
  constructor(config?: { apiKey?: string; includeZDR?: boolean });
  fetchModels(): Promise<ModelInfo[]>;
}
```

## Exported Functions

### `fetchModels(apiKey?)`

Fetch available models from OpenRouter API, including speech, transcription, embedding, image, rerank, and decision models.

### `fetchZDRModels(apiKey?)`

Fetch models that support Zero Data Retention.

### `fetchEndpointMetrics(modelId, apiKey?)`

Best median latency (ms), median throughput (tokens/s), and uptime across the providers serving a model, from `/models/{id}/endpoints`.
