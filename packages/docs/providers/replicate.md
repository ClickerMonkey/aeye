# Replicate Provider

Replicate runs open-source AI models in the cloud with a flexible adapter system.

## Installation

```bash
npm install @aeye/replicate replicate
```

## Configuration

```typescript
import { ReplicateProvider } from '@aeye/replicate';
import { replicateTransformers } from '@aeye/models';

const replicate = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: replicateTransformers,  // model adapters
  hooks: {
    chat: {
      beforeRequest: (request, input, ctx) => {},
      afterRequest: (request, input, response, ctx) => {},
      onError: (request, input, error, ctx) => {},
    },
  },
});
```

## Model Adapters (Transformers)

Replicate models have diverse input/output schemas. Transformers adapt them to @aeye's unified interface:

```typescript
import { replicateTransformers } from '@aeye/models';

// Pre-built adapters for popular models
const replicate = new ReplicateProvider({
  apiKey: '...',
  transformers: replicateTransformers,
});
```

The `@aeye/models` package includes adapters for hundreds of Replicate models.

## Capabilities

| Capability | Models |
|-----------|--------|
| Chat | Llama 3, Mistral, etc. |
| Image Generation | SDXL, Flux, Stable Diffusion |
| Transcription | Whisper |
| Speech | Bark, etc. |

## Usage

```typescript
const ai = AI.with()
  .providers({ replicate })
  .create();

// Chat with an open-source model
const response = await ai.chat.get(
  { messages },
  { metadata: { model: 'meta/meta-llama-3-70b-instruct' } }
);
```

## Error Types

```typescript
// Replicate uses the common provider error types
// Errors are caught and normalized in the adapter layer
```

## Version Pinning

Replicate models can be pinned to specific versions for reproducibility. This is handled through the transformer configuration.
