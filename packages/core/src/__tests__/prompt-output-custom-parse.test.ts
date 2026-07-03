/**
 * Structured-output custom parse (Zod replacement) tests.
 *
 * The optional `parse` hook on `PromptInput` fully REPLACES Zod validation
 * of the model's structured output. When supplied the pipeline becomes
 * JSON.parse → parse → validate; Zod (and the descriptor strictify) is
 * never consulted. Mirrors `Tool.parse`'s `parse` hook, letting a caller
 * (e.g. @aeye/query) surface concise, compiler-style errors with source
 * underlines instead of Zod's aggregate output. A returned/thrown Error
 * flows through the SAME output-retry channel a Zod failure would.
 */

import { z } from 'zod';
import { Prompt, PromptEvent } from '../prompt';
import { Context } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

describe('Prompt structured-output custom parse (Zod replacement)', () => {
  it('should use the custom parser and skip Zod entirely', async () => {
    // The Zod schema requires { value: number }. The model returns a shape
    // Zod would REJECT ({ n: "5" }), but the custom parser accepts it and
    // produces its own typed result. Zod must never run, so this succeeds.
    const prompt = new Prompt<{}, {}, string, {}, { value: number }>({
      name: 'byo-output-parser',
      description: 'Bring your own structured-output parser',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      parse: (raw) => {
        const r = raw as { n?: unknown };
        return { value: Number(r.n) };
      },
    });

    const executor = createMockExecutor({
      response: { content: JSON.stringify({ n: '5' }), finishReason: 'stop' },
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toEqual({ value: 5 });
    // Only one round-trip — no retry was needed since Zod never rejected.
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('should surface a returned rich Error and NOT any Zod vocabulary', async () => {
    // Custom parser returns a compiler-style Error; with no retries left it
    // becomes the thrown failure message. Zod's message vocabulary must not
    // appear because Zod never ran.
    const prompt = new Prompt<{}, {}, string, {}, { value: number }>({
      name: 'byo-output-error-return',
      description: 'Custom parser returns rich error',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      outputRetries: 0,
      parse: () => new Error('nice compiler-style error ^^^ here'),
    });

    const executor = createMockExecutor({
      response: { content: JSON.stringify({ value: 1 }), finishReason: 'stop' },
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    let msg = '';
    try {
      await prompt.get('result', {}, ctx);
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toContain('nice compiler-style error ^^^ here');
    // Zod's schema vocabulary must not appear, and the Zod-specific
    // "invalid format" wrapper must not be used.
    expect(msg).not.toMatch(/expected|invalid_type|invalid format|zod/i);
  });

  it('should follow the same retry path a Zod failure would (returned Error)', async () => {
    // A returned Error retries through `outputRetries` exactly like a Zod
    // failure. First attempt fails via custom parse, second attempt the
    // custom parser accepts.
    let calls = 0;
    const prompt = new Prompt<{}, {}, string, {}, { value: number }>({
      name: 'byo-output-retry',
      description: 'Custom parse retries via outputRetries',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      outputRetries: 2,
      parse: (raw) => {
        calls++;
        const r = raw as { value?: unknown };
        if (typeof r.value !== 'number') {
          return new Error('value must be a number (underlined here)');
        }
        return { value: r.value };
      },
    });

    const executor = createMockExecutor({
      responses: [
        { content: JSON.stringify({ value: 'bad' }), finishReason: 'stop' },
        { content: JSON.stringify({ value: 42 }), finishReason: 'stop' },
      ],
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const events: PromptEvent<any, any>[] = [];
    let result: any;
    for await (const ev of prompt.get('stream', {}, ctx)) {
      events.push(ev);
      if (ev.type === 'complete') result = ev.output;
    }

    expect(result).toEqual({ value: 42 });
    expect(calls).toBe(2);
    // The retry surfaced the custom error as a corrective user message and
    // reset the text, exactly as a Zod failure would.
    const reset = events.find((e) => e.type === 'textReset') as any;
    expect(reset?.reason).toBe('schema-parsing');
    const corrective = events.find(
      (e) => e.type === 'message' && (e as any).message.role === 'user',
    ) as any;
    expect(corrective.message.content).toContain('value must be a number (underlined here)');
    expect(corrective.message.content).not.toMatch(/invalid format|invalid_type/i);
  });

  it('should propagate a thrown rich Error subclass through the retry channel', async () => {
    // Mirrors how @aeye/query throws a QueryTypeError carrying structured
    // diagnostics alongside the rendered message. A thrown Error is treated
    // identically to a returned one (does NOT get mislabeled as a JSON
    // parse error by the outer catch).
    class RichError extends Error {
      constructor(message: string, readonly problems: Array<{ code: string }>) {
        super(message);
        this.name = 'RichError';
      }
    }

    const prompt = new Prompt<{}, {}, string, {}, { value: number }>({
      name: 'byo-output-throw',
      description: 'Custom parser throws rich error',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      outputRetries: 0,
      parse: () => {
        throw new RichError('underlined ^^^ diagnostic', [{ code: 'field-type.unknown' }]);
      },
    });

    const executor = createMockExecutor({
      response: { content: JSON.stringify({ value: 1 }), finishReason: 'stop' },
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    let msg = '';
    try {
      await prompt.get('result', {}, ctx);
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toContain('underlined ^^^ diagnostic');
    // Must NOT be mislabeled as a JSON-parse failure by the outer catch.
    expect(msg).not.toMatch(/not valid JSON/i);
  });

  it('should still run the post-validate hook after a successful custom parse', async () => {
    const prompt = new Prompt<{}, {}, string, {}, { value: number }>({
      name: 'byo-output-validate',
      description: 'Custom parse + validate',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      outputRetries: 1,
      parse: (raw) => ({ value: (raw as { value: number }).value }),
      validate: (output) => {
        if (output.value < 0) throw new Error('must be non-negative');
      },
    });

    // First response fails validate (negative), second passes.
    const executor = createMockExecutor({
      responses: [
        { content: JSON.stringify({ value: -1 }), finishReason: 'stop' },
        { content: JSON.stringify({ value: 3 }), finishReason: 'stop' },
      ],
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toEqual({ value: 3 });
  });

  it('should be fully backward-compatible: no parse option ⇒ Zod path unchanged', async () => {
    const prompt = new Prompt<{}, {}, string, {}, { value: number }>({
      name: 'no-byo-output',
      description: 'Default Zod path',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      outputRetries: 0,
    });

    // Valid → Zod accepts.
    const okExecutor = createMockExecutor({
      response: { content: JSON.stringify({ value: 9 }), finishReason: 'stop' },
    });
    const okCtx: Context<{}, {}> = { execute: okExecutor, messages: [] };
    expect(await prompt.get('result', {}, okCtx)).toEqual({ value: 9 });

    // Invalid → Zod rejects with its usual "invalid format" message.
    const badExecutor = createMockExecutor({
      response: { content: JSON.stringify({ value: 'nope' }), finishReason: 'stop' },
    });
    const badCtx: Context<{}, {}> = { execute: badExecutor, messages: [] };
    await expect(prompt.get('result', {}, badCtx)).rejects.toThrow(/invalid format/i);
  });

  it('should drive the DECODED output type from parse\'s return (class instance)', async () => {
    // The Zod `schema` is the WIRE shape ({ value: number }); the custom
    // `parse` builds a `Built` class instance. Per the `TDecoded` generic,
    // the prompt's structured result (and `get('result')`) must be typed
    // and returned as the DECODED `Built`, not the wire shape.
    class Built {
      constructor(readonly value: number) {}
      doubled(): number {
        return this.value * 2;
      }
    }

    // No explicit generics: `TOutput` infers from `schema` (the wire shape)
    // and `TDecoded` infers from `parse`'s return type (`Built`).
    const prompt = new Prompt({
      name: 'byo-output-decoded',
      description: 'parse returns a class instance',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      parse: (raw) => new Built(Number((raw as { value: number }).value)),
      validate: (output) => {
        // Compile-time: `output` is `Built` (has `doubled`).
        if (output.doubled() < 0) throw new Error('negative');
      },
    });

    const executor = createMockExecutor({
      response: { content: JSON.stringify({ value: 21 }), finishReason: 'stop' },
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);
    // Type-level: `result` is `Built | undefined`; `doubled()` type-checks.
    expect(result).toBeInstanceOf(Built);
    expect(result?.doubled()).toBe(42);

    // @ts-expect-error — the wire shape is not assignable to the decoded type.
    const bad: Built = { value: 1 };
    void bad;
  });

  it('should drive the DECODED output type from parse when it returns a PRIMITIVE (number)', async () => {
    // The widened `TDecoded extends unknown` constraint lets a Prompt's
    // structured-output `parse` return a non-object. The Zod `schema` is the
    // WIRE shape ({ value: number }); `parse` collapses it to a bare number.
    // The prompt's result (and `get('result')`) must be typed/returned as the
    // decoded `number`.
    const prompt = new Prompt({
      name: 'byo-output-number',
      description: 'parse returns a bare number',
      content: 'Test',
      schema: z.object({ value: z.number() }),
      parse: (raw) => Number((raw as { value: number }).value) + 1,
      validate: (output) => {
        // Compile-time: `output` is `number` (arithmetic type-checks).
        if (output < 0) throw new Error('negative');
      },
    });

    const executor = createMockExecutor({
      response: { content: JSON.stringify({ value: 41 }), finishReason: 'stop' },
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);
    // Type-level: `result` is `number | undefined`.
    const asNumber: number | undefined = result;
    expect(asNumber).toBe(42);
  });

  it('should drive the DECODED output type from parse when it returns an ARRAY', async () => {
    const prompt = new Prompt({
      name: 'byo-output-array',
      description: 'parse returns an array',
      content: 'Test',
      schema: z.object({ csv: z.string() }),
      parse: (raw) => (raw as { csv: string }).csv.split(',').map(Number),
    });

    const executor = createMockExecutor({
      response: { content: JSON.stringify({ csv: '1,2,3' }), finishReason: 'stop' },
    });
    const ctx: Context<{}, {}> = { execute: executor, messages: [] };

    const result = await prompt.get('result', {}, ctx);
    // Type-level: `result` is `number[] | undefined`.
    const asArray: number[] | undefined = result;
    expect(asArray).toEqual([1, 2, 3]);
    expect(asArray?.reduce((a, b) => a + b, 0)).toBe(6);
  });
});
