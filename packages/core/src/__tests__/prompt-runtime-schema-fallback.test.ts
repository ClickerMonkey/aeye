/**
 * Runtime schema-delivery fallback tests.
 *
 * A model whose FormatDescriptor ALLOWS the structured schema (so the static
 * `canExpress` check passes and `response_format` IS sent) can still reply with
 * EMPTY or unparseable content — observed with meta-llama/llama-4-maverick via
 * OpenRouter (`finish: stop`, `content: ''`). The static ai-layer fallback never
 * fires in that case, so the Prompt output-parse path promotes the delivery to
 * prompt-text for the RETRY: it flips the outgoing request's
 * `responseFormat.schemaDelivery` to `'prompt'` so the ai layer's
 * `applySchemaDeliveryFallback` drops `response_format` + appends the schema as
 * text on the next request build.
 *
 * These tests exercise the CORE half of that mechanism (the flip + retry) with a
 * recording executor. The ai layer's drop/append is covered in
 * `@aeye/ai`'s `runtime-schema-fallback.test.ts`.
 */

import { z } from 'zod';
import { Prompt, PromptEvent } from '../prompt';
import type { Context, Request, Response } from '../types';

/** The schemaDelivery observed on each request (or `'dropped'` when the wire
 * schema is gone — never happens in pure-core, but kept for clarity). */
type DeliverySnapshot = 'auto' | 'structured' | 'prompt' | 'dropped';

/**
 * Executor that returns `contents[i]` for call `i` (clamping to the last), and
 * records the effective `schemaDelivery` of the request AT CALL TIME into
 * `deliveries`. Because the Prompt reuses ONE request object across retries,
 * this captures how the runtime fallback mutates it between attempts.
 */
function recordingExecutor(contents: string[], deliveries: DeliverySnapshot[]) {
  let i = 0;
  return jest.fn(async (request: Request): Promise<Response> => {
    const rf = request.responseFormat;
    deliveries.push(typeof rf === 'object' ? (rf.schemaDelivery ?? 'auto') : 'dropped');
    const content = contents[Math.min(i, contents.length - 1)];
    i++;
    return {
      content,
      finishReason: 'stop',
      usage: { text: { input: 1, output: 1 } },
      model: 'mock-model',
    };
  });
}

function makePrompt(
  schemaDelivery: 'auto' | 'structured' | 'prompt' | undefined,
  parseInputs: unknown[],
) {
  return new Prompt<{}, {}, string, {}, { value: number }>({
    name: 'runtime-fallback',
    description: 'Runtime schema-delivery fallback',
    content: 'You are a helpful assistant.',
    schema: z.object({ value: z.number() }),
    strict: false,
    ...(schemaDelivery ? { schemaDelivery } : {}),
    outputRetries: 3,
    parse: (raw) => {
      parseInputs.push(raw);
      const v = (raw as { value?: unknown }).value;
      return typeof v === 'number' ? { value: v } : new Error('value must be a number');
    },
  });
}

describe('Prompt runtime schema-delivery fallback', () => {
  it('promotes an EMPTY structured response (auto) to prompt-delivery on retry', async () => {
    const deliveries: DeliverySnapshot[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt('auto', parseInputs);

    // Attempt 1: empty content (Llama's behavior). Attempt 2: valid JSON.
    const executor = recordingExecutor(['', JSON.stringify({ value: 5 })], deliveries);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 5 });
    expect(executor).toHaveBeenCalledTimes(2);
    // Attempt 1 sent structured ('auto'); the empty reply flipped delivery to
    // 'prompt' for attempt 2.
    expect(deliveries).toEqual(['auto', 'prompt']);
    // The parse hook did NOT run on the empty attempt (JSON.parse threw first);
    // it ran only on the retry's valid JSON.
    expect(parseInputs).toEqual([{ value: 5 }]);
  });

  it('promotes an UNPARSEABLE structured response (auto) to prompt-delivery on retry', async () => {
    const deliveries: DeliverySnapshot[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt('auto', parseInputs);

    const executor = recordingExecutor(['not json at all', JSON.stringify({ value: 8 })], deliveries);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 8 });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(deliveries).toEqual(['auto', 'prompt']);
    expect(parseInputs).toEqual([{ value: 8 }]);
  });

  it('emits a json-parsing textReset when it promotes (reuses the output-retry channel)', async () => {
    const deliveries: DeliverySnapshot[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt('auto', parseInputs);

    const executor = recordingExecutor(['', JSON.stringify({ value: 1 })], deliveries);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const events: PromptEvent<any, any>[] = [];
    let result: unknown;
    for await (const ev of prompt.get('stream', {}, ctx)) {
      events.push(ev);
      if (ev.type === 'complete') result = (ev as any).output;
    }

    expect(result).toEqual({ value: 1 });
    const reset = events.find((e) => e.type === 'textReset') as any;
    expect(reset?.reason).toBe('json-parsing');
    expect(deliveries).toEqual(['auto', 'prompt']);
  });

  it("does NOT fire when schemaDelivery is 'structured'", async () => {
    const deliveries: DeliverySnapshot[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt('structured', parseInputs);

    // Empty first, then valid: still retries via outputRetries, but delivery
    // must stay 'structured' (forced) — no runtime promotion.
    const executor = recordingExecutor(['', JSON.stringify({ value: 3 })], deliveries);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 3 });
    expect(deliveries).toEqual(['structured', 'structured']);
  });

  it("does NOT fire when schemaDelivery is already 'prompt'", async () => {
    const deliveries: DeliverySnapshot[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt('prompt', parseInputs);

    const executor = recordingExecutor(['', JSON.stringify({ value: 4 })], deliveries);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 4 });
    // Delivery was 'prompt' from the start; the runtime switch is a no-op.
    expect(deliveries).toEqual(['prompt', 'prompt']);
  });

  it('does NOT fire for a normal non-empty structured response (no extra retry)', async () => {
    const deliveries: DeliverySnapshot[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt('auto', parseInputs);

    const executor = recordingExecutor([JSON.stringify({ value: 7 })], deliveries);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 7 });
    // Parsed on the first try — one round-trip, delivery never promoted.
    expect(executor).toHaveBeenCalledTimes(1);
    expect(deliveries).toEqual(['auto']);
  });

  it('is idempotent — promotes ONCE and does not loop on repeated empties', async () => {
    const deliveries: DeliverySnapshot[] = [];
    const parseInputs: unknown[] = [];
    const prompt = makePrompt('auto', parseInputs);

    // Two empty replies in a row, then valid JSON.
    const executor = recordingExecutor(['', '', JSON.stringify({ value: 9 })], deliveries);
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);

    expect(result).toEqual({ value: 9 });
    expect(executor).toHaveBeenCalledTimes(3);
    // Flipped to 'prompt' on the first empty; the second empty did NOT re-flip
    // (guard + already-prompt), so it stays 'prompt' — no loop.
    expect(deliveries).toEqual(['auto', 'prompt', 'prompt']);
    expect(parseInputs).toEqual([{ value: 9 }]);
  });
});
