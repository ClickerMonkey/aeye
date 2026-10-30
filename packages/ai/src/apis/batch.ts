/**
 * Batch API
 *
 * Runs many chat requests as one batch at the provider: typically half the
 * price of running them one by one, with results within about a day.
 *
 * @example
 * ```typescript
 * const job = await ai.batch.submit(reviews.map(review => ({
 *   messages: [{ role: 'user', content: `Classify: ${review}` }],
 * })), {});
 *
 * const done = await ai.batch.wait(job, {});
 * for (const result of done.results ?? []) {
 *   console.log(result.response?.content ?? result.error);
 * }
 * ```
 */

import type { AI } from '../ai';
import type {
  AIBaseTypes,
  AIContextAny,
  AIContextRequired,
  BatchJob,
  BatchStatus,
  Request,
} from '../types';

/**
 * Statuses a batch never leaves.
 */
const FINAL: ReadonlySet<BatchStatus> = new Set<BatchStatus>(['completed', 'failed', 'expired', 'cancelled']);

/**
 * Options for waiting on a batch.
 */
export interface BatchWaitOptions {
  // Milliseconds between checks. Default 30 seconds.
  interval?: number;
  // Stops waiting when aborted
  signal?: AbortSignal;
}

/**
 * BatchAPI submits chat requests as provider batches and collects their results.
 *
 * @template T - AIBaseTypes container with all type information
 */
export class BatchAPI<T extends AIBaseTypes> {
  constructor(private ai: AI<T>) {}

  /**
   * Submit chat requests to run as one batch on one model. The model is
   * selected for the first request, so pin one with `metadata.model` when
   * the requests differ in what they need.
   *
   * @param requests - The chat requests, whose results come back in this order.
   * @param ctx - The context.
   */
  async submit(requests: Request[], ctx: AIContextRequired<T>): Promise<BatchJob> {
    const [first] = requests;
    if (!first) {
      throw new Error('A batch needs at least one request');
    }

    const fullCtx = await this.ai.buildContext(ctx);
    const selected = await this.ai.chat.getModelFor(first, fullCtx, false);
    if (!selected?.provider.submitBatch) {
      throw new Error(`No model found that can run a batch${selected ? `: ${selected.model.provider} does not offer batches` : ''}`);
    }

    // The provider reads the selected model from the context, as for chat
    const providerCtx: AIContextAny = { ...fullCtx, metadata: { ...fullCtx.metadata, model: selected.model } };
    return selected.provider.submitBatch(requests, providerCtx, selected.providerConfig);
  }

  /**
   * The batch as it stands now, with results once it completes.
   *
   * @param job - A batch from `submit`.
   * @param ctx - The context.
   */
  async get(job: BatchJob, ctx: AIContextRequired<T>): Promise<BatchJob> {
    const provider = this.ai.registry.getProvider(job.provider);
    if (!provider?.getBatch) {
      throw new Error(`Provider "${job.provider}" does not offer batches`);
    }
    return provider.getBatch(job, await this.ai.buildContext(ctx));
  }

  /**
   * Check the batch until it finishes, then return it with its results.
   *
   * @param job - A batch from `submit`.
   * @param ctx - The context.
   * @param options - How often to check, and when to stop.
   */
  async wait(job: BatchJob, ctx: AIContextRequired<T>, options: BatchWaitOptions = {}): Promise<BatchJob> {
    const { interval = 30_000, signal } = options;
    let current = await this.get(job, ctx);
    while (!FINAL.has(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      signal?.throwIfAborted();
      current = await this.get(current, ctx);
    }
    return current;
  }
}
