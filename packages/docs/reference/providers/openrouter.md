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

Fetch available models from OpenRouter API, including speech, transcription, embedding, and image models.

### `fetchZDRModels(apiKey?)`

Fetch models that support Zero Data Retention.

### `fetchEndpointMetrics(modelId, apiKey?)`

Best median latency (ms), median throughput (tokens/s), and uptime across the providers serving a model, from `/models/{id}/endpoints`.
