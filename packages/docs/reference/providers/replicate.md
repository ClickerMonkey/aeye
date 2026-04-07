# @aeye/replicate — API Reference

## `ReplicateProvider`

```typescript
class ReplicateProvider implements Provider<ReplicateConfig>
```

### `ReplicateConfig`

```typescript
interface ReplicateConfig {
  apiKey: string;
  baseUrl?: string;
  transformers: Record<string, ReplicateTransformer>;
  hooks?: ReplicateHooks;
}
```

### `ReplicateTransformer`

Model adapters that normalize Replicate's per-model APIs:

```typescript
interface ReplicateTransformer {
  // Transforms @aeye Request to Replicate input format
  toInput(request: Request): object;
  // Transforms Replicate output to @aeye Response
  toResponse(output: any): Response;
  // Optional: transforms streaming output to chunks
  toChunk?(output: any): Chunk;
}
```

### `ReplicateHooks`

```typescript
interface ReplicateHooks {
  chat?: {
    beforeRequest?: (request, input, ctx) => void;
    afterRequest?: (request, input, response, ctx) => void;
    onError?: (request, input, error, ctx) => void;
  };
}
```

## Pre-built Transformers

```typescript
import { replicateTransformers } from '@aeye/models';

// Includes adapters for hundreds of models
const replicate = new ReplicateProvider({
  apiKey: '...',
  transformers: replicateTransformers,
});
```
