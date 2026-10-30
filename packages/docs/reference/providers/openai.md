# @aeye/openai — API Reference

## `OpenAIProvider`

```typescript
class OpenAIProvider<TConfig extends OpenAIConfig = OpenAIConfig>
  implements Provider<TConfig>
```

Requires Node >= 22 and the `openai` SDK v7.

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
  api?: 'auto' | 'chat' | 'responses'; // default 'auto'
  retry?: RetryConfig;
  retryEvents?: RetryEvents;
  defaultModels?: {
    chat?: ModelInput;
    imageGenerate?: ModelInput;   // default 'gpt-image-2'
    imageEdit?: ModelInput;       // default 'gpt-image-2'
    imageAnalyze?: ModelInput;    // default 'gpt-5.4-mini'
    transcription?: ModelInput;   // default 'gpt-transcribe'
    speech?: ModelInput;          // default 'gpt-4o-mini-tts'
    embedding?: ModelInput;       // default 'text-embedding-3-small'
  };
  hooks?: OpenAIHooks;
}
```

With `api: 'auto'`, chat uses Chat Completions unless the model is Responses-only (`metadata.responsesOnly` in its registry entry, or by id: codex, pre-5.6 pro, deep-research, computer-use), the request has `hostedTools`, or `reason` sets `mode`, `summary`, or `context`; then it uses the Responses API.

Subclasses can override the protected `defaults` property to supply their own default model ids.

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
type OpenAIHooks = {
  [K in keyof OpenAIOperations]?: {
    beforeRequest?: (request, params, ctx, metadata) => void;
    afterRequest?: (request, params, response, ctx, metadata) => void;
    onError?: (request, params, error, ctx, metadata) => void;
  };
};
// Operations: chat, responses, imageGenerate, imageEdit, transcribe, speech, embed
```

Image analysis runs as chat, so it reports through the `chat` (or `responses`) hooks.

## Error Types

| Class | Description |
|-------|-------------|
| `ProviderError` | Base provider error |
| `ProviderAuthError` | Authentication failure |
| `RateLimitError` | Rate limit exceeded |
| `ProviderRateLimitError` | Provider-specific rate limit |
| `ProviderQuotaError` | Account quota exceeded |
| `ContextWindowError` | Input exceeds context window |
