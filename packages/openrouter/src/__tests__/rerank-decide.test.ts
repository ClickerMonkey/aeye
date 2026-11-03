/**
 * OpenRouter rerank and System One decisions.
 */

import { AI, type AIContextAny } from '@aeye/ai';
import { OpenRouterProvider } from '../openrouter';

const mockPost = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ post: mockPost, baseURL: 'https://openrouter.ai/api/v1' })));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };
const provider = new OpenRouterProvider({ apiKey: 'k' });

beforeEach(() => jest.clearAllMocks());

describe('rerank', () => {
  it('orders documents by relevance score', async () => {
    mockPost.mockResolvedValue({ model: 'rerank-v3.5', results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }], usage: { search_units: 1, cost: 0.001 } });

    const response = await provider.rerank!({ query: 'capital', documents: ['Berlin', 'Paris'], topN: 2 }, ctx);

    expect(mockPost).toHaveBeenCalledWith('/rerank', expect.objectContaining({ body: { model: 'cohere/rerank-v3.5', query: 'capital', documents: ['Berlin', 'Paris'], top_n: 2 } }));
    expect(response.results).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }]);
    expect(response.usage).toEqual({ cost: 0.001 });
  });
});

describe('decide', () => {
  it('asks System One questions at the alpha endpoint', async () => {
    mockPost.mockResolvedValue({
      model: 'typesafe/jev-1.14-20261014',
      answers: {
        billing: { type: 'noul', noul: 0.95 },
        team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.9, web: 0.1 }, confidence: 0.85 },
        urgency: { type: 'score', score: 1.9, legend: { 0: 'Later', 1: 'Soon', 2: 'Now' }, probabilities: { 2: 0.9, 0: 0, 1: 0.1 }, confidence: 0.8 },
      },
      usage: { input_tokens: 421, output_tokens: 70, cost: 0.00002 },
    });

    const response = await provider.decide!({
      input: 'Charged twice.',
      questions: {
        billing: { type: 'predicate', instructions: 'Billing problem?' },
        team: { type: 'choice', instructions: 'Which team?', choices: { payments: 'Charges', web: 'Bugs' } },
        urgency: { type: 'score', instructions: 'How urgent?', levels: ['Later', 'Soon', 'Now'] },
      },
    }, ctx);

    const [url, { body }] = mockPost.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(body).toEqual({
      model: 'typesafe/jev-1.14',
      state: 'Charged twice.',
      questions: {
        billing: { type: 'noul', instructions: 'Billing problem?' },
        team: { type: 'choice', instructions: 'Which team?', criteria: { payments: 'Charges', web: 'Bugs' } },
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Later', 'Soon', 'Now'] },
      },
    });
    expect(response.answers).toEqual({
      billing: { type: 'predicate', probability: 0.95 },
      team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.9, web: 0.1 }, confidence: 0.85 },
      urgency: { type: 'score', score: 1.9, probabilities: [0, 0.1, 0.9], confidence: 0.8 },
    });
    expect(response.usage).toEqual({ text: { input: 421, output: 70 }, cost: 0.00002 });
  });
});
