/**
 * Live prompt features: a real schema rejection steps down the schema
 * fallbacks, and a review loop sends feedback back to a nano model.
 *
 * The rejected schema carries a `not` keyword through zod metadata, which
 * OpenAI's strict structured outputs refuse ("schema must have a 'type'
 * key") and its non-strict mode accepts.
 */

import { describe, expect } from '@jest/globals';
import { z } from 'zod';
import { AI } from '@aeye/ai';
import { models } from '@aeye/models';
import { SCHEMA_FALLBACKS, type PromptEvent } from '@aeye/core';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { liveCase } from '../live';
import { getAPIKey, hasAPIKey } from '../setup';

const describeLive = hasAPIKey('openai') && hasAPIKey('openrouter') ? describe : describe.skip;

const MODEL = 'gpt-5.4-nano';
const config = { reason: { effort: 'none' as const }, maxTokens: 200 };
// OpenAI strict mode rejects `not`; the schema is otherwise trivial
const rejected = z.object({ color: z.string().meta({ not: { const: 'black' } }) });

/** The schema fallbacks a prompt run took, and its output. */
async function fallbacksOf<T>(events: AsyncIterable<PromptEvent<T, []>>) {
  const taken: string[] = [];
  let output: T | undefined;
  for await (const event of events) {
    if (event.type === 'schemaFallback') {
      taken.push(event.fallback);
    }
    if (event.type === 'complete') {
      output = event.output;
    }
  }
  return { taken, output };
}

describeLive('live prompt features', () => {
  const openai = AI.with().providers({ openai: new OpenAIProvider({ apiKey: getAPIKey('openai') }) }).create({ models });
  const openrouter = AI.with().providers({ openrouter: new OpenRouterProvider({ apiKey: getAPIKey('openrouter') }) }).create({ models });

  const colorPrompt = (ai: typeof openai, model: string, schemaFallbacks = SCHEMA_FALLBACKS) => ai.prompt({
    name: 'color',
    description: 'Names a color',
    content: 'Name one color of the rainbow.',
    schema: rejected,
    schemaFallbacks,
    config,
    metadata: { model },
  });

  liveCase('openai strict rejection falls back to non-strict', { sources: ['core', 'ai', 'openai'], inputs: { model: MODEL, schema: 'not' } }, async () => {
    const { taken, output } = await fallbacksOf(colorPrompt(openai, MODEL).get('stream'));
    expect(taken).toEqual(['non-strict']);
    expect(typeof output?.color).toBe('string');
  });

  liveCase('openai strict rejection falls back to JSON mode', { sources: ['core', 'ai', 'openai'], inputs: { model: MODEL, schema: 'not', fallbacks: 'json' } }, async () => {
    const { taken, output } = await fallbacksOf(colorPrompt(openai, MODEL, SCHEMA_FALLBACKS.filter(step => step.name !== 'non-strict')).get('stream'));
    expect(taken).toEqual(['json']);
    expect(typeof output?.color).toBe('string');
  });

  liveCase('openrouter upstream rejection steps down from non-strict', { sources: ['core', 'ai', 'openai', 'openrouter'], inputs: { model: `openai/${MODEL}`, schema: 'not' } }, async () => {
    const { taken, output } = await fallbacksOf(colorPrompt(openrouter, `openai/${MODEL}`).get('stream'));
    // The upstream OpenRouter picks may reject the non-strict schema too
    expect(taken[0]).toBe('non-strict');
    expect(typeof output?.color).toBe('string');
  });

  liveCase('review feedback sends a nano model round again', { sources: ['core', 'ai', 'openai'], inputs: { model: MODEL, review: 'starts-with-z' } }, async () => {
    const reviewer = openai.prompt({
      name: 'reviewer',
      description: 'Checks a cat name',
      content: 'A cat name must start with the letter Z. Review this name: {{name}}',
      input: ({ name }: { name: string }) => ({ name }),
      schema: z.object({ pass: z.boolean(), feedback: z.string().describe('What to change, when it fails') }),
      config,
      metadata: { model: MODEL },
    });
    const namer = openai.prompt({
      name: 'namer',
      description: 'Names a cat',
      content: 'Reply with one name for a cat, and nothing else.',
      config,
      metadata: { model: MODEL },
      reviewRetries: 2,
      review: async (name, { ctx }) => {
        const verdict = await reviewer.get('result', { name }, ctx);
        return verdict?.pass ? { pass: true } : { feedback: verdict?.feedback || 'The name must start with Z.' };
      },
    });

    const attempts: number[] = [];
    let output: string | undefined;
    for await (const event of namer.get('stream')) {
      if (event.type === 'reviewStart') {
        attempts.push(event.attempt);
      }
      if (event.type === 'complete') {
        output = event.output;
      }
    }
    expect(output?.trim().toUpperCase().startsWith('Z')).toBe(true);
    expect(attempts.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
