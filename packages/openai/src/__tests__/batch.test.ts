/**
 * Batch submission and result mapping.
 */

import { AI, type AIContextAny, type Request } from '@aeye/ai';
import { OpenAIProvider } from '../openai';

const mockFilesCreate = jest.fn();
const mockFilesContent = jest.fn();
const mockBatchesCreate = jest.fn();
const mockBatchesRetrieve = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({
  files: { create: mockFilesCreate, content: mockFilesContent },
  batches: { create: mockBatchesCreate, retrieve: mockBatchesRetrieve },
})));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: { model: 'gpt-5.4-mini' } };
const provider = new OpenAIProvider({ apiKey: 'test' });
const ask = (content: string): Request => ({ messages: [{ role: 'user', content }] });
const counts = { total: 3, completed: 2, failed: 1 };

beforeEach(() => jest.clearAllMocks());

describe('batch', () => {
  it('uploads each request as the call a direct request would make', async () => {
    mockFilesCreate.mockResolvedValue({ id: 'file_in' });
    mockBatchesCreate.mockResolvedValue({ id: 'batch_1', status: 'validating', request_counts: { total: 0, completed: 0, failed: 0 } });

    const job = await provider.submitBatch!([ask('One'), { ...ask('Two'), seed: 3 }], ctx);

    const file: File = mockFilesCreate.mock.calls[0][0].file;
    const lines = (await file.text()).split('\n').map(line => JSON.parse(line));
    expect(lines).toEqual([
      expect.objectContaining({ custom_id: '0', method: 'POST', url: '/v1/chat/completions', body: expect.objectContaining({ model: 'gpt-5.4-mini' }) }),
      expect.objectContaining({ custom_id: '1', body: expect.objectContaining({ seed: 3 }) }),
    ]);
    expect(mockBatchesCreate).toHaveBeenCalledWith({ input_file_id: 'file_in', endpoint: '/v1/chat/completions', completion_window: '24h' }, expect.anything());
    expect(job).toMatchObject({ id: 'batch_1', provider: 'openai', model: 'gpt-5.4-mini', status: 'validating' });
  });

  it('uses the Responses endpoint when any request needs it', async () => {
    mockFilesCreate.mockResolvedValue({ id: 'file_in' });
    mockBatchesCreate.mockResolvedValue({ id: 'batch_2', status: 'validating' });

    await provider.submitBatch!([ask('One'), { ...ask('Two'), reason: { summary: 'auto' } }], ctx);

    expect(mockBatchesCreate.mock.calls[0][0].endpoint).toBe('/v1/responses');
  });

  it('maps results back into request order, with failures as errors', async () => {
    mockBatchesRetrieve.mockResolvedValue({ id: 'batch_1', status: 'completed', request_counts: counts, output_file_id: 'out', error_file_id: 'err' });
    const completion = (content: string) => ({ object: 'chat.completion', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
    mockFilesContent.mockImplementation((id: string) => Promise.resolve({
      text: async () => id === 'out'
        ? [{ custom_id: '2', response: { status_code: 200, body: completion('third') } }, { custom_id: '0', response: { status_code: 200, body: completion('first') } }].map(l => JSON.stringify(l)).join('\n')
        : JSON.stringify({ custom_id: '1', response: { status_code: 400, body: { error: { message: 'Bad request' } } } }),
    }));

    const job = await provider.getBatch!({ id: 'batch_1', provider: 'openai', model: 'gpt-5.4-mini', status: 'in_progress' }, ctx);

    expect(job.status).toBe('completed');
    expect(job.counts).toEqual(counts);
    expect(job.results?.map(r => r.response?.content ?? r.error)).toEqual(['first', 'Bad request', 'third']);
    expect(job.results?.[0].response?.usage).toEqual({ text: { input: 5, output: 1 } });
  });

  it('reports a batch still running without results', async () => {
    mockBatchesRetrieve.mockResolvedValue({ id: 'batch_1', status: 'in_progress', request_counts: counts });

    const job = await provider.getBatch!({ id: 'batch_1', provider: 'openai', model: 'gpt-5.4-mini', status: 'validating' }, ctx);

    expect(job.status).toBe('in_progress');
    expect(job.results).toBeUndefined();
    expect(mockFilesContent).not.toHaveBeenCalled();
  });
});
