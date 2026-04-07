# Error Handling

@aeye provides structured error types and multiple layers of error handling.

## Error Types

### Provider Errors

Each provider throws typed errors:

```typescript
import { ProviderError, ProviderAuthError, RateLimitError,
         ProviderQuotaError, ContextWindowError } from '@aeye/openai';

import { AWSError, AWSAuthError, AWSRateLimitError,
         AWSQuotaError, AWSContextWindowError } from '@aeye/aws';
```

| Error | Cause |
|-------|-------|
| `ProviderAuthError` / `AWSAuthError` | Invalid API key or credentials |
| `RateLimitError` / `AWSRateLimitError` | Too many requests |
| `ProviderQuotaError` / `AWSQuotaError` | Account quota exceeded |
| `ContextWindowError` / `AWSContextWindowError` | Input too long |

## AI-Level Error Hook

Catch all errors across all providers:

```typescript
ai.withHooks({
  onError: (errorType, message, error, ctx, request) => {
    console.error(`[${errorType}] ${message}`, error);

    // Common error types:
    // 'no-model-found'
    // 'chat-failed', 'chat-stream-failed'
    // 'image-generate-failed'
    // 'speech-failed'
    // 'transcribe-failed'
    // 'embed-failed'
  },
});
```

## Prompt-Level Retries

Prompts automatically retry on certain failures:

| Setting | Default | Description |
|---------|---------|-------------|
| `outputRetries` | 2 | Retries when output doesn't match schema |
| `toolRetries` | 2 | Retries when tool parsing/execution fails |
| `forgetRetries` | 1 | Retries with context trimming on overflow |

```typescript
const prompt = ai.prompt({
  outputRetries: 3,
  toolRetries: 3,
  forgetRetries: 2,
});
```

## Tool Error Handling

Tool errors are sent back to the model as error messages:

```typescript
const tool = ai.tool({
  name: 'riskyOp',
  schema: z.object({ id: z.string() }),
  call: async ({ id }) => {
    const item = await db.find(id);
    if (!item) throw new Error(`Not found: ${id}`);
    return item;
  },
});

// The model sees: "Tool riskyOp failed: Not found: xyz"
// It can retry with a different ID
```

### Tool Interrupts

Interrupt execution without error:

```typescript
import { ToolInterrupt } from '@aeye/core';

const tool = ai.tool({
  name: 'deleteItem',
  schema: z.object({ id: z.string() }),
  call: async ({ id }, _refs, ctx) => {
    if (!ctx.confirmed) {
      throw new ToolInterrupt('Confirm deletion?');
    }
    // proceed
  },
});
```

### Prompt Suspension

Suspend the entire prompt for user input:

```typescript
import { PromptSuspend } from '@aeye/core';

const tool = ai.tool({
  name: 'askUser',
  schema: z.object({ question: z.string() }),
  call: async ({ question }) => {
    throw new PromptSuspend(question);
  },
});
```

## Try/Catch

```typescript
try {
  const response = await ai.chat.get({ messages });
} catch (error) {
  if (error instanceof RateLimitError) {
    // wait and retry
    await new Promise(r => setTimeout(r, error.retryAfter ?? 5000));
  } else if (error instanceof ContextWindowError) {
    // trim messages and retry
  } else if (error instanceof ProviderAuthError) {
    // check API key
  }
}
```

## Cancellation

Cancel in-flight requests:

```typescript
const controller = new AbortController();

try {
  const response = await ai.chat.get(
    { messages },
    { signal: controller.signal }
  );
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Request cancelled');
  }
}

// Cancel from elsewhere
controller.abort();
```
