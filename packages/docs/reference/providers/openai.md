# @aeye/openai — API Reference

## `OpenAIProvider`

```typescript
class OpenAIProvider<TConfig extends OpenAIConfig = OpenAIConfig>
  implements Provider<TConfig>
```

### Constructor

```typescript
new OpenAIProvider(config: OpenAIConfig)
```

### `OpenAIConfig`

```typescript
interface OpenAIConfig {
  apiKey: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  store?: boolean;
  retry?: RetryConfig;
  defaultModels?: {
    chat?: string;
    imageGenerate?: string;
    imageEdit?: string;
    imageAnalyze?: string;
    transcription?: string;
    speech?: string;
    embedding?: string;
    edit?: string;
  };
  hooks?: OpenAIHooks;
}
```

### `RetryConfig`

```typescript
interface RetryConfig {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
  retryableStatuses?: number[];
  timeout?: number;
}
```

### `OpenAIHooks`

```typescript
interface OpenAIHooks {
  chat?: {
    beforeRequest?: (request, params, ctx, metadata) => void;
    afterRequest?: (request, response, responseComplete, ctx, metadata) => void;
    onError?: (request, params, error, ctx, metadata) => void;
  };
  // Similar hooks for imageGenerate, imageEdit, speech, transcribe, embed
}
```

## Error Types

| Class | Description |
|-------|-------------|
| `ProviderError` | Base provider error |
| `ProviderAuthError` | Authentication failure |
| `RateLimitError` | Rate limit exceeded |
| `ProviderRateLimitError` | Provider-specific rate limit |
| `ProviderQuotaError` | Account quota exceeded |
| `ContextWindowError` | Input exceeds context window |
