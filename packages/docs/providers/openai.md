# OpenAI Provider

The OpenAI provider supports the full range of OpenAI's API capabilities.

## Installation

```bash
npm install @aeye/openai openai
```

## Configuration

```typescript
import { OpenAIProvider } from '@aeye/openai';

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: 'https://api.openai.com/v1',  // optional, default
  organization: 'org-xxx',                // optional
  project: 'proj-xxx',                    // optional
  store: true,                            // optional, allow storage
  retry: {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    jitter: true,
    retryableStatuses: [429, 500, 502, 503, 504],
    timeout: 60000,
  },
  defaultModels: {
    chat: 'gpt-4o',
    imageGenerate: 'dall-e-3',
    imageEdit: 'dall-e-2',
    transcription: 'whisper-1',
    speech: 'tts-1',
    embedding: 'text-embedding-3-small',
  },
  hooks: {
    chat: {
      beforeRequest: (request, params, ctx, metadata) => {},
      afterRequest: (request, response, responseComplete, ctx, metadata) => {},
      onError: (request, params, error, ctx, metadata) => {},
    },
  },
});
```

## Capabilities

| Capability | Models | API Method |
|-----------|--------|------------|
| Chat | GPT-4o, GPT-4, GPT-3.5 | `ai.chat` |
| Vision | GPT-4o, GPT-4V | `ai.chat` with images |
| Reasoning | o1, o1-mini, o3-mini | `ai.chat` with `reason` |
| Tools | GPT-4o, GPT-4 | `ai.chat` with tools |
| Structured Output | GPT-4o | `ai.chat` with schema |
| Image Generation | DALL-E 2, DALL-E 3 | `ai.image.generate` |
| Image Editing | DALL-E 2 | `ai.image.edit` |
| Speech (TTS) | tts-1, tts-1-hd | `ai.speech` |
| Transcription | whisper-1 | `ai.transcribe` |
| Embeddings | text-embedding-3-* | `ai.embed` |

## Usage

```typescript
const ai = AI.with()
  .providers({ openai })
  .create();

// Chat
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Hello' }],
});

// With vision
const response = await ai.chat.get({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', content: 'Describe this image' },
      { type: 'image', content: 'https://example.com/img.png' },
    ],
  }],
});

// Image generation
const img = await ai.image.generate.get({
  prompt: 'A sunset over mountains',
  size: '1024x1024',
});
```

## Error Types

```typescript
import {
  ProviderError,
  ProviderAuthError,
  RateLimitError,
  ProviderRateLimitError,
  ProviderQuotaError,
  ContextWindowError,
} from '@aeye/openai';
```

## As Base Class

`OpenAIProvider` can be extended for OpenAI-compatible APIs:

```typescript
class AzureProvider extends OpenAIProvider {
  readonly name = 'azure';
  // customize as needed
}
```

See [Custom Providers](/guides/custom-providers) for details.
