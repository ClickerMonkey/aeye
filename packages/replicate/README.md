# @aeye/replicate

Replicate provider for the @aeye (AI TypeScript) framework. This package provides integration with Replicate's platform for running AI models in the cloud.

## Features

- **Thousands of Models**: Access to a vast library of open-source AI models
- **Model Adapters**: Flexible adapter system for handling model-specific schemas
- **Multiple Capabilities**: Support for chat, image generation, transcription, and more
- **Streaming**: Real-time streaming for supported models
- **Custom Models**: Deploy and use your own models
- **Version Control**: Pin specific model versions for reproducibility

## Installation

```bash
npm install @aeye/replicate @aeye/ai @aeye/core replicate zod
```

## Important Note

**Replicate has no consistent API** - each model has its own input/output schema. This means you need to register model adapters for each model you want to use. The @aeye framework provides a flexible adapter system to handle this.

## Quick Start

```typescript
import { ReplicateProvider } from '@aeye/replicate';
import { AI } from '@aeye/ai';
import { createLlama3Adapter } from '@aeye/replicate';

// Create provider with adapters
const replicate = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: {
    'meta/meta-llama-3-70b-instruct': createLlama3Adapter(),
  },
});

// Use with AI instance
const ai = AI.with()
  .providers({ replicate })
  .create();

// Make a request
const response = await ai.chat.get([
  { role: 'user', content: 'Explain neural networks' }
], {
  metadata: { model: 'meta/meta-llama-3-70b-instruct' }
});

console.log(response.content);
```

## Configuration

### Basic Configuration

```typescript
import { ReplicateProvider, ReplicateConfig } from '@aeye/replicate';

const config: ReplicateConfig = {
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: {
    // Register adapters for models you want to use
    'meta/meta-llama-3-70b-instruct': createLlama3Adapter(),
    'stability-ai/sdxl': createSDXLAdapter(),
  },
};

const provider = new ReplicateProvider(config);
```

### Custom Base URL

```typescript
const provider = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  baseUrl: 'https://custom.replicate.com', // Optional custom endpoint
  transformers: {
    // ... your adapters
  },
});
```

## Model Adapters

Model adapters translate between the @aeye standard interface and each model's specific input/output format.

### Using Built-in Adapters

```typescript
import {
  createLlama3Adapter,
  createSDXLAdapter,
  createWhisperAdapter,
} from '@aeye/replicate';

const provider = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: {
    // Chat model
    'meta/meta-llama-3-70b-instruct': createLlama3Adapter(),

    // Image generation
    'stability-ai/sdxl': createSDXLAdapter(),

    // Audio transcription
    'openai/whisper': createWhisperAdapter(),
  },
});
```

### Creating Custom Adapters

TODO: correct example

## Usage Examples

### Chat Completions

```typescript
import { AI } from '@aeye/ai';
import { ReplicateProvider, createLlama3Adapter } from '@aeye/replicate';

const replicate = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: {
    'meta/meta-llama-3-70b-instruct': createLlama3Adapter(),
  },
});

const ai = AI.with()
  .providers({ replicate })
  .create();

const response = await ai.chat.get([
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is machine learning?' }
], {
  metadata: { model: 'meta/meta-llama-3-70b-instruct' }
});

console.log(response.content);
```

### Streaming Chat

```typescript
for await (const chunk of ai.chat.stream([
  { role: 'user', content: 'Write a story about a robot' }
], {
  metadata: { model: 'meta/meta-llama-3-70b-instruct' }
})) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }
}
```

Replicate models take no response format, so a schema `responseFormat` is delivered as text: the JSON Schema is appended to the system prompt and the request asks for plain text, which the caller (or a Prompt) parses.

### Image Generation

```typescript
import { createSDXLAdapter } from '@aeye/replicate';

const replicate = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: {
    'stability-ai/sdxl': createSDXLAdapter(),
  },
});

const ai = AI.with()
  .providers({ replicate })
  .create();

const imageResponse = await ai.image.generate.get({
  prompt: 'A serene mountain landscape at sunset',
  size: '1024x1024',
}, {
  metadata: { model: 'stability-ai/sdxl' }
});

console.log('Generated image URL:', imageResponse.images[0].url);
```

### Audio Transcription

```typescript
import { createWhisperAdapter } from '@aeye/replicate';
import fs from 'fs';

const replicate = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
  transformers: {
    'openai/whisper': createWhisperAdapter(),
  },
});

const ai = AI.with()
  .providers({ replicate })
  .create();

const audioBuffer = fs.readFileSync('audio.mp3');

const transcription = await ai.transcribe.get({
  audio: audioBuffer,
}, {
  metadata: { model: 'openai/whisper' }
});

console.log('Transcription:', transcription.text);
```

