/**
 * Rerank and Decide API Tests
 */

import { AI } from '../ai';
import { checkDecisionLimits, DecisionLimitError } from '../apis/decide';
import type { DecisionRequest, ModelInfo, RerankRequest } from '../types';
import { createMockModels, createMockProvider } from './mocks/provider.mock';

const model = (id: string, capability: 'rerank' | 'decision'): ModelInfo => ({
  id,
  provider: 'mock',
  name: id,
  capabilities: new Set([capability]),
  tier: 'efficient',
  pricing: { text: { input: 0.1 } },
  contextWindow: 8192,
});

function setup() {
  const reranked: RerankRequest[] = [];
  const decided: DecisionRequest[] = [];
  const provider = {
    ...createMockProvider({ name: 'mock', models: [...createMockModels('mock'), model('mock-rerank', 'rerank'), model('mock-decide', 'decision')] }),
    rerank: async (request: RerankRequest) => {
      reranked.push(request);
      return { results: [{ index: 1, score: 0.9 }, { index: 0, score: 0.1 }], model: 'mock-rerank', usage: { cost: 0.001 } };
    },
    decide: async (request: DecisionRequest) => {
      decided.push(request);
      return { answers: { billing: { type: 'predicate' as const, probability: 0.8 } }, model: 'mock-decide', usage: { text: { input: 100 } } };
    },
  };
  const ai = AI.with().providers({ mock: provider }).create({});
  return { ai, reranked, decided };
}

describe('Rerank API', () => {
  it('selects a rerank model and returns its ordering', async () => {
    const { ai, reranked } = setup();
    await ai.models.refresh();

    const response = await ai.rerank.get({ query: 'capital of France', documents: ['Berlin', 'Paris'] });

    expect(reranked).toHaveLength(1);
    expect(response.results.map(r => r.index)).toEqual([1, 0]);
    expect(response.usage?.cost).toBe(0.001);
  });

  it('fails without a rerank model', async () => {
    const ai = AI.with().providers({ mock: createMockProvider({ name: 'mock' }) }).create({});
    await ai.models.refresh();

    await expect(ai.rerank.get({ query: 'q', documents: ['d'] })).rejects.toThrow();
  });
});

describe('Decide API', () => {
  it('selects a decision model and returns its answers', async () => {
    const { ai, decided } = setup();
    await ai.models.refresh();

    const response = await ai.decide.get({
      input: [{ role: 'user', content: 'I was charged twice.' }],
      questions: { billing: { type: 'predicate', instructions: 'Is this a billing problem?' } },
    });

    expect(decided).toHaveLength(1);
    expect(response.answers.billing).toEqual({ type: 'predicate', probability: 0.8 });
  });

  it('refuses more questions than the model takes, without splitting them', async () => {
    const decided: DecisionRequest[] = [];
    const capped: ModelInfo = { ...model('mock-capped', 'decision'), maxQuestions: 2 };
    const provider = {
      ...createMockProvider({ name: 'mock', models: [capped] }),
      decide: async (request: DecisionRequest) => {
        decided.push(request);
        return { answers: {}, model: 'mock-capped' };
      },
    };
    const ai = AI.with().providers({ mock: provider }).create({});
    await ai.models.refresh();
    const ask = (count: number) => ai.decide.get({
      input: 'text',
      questions: Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, { type: 'predicate' as const, instructions: `Question ${i}?` }])),
    });

    await expect(ask(3)).rejects.toThrow('mock-capped takes at most 2 questions per decision call, and this one asks 3');
    expect(decided).toHaveLength(0);
    await ask(2);
    expect(decided).toHaveLength(1);
  });

  it('needs a vision decision model when the call has images', async () => {
    const { ai } = setup();
    await ai.models.refresh();

    await expect(ai.decide.get({ input: 'text', images: [Buffer.from('png')], questions: { cat: { type: 'predicate', instructions: 'A cat?' } } })).rejects.toThrow('No compatible model found for decisions');
  });
});

describe('checkDecisionLimits', () => {
  it('passes unset limits and refuses an over-size call', () => {
    expect(() => checkDecisionLimits({ id: 'm' }, 1_000, 1_000_000)).not.toThrow();
    expect(() => checkDecisionLimits({ id: 'm', maxQuestions: 64, maxRequestBytes: 10 }, 64, 10)).not.toThrow();
    const error = (() => { try { checkDecisionLimits({ id: 'm', maxRequestBytes: 10 }, 1, 11); } catch (e) { return e; } })();
    expect(error).toBeInstanceOf(DecisionLimitError);
    expect(error).toMatchObject({ model: 'm', limit: 'maxRequestBytes', max: 10, actual: 11 });
  });
});
