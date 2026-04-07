# Custom Providers

Create custom providers for OpenAI-compatible APIs or build entirely new provider implementations.

## OpenAI-Compatible APIs

The simplest approach — use `OpenAIProvider` with a custom `baseURL`:

```typescript
import { OpenAIProvider } from '@aeye/openai';

const custom = new OpenAIProvider({
  apiKey: process.env.CUSTOM_API_KEY!,
  baseURL: 'https://api.custom-provider.com/v1',
});

const ai = AI.with()
  .providers({ custom })
  .create();
```

This works with services like Azure OpenAI, Together AI, Groq, Ollama, LM Studio, and others.

## Extending OpenAIProvider

For more control, extend the class:

```typescript
import { OpenAIProvider, OpenAIConfig } from '@aeye/openai';
import OpenAI from 'openai';

class MyProvider extends OpenAIProvider {
  readonly name = 'my-provider';

  protected createClient(config: OpenAIConfig) {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://my-api.example.com/v1',
      defaultHeaders: {
        'X-Custom-Header': 'value',
      },
    });
  }
}
```

## Custom Provider from Scratch

Implement the `Provider` interface for non-OpenAI-compatible services:

```typescript
import type {
  Provider, ModelInfo, Executor, Streamer,
  Request, Response, Chunk
} from '@aeye/ai';

class CustomProvider implements Provider {
  readonly name = 'custom';
  readonly config: { apiKey: string };

  constructor(config: { apiKey: string }) {
    this.config = config;
  }

  createExecutor(): Executor {
    return async (request: Request, ctx, model) => {
      // Make API call and return Response
      const result = await callMyAPI(request, model);
      return {
        content: result.text,
        finishReason: 'stop',
        usage: { text: { input: result.inputTokens, output: result.outputTokens } },
      };
    };
  }

  createStreamer(): Streamer {
    return async function* (request: Request, ctx, model) {
      // Yield chunks as they arrive
      const stream = await streamMyAPI(request, model);
      for await (const part of stream) {
        yield { content: part.text };
      }
      yield { finishReason: 'stop' };
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{
      id: 'my-model',
      provider: 'custom',
      name: 'My Custom Model',
      contextWindow: 8192,
      maxOutputTokens: 4096,
      tier: 'flagship',
      capabilities: new Set(['chat', 'streaming']),
      supportedParameters: new Set(['temperature', 'maxTokens']),
      pricing: { text: { input: 1, output: 2 } },
    }];
  }
}
```

## Registering Custom Models

If your provider doesn't implement `listModels`, register models manually:

```typescript
const ai = AI.with()
  .providers({ custom })
  .create({
    models: [{
      id: 'my-model-v2',
      provider: 'custom',
      name: 'My Model v2',
      contextWindow: 32000,
      maxOutputTokens: 8000,
      tier: 'flagship',
      capabilities: new Set(['chat', 'tools', 'streaming']),
      supportedParameters: new Set(['temperature', 'maxTokens', 'topP']),
      pricing: { text: { input: 2, output: 6 } },
    }],
  });
```

## Local Models (Ollama)

```typescript
const ollama = new OpenAIProvider({
  apiKey: 'ollama', // Ollama doesn't need a real key
  baseURL: 'http://localhost:11434/v1',
});

const ai = AI.with()
  .providers({ ollama })
  .create({
    models: [{
      id: 'llama3',
      provider: 'ollama',
      name: 'Llama 3',
      contextWindow: 8192,
      maxOutputTokens: 4096,
      tier: 'efficient',
      capabilities: new Set(['chat', 'streaming']),
      supportedParameters: new Set(['temperature']),
      pricing: { text: { input: 0, output: 0 } }, // free!
    }],
  });
```
