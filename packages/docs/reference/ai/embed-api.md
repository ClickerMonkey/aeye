# EmbedAPI

Text embedding API. Only supports `.get()` (no streaming).

## Methods

### `get(request, ctx?)`

```typescript
const response = await ai.embed.get({
  texts: ['Hello world', 'Goodbye world'],
  dimensions: 1536,
});
```

## Request: `EmbeddingRequest`

```typescript
interface EmbeddingRequest {
  texts: string[];
  dimensions?: number;
}
```

## Response: `EmbeddingResponse`

```typescript
interface EmbeddingResponse {
  embeddings: Array<{
    embedding: number[];
    index: number;
  }>;
  usage?: Usage;
}
```

::: warning
Streaming is not supported for embeddings. Calling `ai.embed.stream()` will throw an error.
:::
