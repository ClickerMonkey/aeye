/**
 * The shared System One protocol: questions, request parameters, answers.
 */

import type { DecisionRequest } from '@aeye/ai';
import { fromSystemOneAnswer, fromSystemOneAnswers, type SystemOneAnswer, systemOneTextBytes, toSystemOneImages, toSystemOneParams, toSystemOneQuestions } from '../systemone';

const request: DecisionRequest = {
  input: 'Charged twice.',
  questions: {
    billing: { type: 'predicate', instructions: 'Billing problem?' },
    team: { type: 'choice', instructions: 'Which team?', choices: { payments: 'Charges', web: 'Bugs' } },
    urgency: { type: 'score', instructions: 'How urgent?', levels: ['Later', 'Soon', 'Now'] },
  },
};

describe('System One', () => {
  it('asks predicates as noul questions and choices and levels as criteria', () => {
    expect(toSystemOneQuestions(request.questions)).toEqual({
      billing: { type: 'noul', instructions: 'Billing problem?' },
      team: { type: 'choice', instructions: 'Which team?', criteria: { payments: 'Charges', web: 'Bugs' } },
      urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Later', 'Soon', 'Now'] },
    });
  });

  it('sends images as plain base64, then defaults, then the request extra', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const params = await toSystemOneParams('nimble', 'state', { ...request, images: [png, `data:image/jpeg;base64,${png.toString('base64')}`], extra: { keep_alive: 0 } }, { keep_alive: '5m' });

    expect(params.images).toEqual([png.toString('base64'), png.toString('base64')]);
    expect(params.keep_alive).toBe(0);
    expect(params.model).toBe('nimble');
    expect(await toSystemOneParams('nimble', 'state', request)).not.toHaveProperty('images');
    expect(await toSystemOneImages([])).toEqual([]);
  });

  it('counts the request bytes without its images', async () => {
    const params = await toSystemOneParams('nimble', 'é', request);
    const withImages = { ...params, images: ['A'.repeat(10_000)] };

    expect(systemOneTextBytes(withImages)).toBe(systemOneTextBytes(params));
    expect(systemOneTextBytes(params)).toBe(Buffer.byteLength(JSON.stringify(params)));
  });

  it('reads answers, with score probabilities in level order', () => {
    expect(fromSystemOneAnswers({
      billing: { type: 'noul', noul: 0.95 },
      team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.9, web: 0.1 }, confidence: 0.85 },
      urgency: { type: 'score', score: 1.9, legend: { 0: 'Later', 1: 'Soon', 2: 'Now' }, probabilities: { 2: 0.9, 0: 0, 1: 0.1, 10: 0 }, confidence: 0.8 },
    })).toEqual({
      billing: { type: 'predicate', probability: 0.95 },
      team: { type: 'choice', choice: 'payments', probabilities: { payments: 0.9, web: 0.1 }, confidence: 0.85 },
      urgency: { type: 'score', score: 1.9, probabilities: [0, 0.1, 0.9, 0], confidence: 0.8 },
    });
  });

  it('reads an answer of an unknown type as a refusal', () => {
    expect(fromSystemOneAnswer({ type: 'other' } as unknown as SystemOneAnswer)).toEqual({ type: 'refusal' });
  });
});
