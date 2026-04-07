# OpenRouter Provider

OpenRouter provides unified access to hundreds of AI models from multiple providers (OpenAI, Anthropic, Google, Meta, Mistral, and more) with a single API key.

## Installation

```bash
npm install @aeye/openrouter
```

## Configuration

```typescript
import { OpenRouterProvider } from '@aeye/openrouter';

const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    appName: 'my-app',
    siteUrl: 'https://myapp.com',
    providers: {
      order: ['Anthropic', 'OpenAI'],      // preferred provider order
      allowFallbacks: true,                 // allow automatic fallbacks
      requireParameters: false,             // strict parameter support
      dataCollection: 'deny',              // 'deny' | 'allow'
      zdr: true,                           // zero data retention
      only: ['Anthropic', 'OpenAI'],       // whitelist
      ignore: ['Together'],                 // blacklist
      quantizations: ['bf16', 'fp16'],     // preferred quantizations
      sort: 'price',                       // 'price' | 'throughput' | 'latency'
      maxPrice: {
        prompt: 10,       // max $/M prompt tokens
        completion: 30,   // max $/M completion tokens
      },
    },
    transforms: ['middle-out'],            // context transforms
  },
});
```

## Key Features

### Multi-Provider Access

Access models from many providers through one API:

```typescript
const ai = AI.with().providers({ openrouter }).create();

// Use any model
await ai.chat.get(
  { messages },
  { metadata: { model: 'anthropic/claude-3.5-sonnet' } }
);

await ai.chat.get(
  { messages },
  { metadata: { model: 'google/gemini-2.0-flash' } }
);
```

### Provider Routing

Control which underlying providers serve your requests:

```typescript
const openrouter = new OpenRouterProvider({
  apiKey: '...',
  defaultParams: {
    providers: {
      order: ['Anthropic'],           // prefer Anthropic
      allowFallbacks: true,            // fall back to others if unavailable
      sort: 'throughput',              // optimize for speed
    },
  },
});
```

### Zero Data Retention (ZDR)

Enable ZDR for privacy-sensitive workloads:

```typescript
const openrouter = new OpenRouterProvider({
  apiKey: '...',
  defaultParams: {
    providers: {
      dataCollection: 'deny',
      zdr: true,
    },
  },
});
```

### Model Source

Use OpenRouter as a dynamic model registry:

```typescript
import { OpenRouterModelSource } from '@aeye/openrouter';

const ai = AI.with()
  .providers({ openrouter })
  .create({
    modelSources: [
      new OpenRouterModelSource({
        apiKey: process.env.OPENROUTER_API_KEY!,
      }),
    ],
  });

// Fetches latest models with pricing, capabilities, and metrics
await ai.models.refresh();
```

## Capabilities

All capabilities are available depending on the underlying model:
- Chat, Vision, Tools, Streaming, Reasoning
- Structured Output, JSON mode
- Zero Data Retention

## Cost Tracking

OpenRouter reports actual cost in responses:

```typescript
const response = await ai.chat.get({ messages });
console.log(response.usage?.cost); // actual cost from OpenRouter
```
