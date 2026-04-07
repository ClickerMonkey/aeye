# Embeddings

Generate vector embeddings for text, useful for semantic search, clustering, and similarity comparison.

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
  texts: string[];          // texts to embed
  dimensions?: number;      // output dimensions (if supported)
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

## Provider Support

| Provider | Models |
|----------|--------|
| OpenAI | text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002 |
| AWS Bedrock | Amazon Titan Text Embeddings, Cohere Embed |

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
