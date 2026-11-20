# Embeddings

Generate vector embeddings for text and images, useful for semantic search, clustering, and similarity comparison.

## Basic Usage

```typescript
const response = await ai.embed.get({
  texts: [
    'The quick brown fox jumps over the lazy dog',
    'Machine learning is a subset of artificial intelligence',
  ],
});

response.embeddings.forEach((item, i) => {
  console.log(`Text ${i}: ${item.embedding.length} dimensions`);
});
```

## Request Options

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

## Response Structure

```typescript
interface EmbeddingResponse {
  embeddings: Array<{
    embedding: number[];    // vector
    index: number;          // position in input
  }>;
  usage?: Usage;
}
```

## Cosine Similarity

Compare embeddings to find similar texts:

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

const response = await ai.embed.get({
  texts: ['How do I reset my password?', 'Password reset instructions', 'Weather forecast'],
});

const [query, doc1, doc2] = response.embeddings.map(e => e.embedding);
console.log('Doc 1 similarity:', cosineSimilarity(query, doc1)); // ~0.92
console.log('Doc 2 similarity:', cosineSimilarity(query, doc2)); // ~0.45
```

## Images

Models with the `imageEmbedding` capability embed images too. Give images in
`inputs` beside texts; a request with an image selects only such models.
Models with `crossModalEmbedding` put texts and images in one vector space, so
a text query finds images; require it when you compare across the two.

```typescript
const { embeddings } = await ai.embed.get(
  { inputs: ['a red bicycle', { image: 'https://example.com/bike.jpg' }, { image: pngBytes }] },
  { metadata: { required: ['crossModalEmbedding'] } },
);
```

A text-only model sent an image throws `ImageEmbeddingError` before calling
its provider. Usage counts images in `usage.embeddings.images`, priced by
`pricing.embeddings.perImage` where the provider bills per image; the
estimate before a call counts text at about four characters a token.

## Provider Support

| Provider | Text | Images (one space with text) |
|----------|------|------------------------------|
| OpenAI | text-embedding-3-small/large, ada-002 | — |
| AWS Bedrock | Titan Text Embeddings, Cohere Embed | Titan Multimodal Embeddings, Nova Multimodal Embeddings, Cohere Embed v3/v4 |
| OpenRouter | Any embeddings model | Models whose input modalities include images (multimodal `content` input) |
| Replicate | Text embedders with transformers | CLIP-style models (`krthr/clip-embeddings`, `andreasjansson/clip-features`, `zsxkib/jina-clip-v2`, `daanelson/imagebind`) |
| Ollama | Embedding models | — (Ollama's embed endpoints take text only) |

## Model Selection

```typescript
const response = await ai.embed.get(
  { texts: ['hello'] },
  {
    metadata: {
      model: 'text-embedding-3-large',
      // or let @aeye select:
      required: ['embedding'],
    },
  }
);
```

::: warning
The Embed API only supports `.get()`. Streaming is not available for embeddings.
:::
