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
  modelPrefix?: string;
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

## Error Types

| Class | Description |
|-------|-------------|
| `AWSError` | Base AWS error |
| `AWSAuthError` | Authentication/credential failure |
| `AWSRateLimitError` | Throttling (`retryAfter?: number`) |
| `AWSQuotaError` | Service quota exceeded |
| `AWSContextWindowError` | Context window exceeded |

## Utility Functions

### `detectAWSFamily(modelId)`

Detect the model family from a Bedrock model ID.

### `detectAWSCapabilities(family)`

Get capabilities for a model family.

### `convertAWSModel(model)`

Convert a Bedrock model response to `ModelInfo`.
