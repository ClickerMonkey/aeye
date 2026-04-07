# Budget & Cost Control

Control AI spending with hooks, cost tracking, and model selection constraints.

## Budget Enforcement

Use `beforeRequest` to block expensive requests:

```typescript
interface AppContext {
  user: {
    id: string;
    budgetRemaining: number;
    totalSpent: number;
    save: () => Promise<void>;
  };
}

const ai = AI.with<AppContext>()
  .providers({ openai })
  .create()
  .withHooks({
    beforeRequest: async (ctx, request, selected, estimatedUsage, estimatedCost) => {
      if (estimatedCost > ctx.user.budgetRemaining) {
        throw new Error(
          `Estimated cost $${estimatedCost.toFixed(4)} exceeds ` +
          `remaining budget $${ctx.user.budgetRemaining.toFixed(4)}`
        );
      }
      console.log(
        `[${ctx.user.id}] ${selected.model.id}, est: $${estimatedCost.toFixed(4)}`
      );
    },

    afterRequest: async (ctx, request, response, complete, selected, usage, cost) => {
      ctx.user.budgetRemaining -= cost;
      ctx.user.totalSpent += cost;
      await ctx.user.save();
    },
  });
```

## Price Constraints

Limit model selection to cheap models:

```typescript
const response = await ai.chat.get(
  { messages },
  {
    metadata: {
      pricing: {
        max: {
          text: { input: 1, output: 2 }, // max $/M tokens
        },
      },
    },
  }
);
```

## Weight-Based Cost Control

Prioritize cost in model selection:

```typescript
const response = await ai.chat.get(
  { messages },
  { metadata: { weights: { cost: 0.9, speed: 0.05, accuracy: 0.05 } } }
);
```

Or use a named profile:

```typescript
const ai = AI.with()
  .providers({ openai, openrouter })
  .create({
    weightProfiles: {
      budget: { cost: 0.9, speed: 0.05, accuracy: 0.05 },
    },
  });

await ai.chat.get(
  { messages },
  { metadata: { weightProfile: 'budget' } }
);
```

## Per-User Budgets in Agents

```typescript
const budgetAgent = ai.agent({
  name: 'smartAgent',
  refs: [expensivePrompt, cheapPrompt] as const,
  call: async (input, [expensive, cheap], ctx) => {
    if (ctx.user.budgetRemaining > 0.10) {
      return expensive.get('result', input, ctx);
    }
    return cheap.get('result', input, ctx);
  },
});
```

## Monitoring Costs

```typescript
const stats = ai.stats();
console.log(`Total requests: ${stats.totalRequests}`);
console.log(`Average cost: $${stats.averageCost.toFixed(4)}`);
console.log(`Average latency: ${stats.averageLatency.toFixed(0)}ms`);
```
