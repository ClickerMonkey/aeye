# Budget Control

Track spending per user and enforce budget limits using AI hooks.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';

interface User {
  id: string;
  budgetRemaining: number;
  totalSpent: number;
  save: () => Promise<void>;
}

interface AppContext {
  user: User;
}

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

const ai = AI.with<AppContext>()
  .providers({ openai })
  .create()
  .withHooks({
    beforeRequest: async (ctx, request, selected, estimatedUsage, estimatedCost) => {
      // Block requests that exceed budget
      if (estimatedCost > ctx.user.budgetRemaining) {
        throw new Error(
          `Request cancelled: estimated cost $${estimatedCost.toFixed(4)} ` +
          `exceeds remaining budget $${ctx.user.budgetRemaining.toFixed(4)}`
        );
      }

      console.log(
        `[${ctx.user.id}] Using ${selected.model.id}, ` +
        `estimated cost: $${estimatedCost.toFixed(4)}`
      );
    },

    afterRequest: async (ctx, request, response, responseComplete, selected, usage, cost) => {
      // Deduct actual cost
      ctx.user.budgetRemaining -= cost;
      ctx.user.totalSpent += cost;
      await ctx.user.save();

      console.log(
        `[${ctx.user.id}] Used ${usage.text?.input ?? 0} in / ` +
        `${usage.text?.output ?? 0} out tokens, ` +
        `cost: $${cost.toFixed(4)}, ` +
        `budget remaining: $${ctx.user.budgetRemaining.toFixed(4)}`
      );
    },

    onError: (errorType, message, error, ctx) => {
      console.error(`[AI Error] ${errorType}: ${message}`, error?.message);
    },
  });

// Usage
const user: User = {
  id: 'user123',
  budgetRemaining: 1.00,
  totalSpent: 0,
  save: async () => { /* persist to database */ },
};

try {
  const response = await ai.chat.get(
    { messages: [{ role: 'user', content: 'Explain monads' }] },
    { user }
  );
  console.log(response.content);
} catch (error: any) {
  if (error.message.includes('budget')) {
    console.log('User is over budget!');
  }
}
```