### Using Specific Model Versions

```typescript
// Pin to a specific version for reproducibility
const response = await ai.chat.get(messages, {
  metadata: {
    model: 'meta/meta-llama-3-70b-instruct',
    version: 'fbfb20b472b2f3bdd101412a9f70a0ed4fc0ced78a77ff00970ee7a2383c575d',
  }
});
```

### Direct API Usage

```typescript
const executor = replicate.createExecutor();

const response = await executor(
  {
    messages: [
      { role: 'user', content: 'Hello!' }
    ],
    temperature: 0.7,
    maxTokens: 500,
  },
  {},
  { model: 'meta/meta-llama-3-70b-instruct' }
);
```

### List Available Models

```typescript
const models = await replicate.listModels();

models.forEach(model => {
  console.log(`${model.id}`);
  console.log(`  Description: ${model.metadata.description}`);
  console.log(`  Runs: ${model.metadata.runCount}`);
  console.log(`  Capabilities: ${Array.from(model.capabilities).join(', ')}`);
});
```

### Search Models

You can search for models with specific capabilities:

```typescript
// Using the Replicate client directly
const client = new Replicate({ auth: process.env.REPLICATE_API_KEY! });

const results = await client.models.search({
  query: 'text generation',
});

for await (const model of results) {
  console.log(model.owner + '/' + model.name);
}
```

## Configuration Options

### ReplicateConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `apiKey` | `string` | Yes | Replicate API key from https://replicate.com/account/api-tokens |
| `baseUrl` | `string` | No | Custom base URL for API endpoint |
| `transformers` | `Record<string, ModelTransformer>` | No | Model adapters for request/response conversion |

### ModelTransformer Interface

```typescript
interface ModelTransformer {
  // Convert @aeye request to model input
  transformRequest: (request: Request) => Record<string, unknown>;

  // Convert model output to @aeye response
  transformResponse: (output: unknown) => Response;

  // Optional: convert stream chunks
  transformStreamChunk?: (chunk: unknown) => Chunk;

  // Optional: convert image request
  transformImageRequest?: (request: ImageGenerationRequest) => Record<string, unknown>;

  // Optional: convert image response
  transformImageResponse?: (output: unknown) => ImageGenerationResponse;

  // Optional: convert transcription request
  transformTranscriptionRequest?: (request: TranscriptionRequest) => Record<string, unknown>;

  // Optional: convert transcription response
  transformTranscriptionResponse?: (output: unknown) => TranscriptionResponse;
}
```

## Built-in Adapters

The package includes adapters for popular models:

### Chat Models

- **`createLlama3Adapter()`**: Meta Llama 3 models
  - `meta/meta-llama-3-8b-instruct`
  - `meta/meta-llama-3-70b-instruct`

### Image Generation

- **`createSDXLAdapter()`**: Stable Diffusion XL
  - `stability-ai/sdxl`

- **`createFluxAdapter()`**: Flux models
  - `black-forest-labs/flux-schnell`
  - `black-forest-labs/flux-dev`

### Audio

- **`createWhisperAdapter()`**: OpenAI Whisper
  - `openai/whisper`

### Embeddings

- **`createBGEAdapter()`**: BGE embeddings
  - `replicate/bge-large-en-v1.5`

More adapters are being added regularly. Check the package exports for the latest list.

## Error Handling

```typescript
try {
  const response = await ai.chat.get(messages, {
    metadata: { model: 'meta/meta-llama-3-70b-instruct' }
  });
} catch (error) {
  if (error.message.includes('No transformer registered')) {
    console.error('Missing model adapter - register a transformer for this model');
  } else if (error.message.includes('Rate limit')) {
    console.error('Rate limit exceeded');
  } else {
    console.error('Error:', error);
  }
}
```

## Model Format

Replicate models use the format `owner/model-name`:

- `meta/meta-llama-3-70b-instruct`
- `stability-ai/sdxl`
- `openai/whisper`
- `mistralai/mixtral-8x7b-instruct-v0.1`

To use a specific version, append the version ID:

- `meta/meta-llama-3-70b-instruct:fbfb20b472b2f3bdd101412a9f70a0ed4fc0ced78a77ff00970ee7a2383c575d`

## Best Practices

1. **Register Adapters**: Always register adapters for models you use
   ```typescript
   transformers: {
     'owner/model': createAdapter(),
   }
   ```

2. **Pin Versions**: Use specific versions in production
   ```typescript
   model: 'owner/model:version-id'
   ```

3. **Handle Missing Adapters**: Provide helpful errors
   ```typescript
   if (!transformer) {
     throw new Error('No adapter registered for ' + model);
   }
   ```

