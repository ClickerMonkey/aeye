/**
 * Runtime schema-delivery fallback — ai-layer integration.
 *
 * The CORE half (flipping `responseFormat.schemaDelivery` to `'prompt'` when a
 * structured response comes back empty/unparseable under `'auto'`) is unit-
 * tested in `@aeye/core`'s `prompt-runtime-schema-fallback.test.ts`. This test
 * exercises the FULL loop end-to-end: a real `@aeye/core` `Prompt` whose
 * executor runs the ai-layer `applySchemaDeliveryFallback` on every request.
 *
 * Scenario: an OpenAI-family model (whose descriptor CAN express the schema, so
 * the STATIC `canExpress` fallback never fires) returns EMPTY content on the
 * first structured attempt. Core promotes delivery to prompt-text; on the retry
 * `applySchemaDeliveryFallback` DROPS `response_format` and APPENDS the schema
 * as prompt text, and the Prompt's `parse` hook then runs on the retry's JSON.
 */

import { z } from 'zod';
import { Prompt } from '@aeye/core';
import type { Context, Request, Response } from '@aeye/core';
import { applySchemaDeliveryFallback } from '../apis/schema-fallback';
import type { ModelInfo } from '../types';

function makeModel(provider: string, id: string): ModelInfo {
  return {
    id,
    provider,
    name: id,
    capabilities: new Set(['chat', 'streaming', 'structured']),
    tier: 'flagship',
    pricing: { text: { input: 1, output: 1 } },
    contextWindow: 8192,
    maxOutputTokens: 4096,
  };
}

interface CallRecord {
  hasResponseFormat: boolean;
  systemText: string;
}

/**
 * A core executor that mirrors what `ChatAPI.executeRequest` does: run
 * `applySchemaDeliveryFallback(request, model)` before dispatch, then return the
 * next configured `content`. Records the post-fallback request state per call.
 */
function makeExecutor(model: ModelInfo, contents: string[], records: CallRecord[]) {
  let i = 0;
  return async (request: Request): Promise<Response> => {
    applySchemaDeliveryFallback(request, model);
    const sys = request.messages.find((m) => m.role === 'system');
    records.push({
      hasResponseFormat: request.responseFormat !== undefined,
      systemText: typeof sys?.content === 'string' ? sys.content : '',
    });
    const content = contents[Math.min(i, contents.length - 1)];
    i++;
    return {
      content,
      finishReason: 'stop',
      usage: { text: { input: 1, output: 1 } },
      model: model.id,
    };
  };
}

function makePrompt(parseInputs: unknown[]) {
  return new Prompt<{}, {}, string, {}, { value: number }>({
    name: 'runtime-fallback-ai',
    description: 'Runtime schema-delivery fallback (ai layer)',
    content: 'You are a helpful assistant.',
    schema: z.object({ value: z.number() }),
    strict: false,
    schemaDelivery: 'auto',
    outputRetries: 3,
    parse: (raw) => {
      parseInputs.push(raw);
      const v = (raw as { value?: unknown }).value;
      return typeof v === 'number' ? { value: v } : new Error('value must be a number');
    },
  });
}

describe('runtime schema-delivery fallback (ai integration)', () => {
  it('EMPTY structured reply → retry drops response_format + appends schema text; parse runs on retry JSON', async () => {
    const model = makeModel('openai', 'openai/gpt-4o');
    const records: CallRecord[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt(parseInputs);

    const executor = makeExecutor(model, ['', JSON.stringify({ value: 5 })], records);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 5 });
    expect(records).toHaveLength(2);

    // Attempt 1: structured output sent (descriptor CAN express the schema, so
    // the static fallback is a no-op), plain system prompt.
    expect(records[0].hasResponseFormat).toBe(true);
    expect(records[0].systemText).toBe('You are a helpful assistant.');

    // Attempt 2: response_format dropped + schema delivered as prompt text.
    expect(records[1].hasResponseFormat).toBe(false);
    expect(records[1].systemText).toContain('You are a helpful assistant.');
    expect(records[1].systemText).toContain('JSON object conforming to this schema');

    // The parse hook ran only on the retry's valid JSON.
    expect(parseInputs).toEqual([{ value: 5 }]);
  });

  it('UNPARSEABLE structured reply → same drop + append fallback', async () => {
    const model = makeModel('openai', 'openai/gpt-4o');
    const records: CallRecord[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt(parseInputs);

    const executor = makeExecutor(model, ['not json at all', JSON.stringify({ value: 6 })], records);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 6 });
    expect(records[0].hasResponseFormat).toBe(true);
    expect(records[1].hasResponseFormat).toBe(false);
    expect(records[1].systemText).toContain('JSON object conforming to this schema');
    expect(parseInputs).toEqual([{ value: 6 }]);
  });

  it('non-empty structured reply parses first try — no drop, no schema text', async () => {
    const model = makeModel('openai', 'openai/gpt-4o');
    const records: CallRecord[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt(parseInputs);

    const executor = makeExecutor(model, [JSON.stringify({ value: 7 })], records);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 7 });
    expect(records).toHaveLength(1);
    expect(records[0].hasResponseFormat).toBe(true);
    expect(records[0].systemText).toBe('You are a helpful assistant.');
  });
});
