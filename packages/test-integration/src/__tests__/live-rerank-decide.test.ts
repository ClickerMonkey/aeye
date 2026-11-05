/**
 * Live rerank and decisions through the AI class.
 */

import { describe, expect } from '@jest/globals';
import { AI, type DecisionQuestion } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { liveCase } from '../live';
import { getAPIKey, hasAPIKey } from '../setup';

const describeLive = hasAPIKey('openai') && hasAPIKey('openrouter') ? describe : describe.skip;

const questions: Record<string, DecisionQuestion> = {
  billing: { type: 'predicate', instructions: 'Is the customer reporting a billing problem?' },
  team: { type: 'choice', instructions: 'Which team should own this?', choices: { payments: 'Charges and refunds', web: 'Website bugs' } },
  urgency: { type: 'score', instructions: 'How urgent is it?', levels: ['Can wait', 'This week', 'Right now'] },
};
const ticket = 'I was charged twice for my order and need the money back today.';

describeLive('live rerank and decisions', () => {
  const openai = AI.with().providers({ openai: new OpenAIProvider({ apiKey: getAPIKey('openai') }) }).create();
  const openrouter = AI.with().providers({ openrouter: new OpenRouterProvider({ apiKey: getAPIKey('openrouter') }) }).create();

  liveCase('rerank openrouter cohere/rerank-v3.5', { sources: ['core', 'ai', 'openai', 'openrouter'], inputs: { model: 'cohere/rerank-v3.5' } }, async () => {
    const { results } = await openrouter.rerank.get(
      { query: 'capital of France', documents: ['Berlin is in Germany.', 'Paris is the capital of France.'] },
      { metadata: { model: 'cohere/rerank-v3.5' } },
    );
    expect(results[0].index).toBe(1);
  });

  const decides: Array<[string, typeof openai | typeof openrouter, string]> = [
    ['openai', openai, 'gpt-6-luna'],
    ['openrouter', openrouter, 'typesafe/jev-1.14'],
  ];
  for (const [provider, ai, model] of decides) {
    liveCase(`decide ${provider} ${model}`, { sources: ['core', 'ai', 'openai', 'openrouter'], inputs: { model, questions, ticket } }, async () => {
      const { answers } = await ai.decide.get(
        { input: [{ role: 'user', content: ticket }], questions },
        { metadata: { model } },
      );
      expect(answers.billing).toMatchObject({ type: 'predicate' });
      expect(answers.team).toMatchObject({ type: 'choice', choice: 'payments' });
      expect(answers.urgency).toMatchObject({ type: 'score' });
    });
  }
});
