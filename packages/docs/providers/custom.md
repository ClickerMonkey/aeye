# Custom Provider

Use any OpenAI-compatible API as a provider by pointing `OpenAIProvider` at a custom base URL.

## Quick Setup

```typescript
import { OpenAIProvider } from '@aeye/openai';

const custom = new OpenAIProvider({
  apiKey: process.env.CUSTOM_API_KEY!,
  baseURL: 'https://api.custom-provider.com/v1',
});

const ai = AI.with()
  .providers({ custom })
  .create({
    models: [{
      id: 'custom-model',
      provider: 'custom',
      name: 'Custom Model',
      contextWindow: 8192,
      maxOutputTokens: 4096,
      tier: 'flagship',
      capabilities: new Set(['chat', 'streaming']),
      supportedParameters: new Set(['temperature', 'maxTokens']),
      pricing: { text: { input: 1, output: 2 } },
    }],
  });
```

## Compatible Services

This pattern works with:

| Service | Base URL |
|---------|----------|
| Azure OpenAI | `https://{resource}.openai.azure.com/openai/deployments/{deployment}` |
| Together AI | `https://api.together.xyz/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |
| vLLM | `http://localhost:8000/v1` |

## Local Models

### Ollama

```typescript
const ollama = new OpenAIProvider({
  apiKey: 'ollama',
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
      pricing: { text: { input: 0, output: 0 } },
    }],
  });
```

### LM Studio

```typescript
const lmstudio = new OpenAIProvider({
  apiKey: 'lm-studio',
  baseURL: 'http://localhost:1234/v1',
});
```

## Building a Full Provider

For non-OpenAI-compatible APIs, see [Custom Providers Guide](/guides/custom-providers).
