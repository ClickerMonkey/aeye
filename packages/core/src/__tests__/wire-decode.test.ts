/**
 * Wire → conceptual DECODE tests (`relaxValidation` + `decodeWire`).
 *
 * `strictify` ENCODEs a conceptual Zod schema into a provider's wire dialect
 * (array-of-pairs records, numeric-key tuples, null-for-optional). Those
 * decode preprocesses only run when Zod VALIDATES — a custom `parse` hook
 * skips validation, so `decodeWire` runs a NON-FAILING relaxed variant of the
 * strictified schema to DECODE the wire value back to the conceptual shape
 * before the custom parser sees it.
 *
 * These tests exhaustively cover:
 *  - `relaxValidation` across every Zod node kind (leaves, containers,
 *    wrappers, transforms, combinators, recursion) and that transforms STILL
 *    RUN while validation is dropped.
 *  - `decodeWire` leniency (never throws, best-effort) and SYMMETRY per
 *    built-in descriptor (wire → conceptual round-trip).
 *  - The two custom-parse wiring sites (`Tool.parse`, `Prompt` output parse).
 */

import { z } from 'zod';
import {
  relaxValidation,
  decodeWire,
  strictify,
  LENIENT,
  OPENAI_STRICT,
  OPENAI_NON_STRICT,
  ANTHROPIC_STRICT,
  ANTHROPIC_NON_STRICT,
  GOOGLE_STRICT,
  GOOGLE_NON_STRICT,
  type FormatDescriptor,
} from '../schema';
import { Tool } from '../tool';
import { Prompt } from '../prompt';
import type { Context } from '../types';

// Parse through a relaxed (non-strictified) schema — used to prove that
// relaxValidation keeps transforms while dropping validation.
const relaxParse = (schema: z.ZodType, value: unknown) =>
  relaxValidation(schema).safeParse(value);

