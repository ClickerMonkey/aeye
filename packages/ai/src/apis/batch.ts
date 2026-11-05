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

import { accumulateUsage } from '@aeye/core';
import type { AI } from '../ai';
import type {
  AIBaseTypes,
  AIContext,
  AIContextAny,
  AIContextRequired,
  BatchJob,
  BatchStatus,
  Request,
  Usage,
} from '../types';

/**
 * Statuses a batch never leaves.
 */
const FINAL: ReadonlySet<BatchStatus> = new Set<BatchStatus>(['completed', 'failed', 'expired', 'cancelled']);

/**
 * Batch price as a share of the regular price, for providers that don't
 * report a batch's cost: OpenAI and OpenRouter bill batches at half price.
 */
const BATCH_PRICE = 0.5;

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
  // Completed batches already reported to the afterBatch hook
  private readonly reported = new Set<string>();

  constructor(private ai: AI<T>) {}

  /**
   * Submit chat requests to run as one batch on one model. The model is
   * selected for the first request, so pin one with `metadata.model` when
   * the requests differ in what they need. The onModelSelected hook runs
   * once, and beforeRequest runs for each request (so budget checks can
   * stop the batch) with the batch price estimate.
   *
   * @param requests - The chat requests, whose results come back in this order.
   * @param ctx - The context.
   */
  async submit(requests: Request[], ctx: AIContextRequired<T>): Promise<BatchJob> {
    const [first] = requests;
    if (!first) {
      throw new Error('A batch needs at least one request');
    }

    const { hooks } = this.ai;
    const fullCtx = await this.ai.buildContext(ctx);
    const found = await this.ai.chat.getModelFor(first, fullCtx, false);
    const selected = found && ((await hooks.onModelSelected?.(fullCtx, first, found)) || found);
    if (!selected?.provider.submitBatch) {
      throw new Error(`No model found that can run a batch${selected ? `: ${selected.model.provider} does not offer batches` : ''}`);
    }
    for (const request of requests) {
      const usage = this.ai.estimateRequestUsage(request);
      await hooks.beforeRequest?.(fullCtx, request, selected, usage, this.ai.calculateCost(selected.model, usage) * BATCH_PRICE);
    }

    // The provider reads the selected model from the context, as for chat
    const providerCtx: AIContextAny = { ...fullCtx, metadata: { ...fullCtx.metadata, model: selected.model } };
    return selected.provider.submitBatch(requests, providerCtx, selected.providerConfig);
  }

  /**
   * The batch as it stands now, with results once it completes. The first
   * time this sees a batch completed, it reports the batch's usage and cost
   * to the afterBatch hook.
   *
   * @param job - A batch from `submit`.
   * @param ctx - The context.
   */
  async get(job: BatchJob, ctx: AIContextRequired<T>): Promise<BatchJob> {
    const provider = this.ai.registry.getProvider(job.provider);
    if (!provider?.getBatch) {
      throw new Error(`Provider "${job.provider}" does not offer batches`);
    }
    const fullCtx = await this.ai.buildContext(ctx);
    const current = await provider.getBatch(job, fullCtx);
    const key = `${current.provider}:${current.id}`;
    if (current.status === 'completed' && current.results && !this.reported.has(key)) {
      this.reported.add(key);
      await this.report(current, fullCtx);
    }
    return current;
  }

  /**
   * Report a completed batch to the afterBatch hook: the usage of its
   * results, and the cost the provider reported or else the batch price of
   * that usage.
   */
  private async report(job: BatchJob, ctx: AIContext<T>): Promise<void> {
    const usage: Usage = {};
    for (const result of job.results ?? []) {
      accumulateUsage(usage, result.response?.usage);
    }
    const model = this.ai.registry.getModel(job.model);
    const cost = job.cost ?? usage.cost ?? (model ? this.ai.calculateCost(model, usage) * BATCH_PRICE : 0);
    await this.ai.hooks.afterBatch?.(ctx, job, usage, cost);
  }

  /**
   * Check the batch until it finishes, then return it with its results.
   * A running batch is first checked after one interval: a batch just
   * submitted can take a moment to become visible at the provider.
   *
   * @param job - A batch from `submit`.
   * @param ctx - The context.
   * @param options - How often to check, and when to stop.
   */
  async wait(job: BatchJob, ctx: AIContextRequired<T>, options: BatchWaitOptions = {}): Promise<BatchJob> {
    const { interval = 30_000, signal } = options;
    let current = FINAL.has(job.status) ? await this.get(job, ctx) : job;
    while (!FINAL.has(current.status)) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      signal?.throwIfAborted();
      current = await this.get(current, ctx);
    }
    return current;
  }
}
