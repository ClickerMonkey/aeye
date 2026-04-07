# Cost Tracking

@aeye provides built-in cost estimation, tracking, and budget enforcement across all AI operations.

## Usage in Responses

Every response includes token usage and cost:

```typescript
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Hello' }],
});

console.log(response.usage?.text?.input);   // input tokens
console.log(response.usage?.text?.output);  // output tokens
console.log(response.usage?.text?.cached);  // cached input tokens
console.log(response.usage?.cost);          // total cost in dollars
```

## Usage Structure

The `Usage` type covers all modalities:

```typescript
interface Usage {
  text?: {
    input?: number;    // input tokens
    output?: number;   // output tokens
    cached?: number;   // cached input tokens
  };
  audio?: {
    input?: number;    // audio input tokens
    output?: number;   // audio output tokens
    seconds?: number;  // audio duration
  };
  image?: {
    input?: number;
    output?: ImageOutputUsage[];
  };
  reasoning?: {
    input?: number;    // reasoning input tokens
    output?: number;   // reasoning output tokens
    cached?: number;
  };
  embeddings?: {
    count?: number;    // number of embeddings
    tokens?: number;   // total tokens
  };
  cost?: number;       // total cost in dollars
}
```

## Model Pricing

Models declare their pricing per million tokens:

```typescript
interface ModelPricing {
  text?: {
    input: number;     // $/M input tokens
    output: number;    // $/M output tokens
    cached?: number;   // $/M cached tokens (usually cheaper)
  };
  audio?: {
    input?: number;
    output?: number;
    perSecond?: number;
  };
  image?: {
    input?: number;
    output?: Array<{ quality: string; sizes: Array<{ cost: number }> }>;
  };
  reasoning?: {
    input: number;
    output: number;
    cached?: number;
  };
  embeddings?: { cost: number };
  perRequest?: number; // fixed cost per request
}
```

## Cost Estimation

Before each request, @aeye estimates cost using token counts and model pricing:

```typescript
// Estimate tokens for a message
const usage = ai.estimateMessageUsage(message);

// Estimate tokens for a full request
const usage = ai.estimateRequestUsage(request);

// Calculate cost for usage
const cost = ai.calculateCost(model, usage);
```

## Budget Enforcement with Hooks

Use the `beforeRequest` hook to enforce budgets:

```typescript
interface AppContext {
  user: { budgetRemaining: number; totalSpent: number };
}

const ai = AI.with<AppContext>()
  .providers({ openai })
  .create()
  .withHooks({
    beforeRequest: async (ctx, request, selected, estimatedUsage, estimatedCost) => {
      if (estimatedCost > ctx.user.budgetRemaining) {
        throw new Error(
          `Request cancelled: $${estimatedCost.toFixed(4)} exceeds ` +
          `budget $${ctx.user.budgetRemaining.toFixed(4)}`
        );
      }
    },
    afterRequest: async (ctx, request, response, complete, selected, usage, cost) => {
      ctx.user.budgetRemaining -= cost;
      ctx.user.totalSpent += cost;
    },
  });
```

## Accumulated Usage

For streaming responses, usage accumulates across chunks:

```typescript
import { accumulateUsage, getInputTokens, getOutputTokens } from '@aeye/core';

const totalUsage: Usage = {};

for await (const chunk of ai.chat.stream({ messages })) {
  if (chunk.usage) {
    accumulateUsage(totalUsage, chunk.usage);
  }
}

console.log('Total input:', getInputTokens(totalUsage));
console.log('Total output:', getOutputTokens(totalUsage));
```

## Library Statistics

Track aggregate cost across all requests:

```typescript
const stats = ai.stats();

console.log(stats.totalRequests);
console.log(stats.successfulRequests);
console.log(stats.averageCost);
console.log(stats.averageLatency);
```

## Token Estimation Configuration

Customize how tokens are estimated from content:

```typescript
const ai = AI.with()
  .providers({ openai })
  .create({
    tokens: {
      textDivisor: 4,          // chars per token for text
      textBase64Divisor: 3,    // chars per token for base64 text
      textFallback: 100,       // fallback token count
      imageDivisor: 1000,      // bytes per token for images
      imageBase64Divisor: 750,
      imageFallback: 500,
      audioDivisor: 1000,
      audioBase64Divisor: 750,
      audioFallback: 200,
    },
    defaultCostPerMillionTokens: 5.0, // fallback pricing
  });
```
