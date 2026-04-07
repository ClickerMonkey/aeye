# @aeye/core — Utilities

Utility functions exported from `@aeye/core`.

## Resource Conversion

Convert between different resource formats (URL, base64, stream, text, file):

### `toURL(input, mimeType?, fallback?)`

Convert a resource to a URL or data URI.

```typescript
const url = await toURL(imageBuffer, 'image/png');
```

### `toBase64(input, mimeType?, fallback?)`

Convert a resource to a base64 data URI.

```typescript
const dataUri = await toBase64(imageBuffer, 'image/png');
```

### `toText(input, fallback?)`

Convert a resource to a text string.

```typescript
const text = await toText(response.body);
```

### `toStream(input, fallback?)`

Convert a resource to a Node.js `Readable` stream.

```typescript
const stream = await toStream(audioData);
```

### `toReadableStream(input, fallback?)`

Convert a resource to a Web `ReadableStream`.

### `toFile(input, mimeType?, filename?)`

Convert a resource to a `File` object.

### `getResourceFormat(resource)`

Detect the best format for a resource: `'url'`, `'base64'`, or `'stream'`.

## Usage Utilities

### `accumulateUsage(target, add?)`

Accumulate usage statistics:

```typescript
const total: Usage = {};
accumulateUsage(total, response1.usage);
accumulateUsage(total, response2.usage);
```

### `getInputTokens(usage?)`

Get total input tokens across all modalities.

### `getOutputTokens(usage?)`

Get total output tokens across all modalities.

### `getTotalTokens(usage?)`

Get total tokens (input + output) across all modalities.

## Response Utilities

### `getResponseFromChunks(chunks, model?)`

Build a complete `Response` from an array of `Chunk`s:

```typescript
const chunks = [];
for await (const chunk of stream) { chunks.push(chunk); }
const response = getResponseFromChunks(chunks);
```

### `getChunksFromResponse(response)`

Convert a `Response` back to an array of `Chunk`s.

### `getModel(input)`

Extract a `Model` from a `ModelInput` (string or Model object).

## Reasoning Utilities

### `getReasoningText(reasoning?)`

Extract plain text from a `Reasoning` object.

### `accumulateReasoning(target?, add?)`

Merge reasoning data from multiple sources.

## Async Utilities

### `isPromise<T>(value)`

Type guard for promises.

### `isAsyncGenerator(value)`

Type guard for async generators.

### `isSettled(p)`

Check if a promise has settled (resolved or rejected).

### `resolve(input)`

Resolve a value that may be a promise, generator, or function.

### `consumeAll<E>(gen)`

Consume an async generator into an array.

### `yieldAll<T>(promises)`

Yield promises as they settle (race pattern).

## Component Events

### `withEvents(events)`

Create a `Runner` that tracks component instance lifecycle:

```typescript
const runner = withEvents({
  onStatus: (instance) => console.log(instance.status),
  onChild: (parent, child) => console.log(`${parent.name} → ${child.name}`),
  onPromptEvent: (instance, event) => console.log(event.type),
});

const result = await agent.run(input, { runner });
```
