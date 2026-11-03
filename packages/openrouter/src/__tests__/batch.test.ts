/**
 * OpenRouter batches: requests and results go inline.
 */

import { AI, type AIContextAny } from '@aeye/ai';
import { OpenRouterProvider } from '../openrouter';

const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ post: mockPost, get: mockGet })));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: { model: 'anthropic/claude-haiku-4.5' } };
const provider = new OpenRouterProvider({ apiKey: 'k' });
const counts = { total: 2, completed: 2, failed: 0 };

beforeEach(() => jest.clearAllMocks());

describe('batch', () => {
  it('posts the requests inline', async () => {
    mockPost.mockResolvedValue({ id: 'batch_1', status: 'validating', request_counts: { total: 2, completed: 0, failed: 0 }, error: null, results: null });

    const job = await provider.submitBatch!([
      { messages: [{ role: 'user', content: 'One' }] },
      { messages: [{ role: 'user', content: 'Two' }], reason: { effort: 'low' } },
    ], ctx);

    const [path, { body }] = mockPost.mock.calls[0];
    expect(path).toBe('/batches');
    expect(body).toMatchObject({ endpoint: '/v1/chat/completions', model: 'anthropic/claude-haiku-4.5' });
    expect(body.requests.map((r: { custom_id: string }) => r.custom_id)).toEqual(['0', '1']);
    expect(body.requests[1].body.reasoning).toEqual({ enabled: true, effort: 'low' });
    expect(job).toMatchObject({ id: 'batch_1', provider: 'openrouter', status: 'validating' });
  });

  it('reads inline results, cost included', async () => {
    const body = (content: string) => ({ object: 'chat.completion', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5, cost: 0.0001 } });
    mockGet.mockResolvedValue({
      id: 'batch_1', status: 'completed', request_counts: counts, error: null,
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.00004 } },
      results: [{ custom_id: '1', response: { status_code: 200, body: body('second') } }, { custom_id: '0', response: { status_code: 200, body: body('first') } }],
    });

    const job = await provider.getBatch!({ id: 'batch_1', provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', status: 'in_progress' }, ctx);

    expect(mockGet.mock.calls[0][0]).toBe('/batches/batch_1');
    expect(job.results?.map(r => r.response?.content)).toEqual(['first', 'second']);
    expect(job.results?.[0].response?.usage?.cost).toBe(0.0001);
    expect(job.cost).toBe(0.00004);
  });
});
