/**
 * Live prompt features: a schema with a keyword a strict dialect refuses is
 * sent without a rejection, and a review loop sends feedback back to a nano
 * model.
 *
 * The schema has a `not` (`a.not`), which OpenAI's strict structured outputs
 * refuse ("schema must have a 'type' key"). On core's old zod path that
 * schema was sent as is, rejected, and stepped down the schema fallbacks.
 * `@aeye/schema` renders only what the dialect takes (strict OpenAI has no
 * `not`: the rule is said in words and still checked on decode), so no
 * fallback is taken any more. The fallback steps themselves are covered
 * offline in core.
 */

import { describe, expect } from '@jest/globals';
import { a } from '@aeye/schema';
import { AI } from '@aeye/ai';
import { models } from '@aeye/models';
import { type PromptEvent, type Request } from '@aeye/core';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { liveCase } from '../live';
import { getAPIKey, hasAPIKey } from '../setup';

const describeLive = hasAPIKey('openai') && hasAPIKey('openrouter') ? describe : describe.skip;

const MODEL = 'gpt-5.4-nano';
const config: Pick<Request, 'reason' | 'maxTokens'> = { reason: { effort: 'none' }, maxTokens: 200 };
// OpenAI strict mode refuses `not`; the schema is otherwise trivial
const refused = a.object({ color: a.not(a.literal('black'), a.string()) });

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

  // One prompt definition, built on each AI
  const colorPrompt = (model: string) => ({
    name: 'color',
    description: 'Names a color',
    content: 'Name one color of the rainbow.',
    schema: refused,
    config,
    metadata: { model },
  });

  liveCase('openai strict takes a not-schema without a rejection', { sources: ['core', 'ai', 'openai'], inputs: { model: MODEL, schema: 'not' } }, async () => {
    const { taken, output } = await fallbacksOf(openai.prompt(colorPrompt(MODEL)).get('stream'));
    expect(taken).toEqual([]);
    expect(typeof output?.color).toBe('string');
    expect(output?.color).not.toBe('black');
  });

  liveCase('openrouter strict takes a not-schema without a rejection', { sources: ['core', 'ai', 'openai', 'openrouter'], inputs: { model: `openai/${MODEL}`, schema: 'not' } }, async () => {
    const { taken, output } = await fallbacksOf(openrouter.prompt(colorPrompt(`openai/${MODEL}`)).get('stream'));
    expect(taken).toEqual([]);
    expect(typeof output?.color).toBe('string');
  });

  // The review decides in code: a model reviewer is the unit tests' job, and
  // a nano judge is too unreliable to gate on
  liveCase('review feedback sends a nano model round again', { sources: ['core', 'ai', 'openai'], inputs: { model: MODEL, review: 'starts-with-z-code' } }, async () => {
    const namer = openai.prompt({
      name: 'namer',
      description: 'Names a cat',
      content: 'Reply with one name for a cat, and nothing else.',
      config,
      metadata: { model: MODEL },
      reviewRetries: 2,
      review: async (name) => name.trim().toUpperCase().startsWith('Z')
        ? { pass: true }
        : { feedback: `"${name.trim()}" doesn't start with the letter Z. Reply with a cat name that does.` },
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
