/**
 * Decisions: questions by name out, typed answers by name back.
 */

import { AI, type AIContextAny, type DecisionQuestion } from '@aeye/ai';
import { OpenAIProvider } from '../openai';

const mockPost = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ post: mockPost })));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };
const provider = new OpenAIProvider({ apiKey: 'test' });
const questions: Record<string, DecisionQuestion> = {
  billing: { type: 'predicate', instructions: 'Billing problem?' },
  team: { type: 'choice', instructions: 'Which team?', choices: { payments: 'Charges', web: '' } },
  urgency: { type: 'score', instructions: 'How urgent?', levels: ['Later', 'Now'] },
};

beforeEach(() => jest.clearAllMocks());

describe('decide', () => {
  it('sends named questions and maps the answers by name', async () => {
    mockPost.mockResolvedValue({
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate', name: 'billing', probability: 0.9 },
        { type: 'choice', name: 'team', choice: 'payments', probabilities: [{ value: 'payments', probability: 0.8 }, { value: 'web', probability: 0.2 }], confidence: 0.7 },
        { type: 'score', name: 'urgency', score: 0.6, probabilities: [{ value: 0, label: 'Later', probability: 0.4 }, { value: 1, label: 'Now', probability: 0.6 }], confidence: 0.5 },
      ],
      usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 300 },
    });

    const response = await provider.decide!({ input: 'Charged twice.', questions }, ctx);

    const [path, { body }] = mockPost.mock.calls[0];
    expect(path).toBe('/decisions');
    expect(body).toEqual({
      model: 'gpt-6-luna',
      input: 'Charged twice.',
      questions: [
        { name: 'billing', type: 'predicate', instructions: 'Billing problem?' },
        { name: 'team', type: 'choice', instructions: 'Which team?', choices: [{ value: 'payments', description: 'Charges' }, { value: 'web', description: undefined }] },
        { name: 'urgency', type: 'score', instructions: 'How urgent?', levels: [{ label: 'Later' }, { label: 'Now' }] },
      ],
    });
    expect(response.answers).toEqual({
      billing: { type: 'predicate', probability: 0.9 },
      team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.8, web: 0.2 }, confidence: 0.7 },
      urgency: { type: 'score', score: 0.6, probabilities: [0.4, 0.6], confidence: 0.5 },
    });
    expect(response.usage).toEqual({ text: { input: 200, cached: 100 } });
  });

  it('sends a conversation as Responses input, and reports refusals', async () => {
    mockPost.mockResolvedValue({ model: 'gpt-6-luna', answers: [{ type: 'refusal', name: 'billing' }], usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 50 } });

    const response = await provider.decide!({
      input: [{ role: 'system', content: 'Support desk' }, { role: 'user', content: 'Charged twice.' }],
      questions: { billing: questions.billing },
    }, ctx);

    expect(mockPost.mock.calls[0][1].body.input).toEqual([
      { role: 'developer', content: [{ type: 'input_text', text: 'Support desk' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Charged twice.' }] },
    ]);
    expect(response.answers.billing).toEqual({ type: 'refusal' });
  });
});
