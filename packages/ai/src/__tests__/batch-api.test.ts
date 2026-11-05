/**
 * Batch API Tests
 */

import { AI } from '../ai';
import type { AIContextAny, BatchJob, BatchResult, Request, Usage } from '../types';
import { createMockProvider } from './mocks/provider.mock';

const results: BatchResult[] = [{ response: { content: 'ok', toolCalls: [], finishReason: 'stop', model: 'mock-chat-efficient', usage: { text: { input: 10, output: 2 } } } }];
const ask = (content: string): Request => ({ messages: [{ role: 'user', content }] });
const job = (status: BatchJob['status']): BatchJob => ({ id: 'b1', provider: 'mock', model: 'mock-chat-efficient', status });

function setup() {
  const submitted: { requests: Request[]; ctx: AIContextAny }[] = [];
  const statuses: BatchJob['status'][] = ['in_progress', 'completed'];
  const provider = {
    ...createMockProvider({ name: 'mock' }),
    submitBatch: async (requests: Request[], ctx: AIContextAny) => {
      submitted.push({ requests, ctx });
      return job('validating');
    },
    getBatch: async () => {
      const status = statuses.shift() ?? 'completed';
      return status === 'completed'
        ? { ...job(status), cost: 0.002, results }
        : job(status);
    },
  };
  const ai = AI.with().providers({ mock: provider }).create({});
  return { ai, submitted };
}

describe('BatchAPI', () => {
  it('submits to the provider of the selected model, passing that model', async () => {
    const { ai, submitted } = setup();
    await ai.models.refresh();

    const result = await ai.batch.submit([{ messages: [{ role: 'user', content: 'Hi' }] }], { metadata: { model: 'mock-chat-efficient' } });

    expect(result.status).toBe('validating');
    expect(submitted[0].requests).toHaveLength(1);
    expect(submitted[0].ctx.metadata?.model).toMatchObject({ id: 'mock-chat-efficient' });
  });

  it('waits until the batch finishes', async () => {
    const { ai } = setup();

    const done = await ai.batch.wait(job('validating'), {}, { interval: 1 });

    expect(done.status).toBe('completed');
    expect(done.results?.map(r => r.response?.content)).toEqual(['ok']);
  });

  it('rejects an empty batch', async () => {
    const { ai } = setup();
    await expect(ai.batch.submit([], {})).rejects.toThrow('at least one request');
  });

  it('runs beforeRequest for each request, and can stop the batch', async () => {
    const { ai, submitted } = setup();
    await ai.models.refresh();
    const seen: number[] = [];
    ai.withHooks({
      beforeRequest: (ctx, request, selected, usage, cost) => {
        seen.push(cost);
        if (seen.length === 2) {
          throw new Error('Over budget');
        }
      },
    });

    await expect(ai.batch.submit([ask('One'), ask('Two')], { metadata: { model: 'mock-chat-efficient' } })).rejects.toThrow('Over budget');

    expect(seen).toHaveLength(2);
    expect(submitted).toHaveLength(0);
  });

  it('reports a completed batch to afterBatch once, at the provider cost when given', async () => {
    const { ai } = setup();
    const reports: Array<{ cost: number; usage: Usage }> = [];
    ai.withHooks({ afterBatch: (ctx, job, usage, cost) => { reports.push({ cost, usage }); } });

    await ai.batch.wait(job('validating'), {}, { interval: 1 });
    await ai.batch.get(job('completed'), {});

    expect(reports).toEqual([{ cost: 0.002, usage: { text: { input: 10, output: 2 } } }]);
  });
});
