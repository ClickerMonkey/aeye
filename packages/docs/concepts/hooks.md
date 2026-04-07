# Hooks & Lifecycle

@aeye provides a hook system that lets you intercept, modify, and react to AI operations at every stage.

## Hook Types

There are two levels of hooks:

1. **AI-level hooks** — fire for every request across all providers
2. **Provider-level hooks** — fire only for that specific provider

## AI-Level Hooks

Set via `ai.withHooks()`:

```typescript
const ai = AI.with<AppContext>()
  .providers({ openai })
  .create()
  .withHooks({
    beforeModelSelection,
    onModelSelected,
    beforeRequest,
    afterRequest,
    onError,
  });
```

### `beforeModelSelection`

Called before the model registry scores and selects a model. Allows modifying metadata to influence selection.

```typescript
beforeModelSelection: async (ctx, request, metadata) => {
  // Force a specific model for certain users
  if (ctx.user.tier === 'premium') {
    return { ...metadata, tier: 'flagship' };
  }
  return metadata;
}
```

### `onModelSelected`

Called after a model is selected. Allows overriding the selection or modifying the request configuration.

```typescript
onModelSelected: async (ctx, request, selected) => {
  console.log(`Selected: ${selected.model.id} from ${selected.provider.name}`);
  // Return a different SelectedModel to override, or void to accept
}
```

### `beforeRequest`

Called just before the API request is made. Receives estimated usage and cost. **Throw to cancel the request.**

```typescript
beforeRequest: async (ctx, request, selected, estimatedUsage, estimatedCost) => {
  console.log(`Requesting ${selected.model.id}, est. cost: $${estimatedCost.toFixed(4)}`);

  // Cancel if too expensive
  if (estimatedCost > ctx.user.budget) {
    throw new Error('Over budget');
  }
}
```

### `afterRequest`

Called after a successful response. Receives actual usage and cost.

```typescript
afterRequest: async (ctx, request, response, responseComplete, selected, usage, cost) => {
  // Track spending
  await db.logUsage({
    userId: ctx.userId,
    model: selected.model.id,
    tokens: usage.text?.input ?? 0 + (usage.text?.output ?? 0),
    cost,
  });
}
```

The `response` parameter is the raw provider response. `responseComplete` is the normalized `Response` object.

### `onError`

Called when any error occurs during an AI operation.

```typescript
onError: (errorType, message, error, ctx, request) => {
  // errorType examples:
  // 'no-model-found', 'chat-failed', 'chat-stream-failed',
  // 'image-generate-failed', 'speech-failed', etc.

  logger.error(`AI Error [${errorType}]: ${message}`, error);
}
```

## Provider-Level Hooks

Each provider has its own hook system that fires for operations on that provider only:

```typescript
const openai = new OpenAIProvider({
  apiKey: '...',
  hooks: {
    chat: {
      beforeRequest: (request, params, ctx, metadata) => { /* ... */ },
      afterRequest: (request, response, responseComplete, ctx, metadata) => { /* ... */ },
      onError: (request, params, error, ctx, metadata) => { /* ... */ },
    },
    // imageGenerate, embed, etc. also available
  },
});
```

Provider hooks receive provider-specific types (e.g., OpenAI SDK types) rather than normalized @aeye types.

## Hook Execution Order

For a typical chat request:

```
1. beforeModelSelection  (AI hook)
2. Model scoring & selection
3. onModelSelected       (AI hook)
4. beforeRequest         (AI hook)
5. Provider beforeRequest (provider hook)
6. API call
7. Provider afterRequest  (provider hook)
8. afterRequest          (AI hook)
```

If an error occurs at any step:

```
→ Provider onError (if provider step)
→ onError (AI hook)
```

## Component-Level Events

Tools, Prompts, and Agents emit events via the `Instance` system:

```typescript
import { withEvents } from '@aeye/core';

const events = {
  onStatus: (instance) => {
    console.log(`${instance.component.name}: ${instance.status}`);
  },
  onChild: (parent, child) => {
    console.log(`${parent.component.name} spawned ${child.component.name}`);
  },
  onPromptEvent: (instance, event) => {
    console.log(`Prompt event: ${event.type}`);
  },
};

const runner = withEvents(events);
const result = await myAgent.run(input, { runner });
```

See [Prompt Events](/reference/core/prompt#events) for the full list of prompt events.
