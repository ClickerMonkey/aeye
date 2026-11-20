# EmbedAPI

Text and image embedding API. Only supports `.get()` (no streaming).

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
  inputs?: EmbeddingInput[]; // texts and images to embed, one vector each, in order
  texts?: string[];          // text-only shorthand for inputs (give one or the other)
  dimensions?: number;       // output dimensions (if supported)
}

type EmbeddingInput = string | EmbeddingImage;
interface EmbeddingImage {
  image: Resource;           // http(s)/data/file URL, bytes, Blob or stream, as in chat
  mimeType?: string;         // for bytes that carry none (default image/png)
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

Images need a model with `imageEmbedding` (selected automatically); `crossModalEmbedding` marks models whose text and image vectors share one space. Helpers: `embeddingInputs`, `embeddingTexts` (throws `ImageEmbeddingError` on images), `singleEmbeddingInput`, `isEmbeddingImage`, `embeddingImageURL`, `embeddingImageBase64`, `estimateEmbeddingUsage`.

::: warning
Streaming is not supported for embeddings. Calling `ai.embed.stream()` will throw an error.
:::
