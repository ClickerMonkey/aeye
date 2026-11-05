# @aeye/aws — API Reference

## `AWSBedrockProvider`

```typescript
class AWSBedrockProvider implements Provider<AWSBedrockConfig>
```

### `AWSBedrockConfig`

```typescript
interface AWSBedrockConfig {
  region?: string;
  credentials?: {
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  };
  // Inference profile prefix ('us.', 'eu.', 'global.', ...). Without one,
  // profile-only models use the region's geography profile, or the global one.
  modelPrefix?: string;
  // Converse performanceConfig.latency: 'standard' | 'optimized'
  latency?: PerformanceConfigLatency;
  // Guardrail for every chat request; streamProcessingMode applies to streams
  guardrail?: GuardrailStreamConfiguration;
  modelFamilies?: Record<string, ModelFamilyConfig>;
  defaultModels?: {
    chat?: ModelInput;
    imageGenerate?: ModelInput;
    embedding?: ModelInput;
  };
  hooks?: AWSBedrockHooks;
}
```

### `ModelFamilyConfig`

```typescript
interface ModelFamilyConfig {
  enabled?: boolean;
  modelIdMap?: Record<string, string>;
}
```

### `AWSBedrockHooks`

```typescript
interface AWSBedrockHooks {
  chat?: {
    beforeRequest?: (request, command, ctx) => void;
    afterRequest?: (request, command, response, ctx) => void;
  };
  imageGenerate?: {
    beforeRequest?: (request, command, ctx) => void;
    afterRequest?: (request, command, response, ctx) => void;
  };
  embed?: {
    beforeRequest?: (request, command, ctx) => void;
    afterRequest?: (request, command, response, ctx) => void;
  };
}
```

## Request Mapping

Chat requests go through Converse / ConverseStream. See the
[provider guide](../../providers/aws.md#chat-features) for the full mapping.

| `Request` | Converse |
|-----------|----------|
| `maxTokens`, `temperature`, `topP`, `stop` | `inferenceConfig` |
| `reason` | Claude `thinking` + `outputConfig.effort`, Nova `reasoningConfig`, or `reasoning_effort` |
| `responseFormat` (schema) | `outputConfig.textFormat` (`json_schema`), when the model has a strict descriptor |
| `tools` / `toolChoice` | `toolConfig` (`strict` per tool; `auto` / `any` / `tool`) |
| `serviceTier` | `serviceTier.type` (`fast` → `priority`, `scale` → `reserved`) |
| `metadata` | `requestMetadata` |
| `extra` | `additionalModelRequestFields` |
| `MessageContent.cacheBreakpoint` | `cachePoint` after the part |

| `Response` | From |
|------------|------|
| `reasoning` | `reasoningContent` blocks; details in the `bedrock-converse-v1` format (`reasoning.text` + `signature`, or `reasoning.encrypted` with base64 `data`), replayed on later turns |
| `citations` | Web locations in `citationsContent` |
| `usage.text` | `inputTokens`, `outputTokens`, `cacheReadInputTokens` → `cached`, `cacheWriteInputTokens` → `cacheWrite` |
| `serviceTier` | `serviceTier.type` |
| `finishReason` | `stopReason` (`guardrail_intervened` → `content_filter`) |

## Error Types

| Class | Description |
|-------|-------------|
| `AWSError` | Base AWS error |
| `AWSAuthError` | Authentication/credential failure, including `AccessDeniedException` and `ExpiredTokenException` |
| `AWSRateLimitError` | Throttling or busy capacity (`retryAfter?: number`) |
| `AWSQuotaError` | Service quota exceeded |
| `AWSContextWindowError` | Context window exceeded |

## Utility Functions

### `detectAWSFamily(modelId)`

Detect the model family from a Bedrock model ID.

### `detectAWSCapabilities(family)`

Get capabilities for a model family.

### `convertAWSModel(model)`

Convert a Bedrock model response to `ModelInfo`.