4. **Cache Model Lists**: Replicate's model list is large
   ```typescript
   const models = await replicate.listModels();
   // Cache the results
   ```

5. **Monitor Usage**: Replicate charges per prediction
   ```typescript
   console.log('Tokens used:', response.usage.totalTokens);
   ```

6. **Test Adapters**: Verify adapter behavior with test data
   ```typescript
   const testRequest = { messages: [{ role: 'user', content: 'test' }] };
   const input = adapter.transformRequest(testRequest);
   console.log('Model input:', input);
   ```

## Creating Model Adapters

Here's a complete example of creating an adapter:

```typescript
import { ModelTransformer } from '@aeye/ai';
import type { Request, Response, Chunk } from '@aeye/core';

export function createMyModelAdapter(): ModelTransformer {
  return {
    transformRequest: (request: Request) => {
      // Extract the last user message as the prompt
      const lastMessage = request.messages[request.messages.length - 1];
      const prompt = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : lastMessage.content.map(c => c.content).join(' ');

      // Build model-specific input
      return {
        prompt,
        temperature: request.temperature ?? 0.7,
        max_length: request.maxTokens ?? 500,
        top_p: request.topP,
        stop_sequences: Array.isArray(request.stop)
          ? request.stop
          : request.stop
            ? [request.stop]
            : undefined,
      };
    },

    transformResponse: (output: unknown): Response => {
      const result = output as {
        output: string[];
        metrics?: { predict_time?: number };
      };

      // Combine output array into single string
      const content = result.output.join('');

      return {
        content,
        finishReason: 'stop',
        usage: {
          text: { input: 0, output: 0 },
        },
      };
    },

    transformStreamChunk: (chunk: unknown) => {
      const data = chunk as { output?: string };

      return {
        content: data.output,
      };
    },
  };
}
```

## API Reference

### ReplicateProvider

**Constructor**: `new ReplicateProvider(config: ReplicateConfig)`

**Methods**:
- `createExecutor<TContext, TMetadata>(config?)` - Create executor with adapters
- `createStreamer<TContext, TMetadata>(config?)` - Create streamer with adapters
- `listModels(config?)` - List available models from Replicate
- `generateImage<TContext>(request, ctx, config?)` - Generate images
- `transcribe<TContext>(request, ctx, config?)` - Transcribe audio
- `embed<TContext>(request, ctx, config?)` - Generate embeddings

## Supported Features

- ✅ Chat completions (with adapters)
- ✅ Streaming (model-dependent)
- ✅ Image generation (with adapters)
- ✅ Audio transcription (with adapters)
- ✅ Embeddings (with adapters)
- ✅ Custom models
- ✅ Version pinning
- ❌ Function calling (model-dependent)
- ❌ Structured outputs (model-dependent)

Feature availability depends on the specific model and adapter.

## Finding Models

Browse available models at:
- https://replicate.com/explore

Popular model categories:
- **Language Models**: Llama, Mistral, Mixtral, etc.
- **Image Generation**: SDXL, Flux, ControlNet, etc.
- **Audio**: Whisper, MusicGen, etc.
- **Video**: Stable Video Diffusion, etc.
- **Image Enhancement**: Upscaling, face restoration, etc.

## Getting an API Key

1. Visit https://replicate.com
2. Create an account or sign in
3. Navigate to https://replicate.com/account/api-tokens
4. Generate a new API token
5. Store it securely in your environment variables

## Related Packages

- **[@aeye/core](../core)**: Core @aeye framework types and interfaces
- **[@aeye/ai](../ai)**: AI abstractions and utilities
- **[@aeye/openai](../openai)**: OpenAI provider
- **[@aeye/anthropic](../anthropic)**: Anthropic Claude provider
- **[@aeye/openrouter](../openrouter)**: Multi-provider gateway

## Links

- [Replicate Website](https://replicate.com)
- [Replicate Documentation](https://replicate.com/docs)
- [Replicate Models](https://replicate.com/explore)
- [Replicate API Reference](https://replicate.com/docs/reference/http)
- [Replicate Pricing](https://replicate.com/pricing)

## License

GPL-3.0

## Contributing

Contributions are welcome, especially new model adapters! Please see the main [@aeye repository](https://github.com/ClickerMonkey/aeye) for contribution guidelines.

### Contributing Adapters

To contribute a new model adapter:

1. Create the adapter function in `src/adapters.ts`
2. Export it from `src/index.ts`
3. Add tests for the adapter
4. Update this README with usage examples
5. Submit a pull request

## Support

For issues and questions:
- GitHub Issues: https://github.com/ClickerMonkey/aeye/issues
- Documentation: https://github.com/ClickerMonkey/aeye
- Replicate Discord: https://discord.gg/replicate