describe('relaxValidation', () => {
  describe('validating leaves relax to accept anything (never fail)', () => {
    const leaves: Array<[string, z.ZodType]> = [
      ['string', z.string()],
      ['number', z.number()],
      ['int', z.int()],
      ['boolean', z.boolean()],
      ['enum', z.enum(['a', 'b'])],
      ['literal', z.literal('x')],
      ['date', z.date()],
      ['bigint', z.bigint()],
      ['null', z.null()],
      ['undefined', z.undefined()],
      ['any', z.any()],
      ['unknown', z.unknown()],
      ['void', z.void()],
      ['nan', z.nan()],
      ['symbol', z.symbol()],
    ];

    for (const [name, schema] of leaves) {
      it(`${name}: a value the leaf would reject still parses`, () => {
        // Feed a value of the "wrong" type — the relaxed leaf must accept it.
        const wrong = { deliberately: 'wrong', shape: [1, 2, 3] };
        const r = relaxParse(schema, wrong);
        expect(r.success).toBe(true);
        if (r.success) expect(r.data).toEqual(wrong);
      });
    }
  });

  describe('containers recurse (nested transforms are reached)', () => {
    it('flat object: unknown keys pass through, fields optional', () => {
      const s = z.object({ a: z.string(), b: z.number() });
      const r = relaxParse(s, { a: 'x', extra: true });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({ a: 'x', extra: true });
    });

    it('deeply nested object', () => {
      const s = z.object({
        l1: z.object({ l2: z.object({ l3: z.object({ leaf: z.number() }) }) }),
      });
      const val = { l1: { l2: { l3: { leaf: 5 } } } };
      const r = relaxParse(s, val);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual(val);
    });

    it('array of scalars / objects / arrays', () => {
      expect(relaxParse(z.array(z.number()), [1, 2, 3]).success).toBe(true);
      expect(relaxParse(z.array(z.object({ a: z.string() })), [{ a: 'x' }]).success).toBe(true);
      expect(relaxParse(z.array(z.array(z.number())), [[1], [2, 3]]).success).toBe(true);
    });

    it('tuple fixed + rest', () => {
      const fixed = z.tuple([z.string(), z.number()]);
      expect(relaxParse(fixed, ['a', 1]).success).toBe(true);
      const rest = z.tuple([z.string()], z.number());
      const r = relaxParse(rest, ['a', 1, 2, 3]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual(['a', 1, 2, 3]);
    });

    it('record', () => {
      const r = relaxParse(z.record(z.string(), z.number()), { a: 1, b: 2 });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({ a: 1, b: 2 });
    });

    it('map + set', () => {
      const m = relaxParse(z.map(z.string(), z.number()), new Map([['a', 1]]));
      expect(m.success).toBe(true);
      const s = relaxParse(z.set(z.number()), new Set([1, 2]));
      expect(s.success).toBe(true);
    });

    it('empty object / array / tuple / record', () => {
      expect(relaxParse(z.object({}), {}).success).toBe(true);
      expect(relaxParse(z.array(z.number()), []).success).toBe(true);
      expect(relaxParse(z.tuple([]), []).success).toBe(true);
      expect(relaxParse(z.record(z.string(), z.number()), {}).success).toBe(true);
    });
  });

  describe('wrappers unwrap + re-wrap', () => {
    it('optional / nullable / nullish alone', () => {
      expect(relaxParse(z.string().optional(), undefined).success).toBe(true);
      expect(relaxParse(z.string().nullable(), null).success).toBe(true);
      const nn = relaxParse(z.string().nullish(), null);
      expect(nn.success).toBe(true);
    });

    it('default applies when input absent', () => {
      const r = relaxParse(z.string().default('D'), undefined);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe('D');
    });

    it('catch is harmless (inner never fails once relaxed)', () => {
      const r = relaxParse(z.number().catch(0), 'not a number');
      expect(r.success).toBe(true);
      // Inner relaxed to accept anything → catch does not trigger, value passes.
      if (r.success) expect(r.data).toBe('not a number');
    });

    it('readonly / branded', () => {
      expect(relaxParse(z.string().readonly(), 'x').success).toBe(true);
      expect(relaxParse(z.string().brand('B'), 'x').success).toBe(true);
    });

    it('stacked wrappers (optional(nullable(default(readonly)))', () => {
      const s = z.string().readonly().default('D').nullable().optional();
      expect(relaxParse(s, undefined).success).toBe(true);
      expect(relaxParse(s, null).success).toBe(true);
      expect(relaxParse(s, 'v').success).toBe(true);
    });
  });

  describe('transforms STILL RUN through relaxValidation', () => {
    it('preprocess runs', () => {
      const s = z.preprocess((v) => (typeof v === 'string' ? v.length : v), z.number());
      const r = relaxParse(s, 'hello');
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(5);
    });

    it('.transform runs', () => {
      const s = z.string().transform((v) => v.toUpperCase());
      const r = relaxParse(s, 'hi');
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe('HI');
    });

    it('codec decode runs', () => {
      const s = z.codec(z.string(), z.number(), {
        decode: (str) => parseInt(str, 10),
        encode: (n) => String(n),
      });
      const r = relaxParse(s, '42');
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(42);
    });

    it('pipe runs both stages', () => {
      const s = z.pipe(
        z.string().transform((v) => v.trim()),
        z.string().transform((v) => v.length),
      );
      const r = relaxParse(s, '  ab  ');
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toBe(2);
    });

    it('refine / superRefine validation is DROPPED (never fails)', () => {
      const refined = z.string().refine((v) => v.length > 100, 'too short');
      expect(relaxParse(refined, 'short').success).toBe(true);
      const superRefined = z.number().superRefine((v, ctx) => {
        if (v < 1000) ctx.addIssue({ code: 'custom', message: 'too small' });
      });
      expect(relaxParse(superRefined, 1).success).toBe(true);
    });

    it('transform nested inside a relaxed (all-optional) object still runs', () => {
      const s = z.object({
        upper: z.string().transform((v) => v.toUpperCase()),
        raw: z.string(),
      });
      const r = relaxParse(s, { upper: 'abc', raw: 'keep' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({ upper: 'ABC', raw: 'keep' });
    });
  });

  describe('combinators', () => {
    it('union of primitives', () => {
      const s = z.union([z.string(), z.number()]);
      expect(relaxParse(s, 'x').success).toBe(true);
      expect(relaxParse(s, 5).success).toBe(true);
    });

    it('union of objects picks the discriminating branch (transform runs)', () => {
      // Discrimination works when each option carries a structural field the
      // OTHER option lacks (a record here) — a required record rejects a
      // missing key, so the wrong branch fails and the right one wins. The
      // transform lives on the record's value so we also prove option-internal
      // transforms run.
      const s = z.union([
        z.object({ amap: z.record(z.string(), z.string().transform((v) => `A:${v}`)) }),
        z.object({ bmap: z.record(z.string(), z.string().transform((v) => `B:${v}`)) }),
      ]);
      const rb = relaxParse(s, { bmap: { k: 'x' } });
      expect(rb.success).toBe(true);
      if (rb.success) expect(rb.data).toEqual({ bmap: { k: 'B:x' } });
    });

    it('discriminatedUnion', () => {
      const s = z.discriminatedUnion('type', [
        z.object({ type: z.literal('num'), value: z.number() }),
        z.object({ type: z.literal('str'), value: z.string() }),
      ]);
      expect(relaxParse(s, { type: 'str', value: 'hi' }).success).toBe(true);
    });

    it('intersection (both sides relaxed, transforms run)', () => {
      const s = z.intersection(
        z.object({ a: z.string() }),
        z.object({ b: z.string().transform((v) => v.length) }),
      );
      const r = relaxParse(s, { a: 'x', b: 'four' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({ a: 'x', b: 4 });
    });
  });

  describe('recursion (z.lazy self-reference must not infinite-loop)', () => {
    it('relaxes a self-referential lazy schema and parses a nested value', () => {
      type Tree = { name: string; children?: Tree[] };
      const Tree: z.ZodType<Tree> = z.lazy(() =>
        z.object({ name: z.string(), children: z.array(Tree).optional() }),
      );
      const relaxed = relaxValidation(Tree); // must return (not hang)
      const value = { name: 'root', children: [{ name: 'a' }, { name: 'b', children: [{ name: 'c' }] }] };
      const r = relaxed.safeParse(value);
      expect(r.success).toBe(true);
      if (r.success) expect((r.data as Tree).name).toBe('root');
    });

    it('mutually recursive lazy schemas terminate', () => {
      type A = { b?: B };
      type B = { a?: A };
      const A: z.ZodType<A> = z.lazy(() => z.object({ b: B.optional() }));
      const B: z.ZodType<B> = z.lazy(() => z.object({ a: A.optional() }));
      const r = relaxValidation(A).safeParse({ b: { a: { b: {} } } });
      expect(r.success).toBe(true);
    });
  });

  describe('combined nestings', () => {
    it('object → optional → record(value) with a transform on the value', () => {
      const s = z.object({
        meta: z.record(z.string(), z.string().transform((v) => v.toUpperCase())).optional(),
      });
      const r = relaxParse(s, { meta: { k: 'v' } });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({ meta: { k: 'V' } });
    });

    it('tuple inside object inside array', () => {
      const s = z.array(z.object({ pair: z.tuple([z.string(), z.number()]) }));
      const r = relaxParse(s, [{ pair: ['a', 1] }, { pair: ['b', 2] }]);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual([{ pair: ['a', 1] }, { pair: ['b', 2] }]);
    });

    it('deep stack of preprocess + optional + object', () => {
      const s = z.object({
        wrapped: z
          .preprocess((v) => (v === 'EMPTY' ? {} : v), z.object({ inner: z.number() }))
          .optional(),
      });
      const present = relaxParse(s, { wrapped: { inner: 3 } });
      expect(present.success).toBe(true);
      const preprocessed = relaxParse(s, { wrapped: 'EMPTY' });
      expect(preprocessed.success).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// decodeWire
// ---------------------------------------------------------------------------

describe('decodeWire', () => {
  describe('best-effort / never throws', () => {
    const schema = z.object({ a: z.record(z.string(), z.number()) });

    it('garbage that cannot parse passes through unchanged', () => {
      expect(decodeWire(schema, 12345, OPENAI_STRICT)).toBe(12345);
      expect(decodeWire(schema, null, OPENAI_STRICT)).toBe(null);
      expect(decodeWire(schema, 'a string', OPENAI_STRICT)).toBe('a string');
    });

    it('leniency: valid-shaped record next to an INVALID sibling leaf', () => {
      // The record decodes; the bad sibling (wrong type) passes through; the
      // overall decode succeeds and never throws.
      const s = z.object({
        rec: z.record(z.string(), z.number()),
        n: z.number(),
      });
      const wire = { rec: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }], n: 'NOT A NUMBER' };
      const decoded = decodeWire(s, wire, OPENAI_STRICT);
      expect(decoded).toEqual({ rec: { a: 1, b: 2 }, n: 'NOT A NUMBER' });
    });
  });

  describe('specifics', () => {
    it('null-for-optional → field absent (undefined)', () => {
      const s = z.object({ name: z.string(), note: z.string().optional() });
      const decoded = decodeWire(s, { name: 'x', note: null }, OPENAI_STRICT) as Record<string, unknown>;
      expect(decoded).toEqual({ name: 'x' });
      expect('note' in decoded ? decoded.note : undefined).toBeUndefined();
    });

    it('array-of-pairs → record (last duplicate key wins)', () => {
      const s = z.object({ m: z.record(z.string(), z.number()) });
      const wire = { m: [{ key: 'a', value: 1 }, { key: 'a', value: 9 }, { key: 'b', value: 2 }] };
      expect(decodeWire(s, wire, OPENAI_STRICT)).toEqual({ m: { a: 9, b: 2 } });
    });

    it('array-of-pairs → record (entries missing key/value are skipped)', () => {
      const s = z.object({ m: z.record(z.string(), z.number()) });
      const wire = { m: [{ key: 'a', value: 1 }, { novalue: true }, { key: 'b', value: 2 }] };
      expect(decodeWire(s, wire, OPENAI_STRICT)).toEqual({ m: { a: 1, b: 2 } });
    });

    it('numeric-key object → tuple', () => {
      const s = z.object({ point: z.tuple([z.number(), z.number(), z.string()]) });
      const wire = { point: { '0': 1, '1': 2, '2': 'z' } };
      expect(decodeWire(s, wire, OPENAI_STRICT)).toEqual({ point: [1, 2, 'z'] });
    });

    it('nested record-inside-array decodes each element', () => {
      const s = z.object({ rows: z.array(z.record(z.string(), z.number())) });
      const wire = { rows: [[{ key: 'a', value: 1 }], [{ key: 'b', value: 2 }]] };
      expect(decodeWire(s, wire, OPENAI_STRICT)).toEqual({ rows: [{ a: 1 }, { b: 2 }] });
    });
  });

  describe('SYMMETRY round-trip per built-in descriptor', () => {
    // One rich CONCEPTUAL schema + value; each descriptor gets its OWN wire
    // fixture derived from its flags (record encoding, tuple encoding,
    // optional-as-nullable). Decoding that wire must reproduce the conceptual
    // value. A new descriptor with different flags forces a new fixture.
    const schema = z.object({
      id: z.string(),
      scores: z.record(z.string(), z.number()),
      coord: z.tuple([z.number(), z.number()]),
      note: z.string().optional(), // present
      extra: z.string().optional(), // absent
    });
    const conceptual = { id: 'x', scores: { a: 1, b: 2 }, coord: [10, 20], note: 'hi' };

    // Build the wire form a model would send under `d`.
    const buildWire = (d: FormatDescriptor): Record<string, unknown> => {
      const scores =
        d.recordEncoding === 'array-of-pairs'
          ? [{ key: 'a', value: 1 }, { key: 'b', value: 2 }]
          : { a: 1, b: 2 };
      const coord = d.tupleEncoding === 'object-numeric-keys' ? { '0': 10, '1': 20 } : [10, 20];
      const wire: Record<string, unknown> = { id: 'x', scores, coord, note: 'hi' };
      // Absent optional: OpenAI-strict sends explicit null; others omit.
      if (d.optionalAsNullable) wire.extra = null;
      return wire;
    };

    const descriptors: Array<[string, FormatDescriptor]> = [
      ['LENIENT', LENIENT],
      ['OPENAI_STRICT', OPENAI_STRICT],
      ['OPENAI_NON_STRICT', OPENAI_NON_STRICT],
      ['ANTHROPIC_STRICT', ANTHROPIC_STRICT],
      ['ANTHROPIC_NON_STRICT', ANTHROPIC_NON_STRICT],
      ['GOOGLE_STRICT', GOOGLE_STRICT],
      ['GOOGLE_NON_STRICT', GOOGLE_NON_STRICT],
    ];

    for (const [name, d] of descriptors) {
      it(`${name}: wire → conceptual round-trips`, () => {
        const wire = buildWire(d);
        const decoded = decodeWire(schema, wire, d);
        expect(decoded).toEqual(conceptual);
      });
    }

    it('the OpenAI-strict fixture differs from the Google-strict fixture', () => {
      // Sanity: distinct descriptors really do produce distinct wire shapes.
      expect(buildWire(OPENAI_STRICT)).not.toEqual(buildWire(GOOGLE_STRICT));
    });
  });

  describe('symmetry with transforms + unions per strict descriptor', () => {
    it('OPENAI_STRICT: union of objects each carrying a record', () => {
      const schema = z.union([
        z.object({ kind: z.literal('a'), amap: z.record(z.string(), z.number()) }),
        z.object({ kind: z.literal('b'), bmap: z.record(z.string(), z.string()) }),
      ]);
      expect(decodeWire(schema, { kind: 'a', amap: [{ key: 'k', value: 9 }] }, OPENAI_STRICT)).toEqual({
        kind: 'a',
        amap: { k: 9 },
      });
      expect(decodeWire(schema, { kind: 'b', bmap: [{ key: 'k', value: 'v' }] }, OPENAI_STRICT)).toEqual({
        kind: 'b',
        bmap: { k: 'v' },
      });
    });

    it('ANTHROPIC_STRICT: records → array-of-pairs, tuples stay arrays, optional omitted', () => {
      const schema = z.object({
        m: z.record(z.string(), z.number()),
        t: z.tuple([z.string(), z.number()]),
        opt: z.number().optional(),
      });
      const wire = { m: [{ key: 'a', value: 1 }], t: ['x', 2] };
      expect(decodeWire(schema, wire, ANTHROPIC_STRICT)).toEqual({ m: { a: 1 }, t: ['x', 2] });
    });

    it('recursive lazy schema with a record inside round-trips (OPENAI_STRICT)', () => {
      type N = { name: string; meta: Record<string, string>; children?: N[] };
      const N: z.ZodType<N> = z.lazy(() =>
        z.object({
          name: z.string(),
          meta: z.record(z.string(), z.string()),
          children: z.array(N).optional(),
        }),
      );
      const wire = {
        name: 'root',
        meta: [{ key: 'a', value: 'b' }],
        children: [{ name: 'child', meta: [{ key: 'x', value: 'y' }] }],
      };
      const decoded = decodeWire(N, wire, OPENAI_STRICT);
      expect(decoded).toEqual({
        name: 'root',
        meta: { a: 'b' },
        children: [{ name: 'child', meta: { x: 'y' } }],
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Wiring: Tool.parse + Prompt output parse hand the conceptual value to a
// custom `parse`.
// ---------------------------------------------------------------------------

describe('custom-parse wiring receives the CONCEPTUAL value', () => {
  describe('Tool.parse', () => {
    const makeTool = (received: { raw?: unknown }) =>
      new Tool<{}, {}, unknown, { args: Record<string, string>; limit?: number }>({
        name: 'wire-tool',
        description: 'decode before custom parse',
        instructions: '',
        schema: z.object({
          args: z.record(z.string(), z.string()),
          limit: z.number().optional(),
        }),
        parse: (raw) => {
          received.raw = raw;
          return raw as { args: Record<string, string>; limit?: number };
        },
        call: () => 'ok',
      });

    it('with OPENAI_STRICT descriptor: array-of-pairs + null-optional decoded', async () => {
      const received: { raw?: unknown } = {};
      const tool = makeTool(received);
      const ctx = {} as Context<{}, {}>;
      const wire = JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null });
      await tool.parse(ctx, wire, undefined, OPENAI_STRICT);
      // Custom parser saw the conceptual value: record + optional omitted.
      expect(received.raw).toEqual({ args: { a: 'b' } });
    });

    it('with descriptor id string: same decode', async () => {
      const received: { raw?: unknown } = {};
      const tool = makeTool(received);
      const ctx = {} as Context<{}, {}>;
      const wire = JSON.stringify({ args: [{ key: 'k', value: 'v' }], limit: 5 });
      await tool.parse(ctx, wire, undefined, 'openai-strict');
      expect(received.raw).toEqual({ args: { k: 'v' }, limit: 5 });
    });

    it('with NO descriptor: raw wire passes through UNCHANGED', async () => {
      const received: { raw?: unknown } = {};
      const tool = makeTool(received);
      const ctx = {} as Context<{}, {}>;
      const wire = JSON.stringify({ args: [{ key: 'a', value: 'b' }] });
      await tool.parse(ctx, wire);
      // No descriptor → no decode → custom parser sees the raw array-of-pairs.
      expect(received.raw).toEqual({ args: [{ key: 'a', value: 'b' }] });
    });
  });

  describe('Prompt output parse', () => {
    const makePrompt = (received: { raw?: unknown }) =>
      new Prompt<{}, {}, string, {}, { args: Record<string, string>; limit?: number }>({
        name: 'wire-prompt',
        description: 'decode before custom output parse',
        content: 'Test',
        schema: z.object({
          args: z.record(z.string(), z.string()),
          limit: z.number().optional(),
        }),
        parse: (raw) => {
          received.raw = raw;
          return raw as { args: Record<string, string>; limit?: number };
        },
      });

    it('with OPENAI_STRICT descriptor pinned on the response format', async () => {
      const received: { raw?: unknown } = {};
      const prompt = makePrompt(received);
      // The provider pins the descriptor on request.responseFormat; emulate
      // that by mutating the request the prompt hands to the executor.
      const executor = jest.fn(async (request: any) => {
        request.responseFormat.descriptor = 'openai-strict';
        return {
          content: JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null }),
          finishReason: 'stop',
          model: 'mock',
        };
      });
      const ctx: Context<{}, {}> = { execute: executor, messages: [] };
      const result = await prompt.get('result', {}, ctx);
      expect(received.raw).toEqual({ args: { a: 'b' } });
      expect(result).toEqual({ args: { a: 'b' } });
    });

    it('with NO descriptor: raw wire passes through UNCHANGED', async () => {
      const received: { raw?: unknown } = {};
      const prompt = makePrompt(received);
      const executor = jest.fn(async () => ({
        content: JSON.stringify({ args: [{ key: 'a', value: 'b' }] }),
        finishReason: 'stop',
        model: 'mock',
      }));
      const ctx: Context<{}, {}> = { execute: executor, messages: [] };
      await prompt.get('result', {}, ctx);
      expect(received.raw).toEqual({ args: [{ key: 'a', value: 'b' }] });
    });
  });
});
