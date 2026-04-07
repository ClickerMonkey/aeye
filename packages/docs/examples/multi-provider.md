# Multi-Provider Fallback

Use multiple providers with automatic model selection and manual fallback logic.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { AWSBedrockProvider } from '@aeye/aws';

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
const openrouter = new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY! });
const aws = new AWSBedrockProvider({ region: 'us-east-1' });

const ai = AI.with()
  .providers({ openai, openrouter, aws })
  .create({
    defaultWeights: {
      cost: 0.4,
      speed: 0.3,
      accuracy: 0.3,
    },
    weightProfiles: {
      cheap: { cost: 0.9, speed: 0.05, accuracy: 0.05 },
      fast: { cost: 0.1, speed: 0.8, accuracy: 0.1 },
      precise: { cost: 0.1, speed: 0.1, accuracy: 0.8 },
    },
  });

// Automatic selection — @aeye picks the best model
const auto = await ai.chat.get({
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(`Auto-selected: ${auto.model?.id}`);

// Provider-specific — force a provider
const fromOpenAI = await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hello' }] },
  { metadata: { providers: { allow: ['openai'] } } }
);

// Capability-based — find a model with specific features
const withVision = await ai.chat.get(
  {
    messages: [{
      role: 'user',
      content: [
        { type: 'text', content: 'Describe this' },
        { type: 'image', content: 'https://example.com/img.png' },
      ],
    }],
  },
  { metadata: { required: ['vision', 'chat'] } }
);

// Manual fallback — try providers in order
async function chatWithFallback(messages: any[]) {
  const providers = ['openai', 'openrouter', 'aws'];

  for (const provider of providers) {
    try {
      return await ai.chat.get(
        { messages },
        { metadata: { providers: { allow: [provider] } } }
      );
    } catch (error) {
      console.warn(`${provider} failed, trying next...`);
    }
  }

  throw new Error('All providers failed');
}

const response = await chatWithFallback([
  { role: 'user', content: 'Hello from fallback!' },
]);
console.log(response.content);
```
