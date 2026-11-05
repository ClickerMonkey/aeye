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

A provider that rejects a schema it was sent (a 400 naming the response format or a tool's parameters) throws `SchemaRejectedError` from `@aeye/core` instead, with a `target` of `{ kind: 'output' }`, `{ kind: 'tool', name }`, or `{ kind: 'tools' }`. Prompts recover from it on their own; see [schema fallbacks](./structured-output.md#schema-delivery-and-fallbacks).

### Model Mistakes vs Tool Failures

Every prompt failure says who caused it, with `kind: 'model' | 'tool'`:

| Error | `kind` | Cause |
|-------|--------|-------|
| `ToolInputError` | `model` | An unknown tool, or arguments that don't parse or match the tool's schema (`rawArgs` keeps them) |
| `OutputValidationError` | `model` | Output that isn't JSON, fails the schema, or fails `validate` (`reason`, raw `output`) |
| `ReviewRejectedError` | `model` | The [review](../components/prompts.md#review--reviewing-the-output) still had feedback after `reviewRetries` (`output`, `feedback`) |
| `ToolExecutionError` | `tool` | The tool's own code threw, or `onToolIntercept` / `onToolResult` did (`cause` is the thrown error) |
| `PromptError` | either | What a prompt throws when it gives up; `cause` is the last failure above |

Model mistakes are fed back to the model for another try, within `toolRetries` and `outputRetries`. The kind shows up on the `toolError` event's `failure`, on the tool result message's `failure`, on the `textReset` event's `error`, and on the thrown `PromptError`:

```typescript
import { PromptError } from '@aeye/core';

for await (const event of prompt.get('stream', input)) {
  if (event.type === 'toolError') {
    show(event.failure.kind === 'model'
      ? `The model made a mistake calling ${event.failure.tool} (retrying)`
      : `${event.failure.tool} failed: ${event.failure.message}`);
  }
}

try {
  await prompt.get('result', input);
} catch (error) {
  if (error instanceof PromptError) {
    console.log(error.kind, error.cause); // 'model' | 'tool', the last failure
  }
}
```

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
| `reviewRetries` | 1 | Rounds the model gets to answer review feedback |

```typescript
const prompt = ai.prompt({
  outputRetries: 3,
  toolRetries: 3,
  forgetRetries: 2,
});
```

A schema a provider rejects doesn't use these: the prompt steps down its `schemaFallbacks` instead.

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

// The model sees: "Error executing tool: Not found: xyz, ..."
// It can retry with a different ID
```

The `toolError` event's `failure` is a `ToolExecutionError` (`kind: 'tool'`) here; a call with bad arguments gives a `ToolInputError` (`kind: 'model'`).

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
