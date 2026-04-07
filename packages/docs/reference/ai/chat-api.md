# ChatAPI

The primary API for text-based AI interactions.

## Methods

### `get(request, ctx?)`

Non-streaming chat completion:

```typescript
const response: Response = await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hello' }] },
  ctx?
);
```

### `stream(request, ctx?)`

Streaming chat completion:

```typescript
for await (const chunk: Chunk of ai.chat.stream({ messages }, ctx?)) {
  if (chunk.content) process.stdout.write(chunk.content);
}
```

### `createExecutor()`

Create a standalone executor function:

```typescript
const execute: Executor = ai.chat.createExecutor();
const response = await execute(request, ctx, model);
```

### `createStreamer()`

Create a standalone streamer function:

```typescript
const stream: Streamer = ai.chat.createStreamer();
for await (const chunk of stream(request, ctx, model)) { /* ... */ }
```

## Capability Detection

ChatAPI automatically detects required capabilities from the request:

| Condition | Capability |
|-----------|-----------|
| Always | `chat` |
| Images in messages | `vision` |
| Audio in messages | `hearing` |
| `request.reason` set | `reasoning` |
| `responseFormat: 'json'` | `json` |
| `responseFormat: { type: zodSchema }` | `structured` |
| `request.tools` present | `tools` |
| Stream mode | `streaming` |

## Request Type

See [Request](/reference/core/types#request) in @aeye/core types.

## Response Types

- **`get()`** returns [`Response`](/reference/core/types#response)
- **`stream()`** yields [`Chunk`](/reference/core/types#chunk)
