# Batches

Run many chat requests as one batch at the provider. A batch costs about half as much as the same requests sent one by one, and finishes within a day (often much sooner).

## When to Use

Use a batch when nobody is waiting on the answers:

- classifying or summarizing a backlog of documents
- generating evaluation data, or grading model output
- nightly enrichment jobs

For anything interactive, use [`ai.chat`](/guides/chat). For fast, cheap classification of a single input, see [Decisions](/guides/decisions).

## Basic Usage

```typescript
const reviews = [
  'Arrived broken, and support never answered.',
  'Exactly as described. Would buy again.',
];

const job = await ai.batch.submit(
  reviews.map(review => ({
    messages: [{ role: 'user', content: `Is this review positive or negative? Answer in one word.\n\n${review}` }],
  })),
  {},
);

const done = await ai.batch.wait(job, {});

done.results?.forEach((result, i) => {
  console.log(reviews[i], '=>', result.response?.content ?? result.error);
});
```

`submit` returns a `BatchJob` right away. `wait` checks it every 30 seconds until it finishes, then returns it with its results.

## Results

Results come back in request order: `results[i]` is the outcome of `requests[i]`. A request that failed has `error` instead of `response`, and the rest of the batch still completes.

```typescript
interface BatchJob {
  id: string;
  provider: string;            // provider running the batch
  model: string;               // model every request runs on
  status: BatchStatus;
  counts?: { total: number; completed: number; failed: number };
  error?: string;              // why the batch failed, when it did
  results?: BatchResult[];     // one per request, once the batch completes
}

interface BatchResult {
  response?: Response;
  error?: string;
}

type BatchStatus = 'validating' | 'in_progress' | 'finalizing' | 'completed'
  | 'failed' | 'expired' | 'cancelling' | 'cancelled';
```

A batch is finished once its status is `completed`, `failed`, `expired`, or `cancelled`.

## Checking Later

A `BatchJob` is plain data, so you can store it and check on it from another process:

```typescript
import type { BatchJob } from '@aeye/ai';

const job = await ai.batch.submit(requests, {});
await db.save('nightly-batch', JSON.stringify(job));

// Later, possibly after a restart
const saved: BatchJob = JSON.parse(await db.load('nightly-batch'));
const current = await ai.batch.get(saved, {});

if (current.status === 'completed') {
  // current.results is set
}
```

`wait` takes an interval in milliseconds and an abort signal:

```typescript
const controller = new AbortController();
const done = await ai.batch.wait(job, {}, { interval: 60_000, signal: controller.signal });
```

## Model Selection

Every request in a batch runs on one model. It is selected for the first request, the same way `ai.chat` selects one, so pin a model when the requests differ in what they need:

```typescript
const job = await ai.batch.submit(requests, {
  metadata: { model: 'gpt-5.4-mini' },
});
```

The selected model's provider must offer batches, or `submit` throws.

## Provider Support

| Provider | How | Notes |
|----------|-----|-------|
| OpenAI | Uploads the requests as a JSONL file, then creates a batch with a 24 hour window | About 50% of the normal price. Requests go to Chat Completions, or to the Responses API when any of them needs it. |
| OpenRouter | Posts the requests inline to `/batches` | Results come back inline when the batch completes. |

Replicate and AWS Bedrock don't offer batches through @aeye.

## Costs

The provider bills batch requests at its batch price. Each result's `response.usage` carries the token counts the provider reported; OpenRouter reports the batch's total in `job.cost` (with BYOK, its fee plus the provider's bill); results carry token counts only.

`ai.batch` doesn't run the AI hooks (`beforeRequest`, `afterRequest`), so budget checks and cost tracking built on them don't see batches. To price results yourself, pass a result's usage to [`ai.calculateCost`](/reference/ai/ai-class#calculatecost-model-usage), and keep in mind that it uses the model's regular price.
