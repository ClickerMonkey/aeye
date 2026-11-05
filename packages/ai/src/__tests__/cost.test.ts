/**
 * Cost Calculation Tests
 *
 * Covers the pricing fallbacks in `AI.calculateCost`: unpriced cache and
 * reasoning tokens, per-call hosted tools, and per-image outputs.
 */

import { AI } from '../ai';
import type { ModelInfo } from '../types';
import { createMockProvider } from './mocks/provider.mock';

const ai = AI.with().providers({ mock: createMockProvider() }).create({});

const model = (pricing: ModelInfo['pricing']): ModelInfo => ({
  id: 'priced',
  provider: 'mock',
  name: 'Priced',
  capabilities: new Set(['chat']),
  tier: 'flagship',
  pricing,
  contextWindow: 1000,
});

describe('calculateCost', () => {
  it('prices unpriced reasoning tokens as output tokens', () => {
    const cost = ai.calculateCost(model({ text: { input: 1, output: 10 } }), {
      text: { output: 1_000_000 },
      reasoning: { output: 2_000_000 },
    });

    expect(cost).toBeCloseTo(30);
  });

  it('prefers explicit reasoning pricing', () => {
    const cost = ai.calculateCost(model({ text: { output: 10 }, reasoning: { output: 4 } }), {
      reasoning: { output: 1_000_000 },
    });

    expect(cost).toBeCloseTo(4);
  });

  it('prices cache reads and writes, falling back to input', () => {
    const priced = model({ text: { input: 2, cached: 0.2, cacheWrite: 2.5 } });
    const unpriced = model({ text: { input: 2 } });
    const usage = { text: { cached: 1_000_000, cacheWrite: 1_000_000 } };

    expect(ai.calculateCost(priced, usage)).toBeCloseTo(2.7);
    expect(ai.calculateCost(unpriced, usage)).toBeCloseTo(4);
  });

  it('prices hosted tools per call', () => {
    const cost = ai.calculateCost(model({ tools: { web_search: 0.01 } }), {
      tools: { web_search: 3, web_fetch: 2 },
    });

    expect(cost).toBeCloseTo(0.03);
  });

  it('prices image output tokens', () => {
    const cost = ai.calculateCost(model({ image: { input: 8, tokens: 30 } }), { image: { input: 1_000_000, tokens: 1_000_000 } });

    expect(cost).toBeCloseTo(38);
  });

  it('prices generated images by quality and size', () => {
    const priced = model({
      image: { output: [{ quality: 'medium', sizes: [{ width: 1024, height: 1024, cost: 0.04 }] }] },
    });

    const cost = ai.calculateCost(priced, {
      image: { output: [{ quality: 'medium', size: { width: 1024, height: 1024 }, count: 2 }] },
    });

    expect(cost).toBeCloseTo(0.08);
  });
});
