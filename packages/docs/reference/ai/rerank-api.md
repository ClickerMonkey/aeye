# RerankAPI

Orders documents by relevance to a query. Only supports `.get()` (no streaming). See the [Reranking guide](/guides/rerank).

## Methods

### `get(request, ctx?)`

```typescript
const { results } = await ai.rerank.get({
  query: 'capital of France',
  documents: ['Paris is the capital of France.', 'Berlin is the capital of Germany.'],
  topN: 1,
});
```

Selects a model with the `rerank` capability.

## Request: `RerankRequest`

```typescript
interface RerankRequest {
  query: string;
  documents: string[];
  topN?: number;          // how many of the most relevant to return (default all)
  model?: ModelInput;
  extra?: Record<string, any>;
}
```

## Response: `RerankResponse`

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

Results are sorted most relevant first.

## Providers

A provider offers reranking by implementing `rerank(request, ctx, config?)`. `@aeye/openrouter` does, through its `/rerank` endpoint (default model `cohere/rerank-v3.5`).

::: warning
Streaming is not supported for reranking. Calling `ai.rerank.stream()` will throw an error.
:::
