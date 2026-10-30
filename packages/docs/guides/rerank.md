# Reranking

Order documents by how relevant they are to a query. A reranker reads the query and each document together, so it ranks more accurately than comparing [embeddings](/guides/embeddings), at a higher cost per document.

## When to Use

The usual pattern is two stages: a cheap search (keyword search, or an embedding lookup) finds a few dozen candidates, and a reranker picks the best few to put in front of a chat model. Use it for:

- retrieval-augmented generation, to keep only the passages that answer the question
- search results, to reorder the top hits
- deduplicating or filtering candidates against a description

## Basic Usage

```typescript
const documents = [
  'Paris is the capital and largest city of France.',
  'The Eiffel Tower was completed in 1889.',
  'Berlin is the capital of Germany.',
];

const { results } = await ai.rerank.get({
  query: 'What is the capital of France?',
  documents,
  topN: 2,
});

for (const { index, score } of results) {
  console.log(score.toFixed(3), documents[index]);
}
```

## Request Options

```typescript
interface RerankRequest {
  query: string;
  documents: string[];
  topN?: number;          // how many of the most relevant to return (default all)
  model?: ModelInput;
  extra?: Record<string, any>; // sent as-is in the request body
}
```

## Response Structure

```typescript
interface RerankResponse {
  results: Array<{
    index: number;        // position of the document in the request
    score: number;        // relevance to the query, from 0 to 1
  }>;
  usage?: Usage;
  model: ModelInput;
}
```

Results are sorted most relevant first. Use `index` to find the document.

## Retrieval Example

Embed to find candidates, then rerank them:

```typescript
async function retrieve(question: string, passages: string[], vectors: number[][]): Promise<string[]> {
  const { embeddings } = await ai.embed.get({ texts: [question] });
  const query = embeddings[0].embedding;

  // Stage 1: the 20 nearest passages by cosine similarity
  const candidates = passages
    .map((text, i) => ({ text, similarity: cosineSimilarity(query, vectors[i]) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 20)
    .map(candidate => candidate.text);

  // Stage 2: the 3 most relevant by the reranker
  const { results } = await ai.rerank.get({ query: question, documents: candidates, topN: 3 });
  return results.map(result => candidates[result.index]);
}
```

`cosineSimilarity` is defined in the [Embeddings guide](/guides/embeddings#cosine-similarity).

## Provider Support

| Provider | Endpoint | Models |
|----------|----------|--------|
| OpenRouter | `/rerank` | Cohere (`cohere/rerank-v3.5`, `cohere/rerank-4-fast`, `cohere/rerank-4-pro`), Voyage (`voyageai/rerank-2.5`, `voyageai/rerank-2.5-lite`, ...), Qwen (`qwen/qwen3-reranker-8b`), NVIDIA Nemotron |

OpenRouter's default rerank model is `cohere/rerank-v3.5`; set `defaultModels.rerank` on the provider to change it. The other providers don't offer reranking.

## Model Selection

Rerank requests need the `rerank` capability. Pin a model per request or through metadata:

```typescript
const response = await ai.rerank.get(
  { query, documents },
  { metadata: { model: 'voyageai/rerank-2.5' } },
);
```

## Costs

Rerankers are priced per search rather than per token. OpenRouter reports the cost of each request, and it comes back as `response.usage.cost`, so hooks and [cost tracking](/concepts/cost-tracking) see the real amount.

::: warning
The Rerank API only supports `.get()`. Streaming is not available.
:::
