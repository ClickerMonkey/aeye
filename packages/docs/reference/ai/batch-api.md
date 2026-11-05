# BatchAPI

Runs chat requests as one provider batch: about half the price, with results within a day. See the [Batches guide](/guides/batch).

## Methods

### `submit(requests, ctx)`

Submit chat requests to run as one batch on one model. The model is selected for the first request, so pin one with `metadata.model` when the requests differ in what they need. Throws when there are no requests, or when the selected model's provider doesn't offer batches.

```typescript
const job = await ai.batch.submit([
  { messages: [{ role: 'user', content: 'Summarize: ...' }] },
  { messages: [{ role: 'user', content: 'Summarize: ...' }] },
], { metadata: { model: 'gpt-5.4-mini' } });
```

### `get(job, ctx)`

The batch as it stands now, with `results` once it completes.

```typescript
const current = await ai.batch.get(job, {});
```

### `wait(job, ctx, options?)`

Check the batch until it reaches `completed`, `failed`, `expired`, or `cancelled`, then return it.

```typescript
const done = await ai.batch.wait(job, {}, { interval: 60_000 });
```

```typescript
interface BatchWaitOptions {
  interval?: number;     // milliseconds between checks (default 30 seconds)
  signal?: AbortSignal;  // stops waiting when aborted
}
```

## Types

### `BatchJob`

```typescript
interface BatchJob {
  id: string;
  provider: string;            // provider running the batch
  model: string;               // model every request runs on
  status: BatchStatus;
  counts?: { total: number; completed: number; failed: number };
  error?: string;              // why the batch failed, when it did
  cost?: number;               // dollars billed, where the provider reports it (OpenRouter)
  results?: BatchResult[];     // one per request, in request order, once complete
}
```

### `BatchResult`

```typescript
interface BatchResult {
  response?: Response;
  error?: string;              // set when this request failed
}
```

### `BatchStatus`

```typescript
type BatchStatus = 'validating' | 'in_progress' | 'finalizing' | 'completed'
  | 'failed' | 'expired' | 'cancelling' | 'cancelled';
```

## Providers

A provider offers batches by implementing `submitBatch(requests, ctx, config?)` and `getBatch(job, ctx, config?)`. `@aeye/openai` (JSONL upload, 24 hour window) and `@aeye/openrouter` (inline `/batches`) do.

::: info
`ai.batch` doesn't run the AI hooks, so `beforeRequest` / `afterRequest` don't see batched requests.
:::
