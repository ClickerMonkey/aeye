# Multi-Provider Setup

@aeye shines when you use multiple providers. The library automatically selects the best model for each request based on capabilities, cost, speed, and quality.

## Configuration

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { ReplicateProvider } from '@aeye/replicate';
import { AWSBedrockProvider } from '@aeye/aws';

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const replicate = new ReplicateProvider({
  apiKey: process.env.REPLICATE_API_KEY!,
});

const aws = new AWSBedrockProvider({
  region: 'us-east-1',
});

const ai = AI.with()
  .providers({ openai, openrouter, replicate, aws })
  .create({
    defaultWeights: {
      cost: 0.4,
      speed: 0.3,
      accuracy: 0.3,
    },
  });
```

## Automatic Model Selection

When you make a request without specifying a model, @aeye scores all available models and picks the best one:

```typescript
// AI picks the best model based on your weight preferences
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Explain quantum computing' }],
});

console.log(`Used model: ${response.model}`);
```

## Explicit Model Selection

Override automatic selection when you need a specific model:

```typescript
const response = await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hello' }] },
  { metadata: { model: 'openai/gpt-4o' } }
);
```

## Capability-Based Selection

Request specific capabilities and let @aeye find the right model:

```typescript
// Only models with vision support
const response = await ai.chat.get(
  {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', content: 'What is in this image?' },
        { type: 'image', content: imageUrl },
      ],
    }],
  },
  {
    metadata: {
      required: ['vision'],
      weights: { accuracy: 0.8, cost: 0.2 },
    },
  }
);
```

## Provider Filtering

Restrict which providers can be used:

```typescript
const response = await ai.chat.get(
  { messages: [{ role: 'user', content: 'Summarize this' }] },
  {
    metadata: {
      providers: {
        allow: ['openai', 'openrouter'],
        deny: ['replicate'],
      },
    },
  }
);
```

## Weight Profiles

Define named weight profiles for different use cases:

```typescript
const ai = AI.with()
  .providers({ openai, openrouter })
  .create({
    defaultWeights: { cost: 0.5, speed: 0.3, accuracy: 0.2 },
    weightProfiles: {
      cheap: { cost: 0.9, speed: 0.05, accuracy: 0.05 },
      fast: { cost: 0.1, speed: 0.8, accuracy: 0.1 },
      precise: { cost: 0.1, speed: 0.1, accuracy: 0.8 },
    },
  });

// Use a named profile
const response = await ai.chat.get(
  { messages: [{ role: 'user', content: 'Quick answer needed' }] },
  { metadata: { weightProfile: 'fast' } }
);
```

## Next Steps

- [Models & Selection](/concepts/models) — how the scoring algorithm works
- [Cost Tracking](/concepts/cost-tracking) — monitor and control spending
- [Providers](/providers/openai) — detailed provider configuration
