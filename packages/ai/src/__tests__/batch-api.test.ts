/**
 * Batch API Tests
 */

import { AI } from '../ai';
import type { AIContextAny, BatchJob, Request } from '../types';
import { createMockProvider } from './mocks/provider.mock';

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
      return { ...job(status), results: status === 'completed' ? [{ error: 'none' }] : undefined };
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
    expect(done.results).toEqual([{ error: 'none' }]);
  });

  it('rejects an empty batch', async () => {
    const { ai } = setup();
    await expect(ai.batch.submit([], {})).rejects.toThrow('at least one request');
  });
});
