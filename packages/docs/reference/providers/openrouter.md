# @aeye/openrouter — API Reference

## `OpenRouterProvider`

Extends `OpenAIProvider` with OpenRouter-specific features.

```typescript
class OpenRouterProvider extends OpenAIProvider<OpenRouterConfig>
```

### `OpenRouterConfig`

Extends `OpenAIConfig` with:

```typescript
interface OpenRouterConfig extends OpenAIConfig {
  defaultParams?: {
    siteUrl?: string;
    appName?: string;
    providers?: {
      order?: string[];
      allowFallbacks?: boolean;
      requireParameters?: boolean;
      dataCollection?: 'deny' | 'allow';
      zdr?: boolean;
      only?: string[];
      ignore?: string[];
      quantizations?: ('int4' | 'int8' | 'fp4' | 'fp6' | 'fp8' | 'fp16' | 'bf16' | 'fp32' | 'unknown')[];
      sort?: 'price' | 'throughput' | 'latency';
      maxPrice?: { prompt?: number; completion?: number; image?: number };
    };
    transforms?: string[];
  };
}
```

## `OpenRouterModelSource`

Dynamic model source for fetching available models:

```typescript
class OpenRouterModelSource implements ModelSource {
  constructor(config: { apiKey: string });
  fetchModels(): Promise<ModelInfo[]>;
}
```

## Exported Functions

### `fetchModels(apiKey)`

Fetch available models from OpenRouter API.

### `fetchZDRModels(apiKey)`

Fetch models that support Zero Data Retention.
