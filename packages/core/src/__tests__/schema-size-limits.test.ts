/**
 * `FormatDescriptor.schemaSizeLimits` — the per-SCHEMA size ceilings a strict
 * dialect publishes, what `analyzeSchema` measures for them, and the degrade
 * `SchemaBudget` performs when a schema is over one.
 *
 * These are not the per-request budget (`maxStrictTools` and friends): every
 * bound here is a sum taken over ONE schema, so no other tool in the request
 * can change the verdict, and the answer is therefore a feasibility question —
 * an over-size schema is degraded even when it asked for `strict: true`.
 *
 * The numbers on `OPENAI_STRICT` are quoted from OpenAI's own "Supported
 * schemas" section (developers.openai.com, read 2026-08-23). All four were
 * RAISED in July 2025 (100→5000 properties, 15,000→120,000 characters,
 * 500→1000 enum values, 7,500→15,000 for a >250-value enum) and the pre-raise
 * figures are still widely quoted secondhand, so the first test pins them
 * against a well-meant "correction" downward.
 */

import { z } from 'zod';
import {
  ANTHROPIC_STRICT,
  GOOGLE_STRICT,
  LENIENT,
  OPENAI_NON_STRICT,
  OPENAI_STRICT,
  SchemaBudget,
  analyzeSchema,
  checkDescriptorConsistency,
  checkSchemaSizeLimits,
  type FormatDescriptor,
  type SchemaSizeLimits,
} from '../index';

/** Distinct names, `chars` characters each, so a test can aim at one bound. */
const names = (count: number, chars = 8): string[] =>
  Array.from({ length: count }, (_, i) => String(i).padStart(chars, 'n'));

/** Tiny bounds, so one limit at a time can be tripped in isolation. */
const TINY_LIMITS: SchemaSizeLimits = Object.freeze({
  maxObjectProperties: 4,
  maxNestingDepth: 2,
  maxTotalStringChars: 100,
  maxTotalEnumValues: 10,
  largeEnumValueCount: 3,
  maxLargeEnumStringChars: 40,
});

/** A synthetic dialect carrying them — no built-in has bounds this small. */
const TINY: FormatDescriptor = Object.freeze({
  ...OPENAI_STRICT,
  id: 'test-tiny-size',
  family: 'test-tiny-size',
  schemaSizeLimits: TINY_LIMITS,
});

describe('OPENAI_STRICT declares the documented Structured Outputs size limits', () => {
  it('carries the CURRENT (post-July-2025) numbers, not the pre-raise ones', () => {
    expect(OPENAI_STRICT.schemaSizeLimits).toEqual({
      maxObjectProperties: 5000,
      maxNestingDepth: 10,
      maxTotalStringChars: 120_000,
      maxTotalEnumValues: 1000,
      largeEnumValueCount: 250,
      maxLargeEnumStringChars: 15_000,
    });
  });

  it('is declared only where the API compiles the schema — strict OpenAI, nowhere else', () => {
    // Structured Outputs is what these bound. A non-strict schema is a
    // best-effort hint with no compiled decoder, which is exactly why
    // degrading an over-size item answers the problem completely.
    expect(OPENAI_NON_STRICT.schemaSizeLimits).toBeUndefined();
    expect(LENIENT.schemaSizeLimits).toBeUndefined();
    // Anthropic and Google publish per-request slot limits and keyword rules,
    // not size ceilings — an undeclared group means "no documented limit",
    // never "we did not get to it".
    expect(ANTHROPIC_STRICT.schemaSizeLimits).toBeUndefined();
    expect(GOOGLE_STRICT.schemaSizeLimits).toBeUndefined();
  });
});

describe('analyzeSchema measures what the size limits count', () => {
  it('records every enum separately, with its value count and string length', () => {
    const features = analyzeSchema(
      z.object({ a: z.enum(['xx', 'yy']), nested: z.object({ b: z.enum(['zzz']) }) }),
    );
    expect(features.enums).toEqual([
      { valueCount: 2, stringValueChars: 4 },
      { valueCount: 1, stringValueChars: 3 },
    ]);
  });

  it('counts a multi-value literal as an enum and a single one as a const', () => {
    // A one-value literal emits `const`, which no enum budget bounds — but its
    // characters still spend the total string budget.
    expect(analyzeSchema(z.literal(['a', 'b'])).enums).toEqual([{ valueCount: 2, stringValueChars: 2 }]);
    const single = analyzeSchema(z.object({ tag: z.literal('fixed') }));
    expect(single.enums).toEqual([]);
    expect(single.stringSizeChars).toBe('tag'.length + 'fixed'.length);
  });

  it('ignores a numeric enum\'s reverse mapping, exactly as the emitter does', () => {
    // A numeric TS enum compiles to a two-way map; counting both halves would
    // double every value relative to what actually goes on the wire.
    enum Level { Low = 0, High = 1 }
    expect(analyzeSchema(z.nativeEnum(Level)).enums).toEqual([{ valueCount: 2, stringValueChars: 0 }]);
  });

  it('sums object properties across every nesting level and reports the deepest', () => {
    const features = analyzeSchema(
      z.object({ a: z.string(), b: z.object({ c: z.string(), d: z.object({ e: z.string() }) }) }),
    );
    expect(features.objectPropertyCount).toBe(5); // a, b, c, d, e
    expect(features.maxNestingDepth).toBe(3);
  });

  it('treats optional / nullable / default wrappers as transparent for depth', () => {
    // They add no level on the wire, so they must not add one here either —
    // otherwise an optional-heavy schema degrades for a nesting it never emits.
    const wrapped = analyzeSchema(z.object({ a: z.object({ b: z.string() }).optional() }));
    const bare = analyzeSchema(z.object({ a: z.object({ b: z.string() }) }));
    expect(wrapped.maxNestingDepth).toBe(bare.maxNestingDepth);
  });

  it('counts array element nesting', () => {
    expect(analyzeSchema(z.object({ rows: z.array(z.object({ x: z.string() })) })).maxNestingDepth).toBe(3);
  });

  it('spends property names, enum values and const values on the string budget', () => {
    const features = analyzeSchema(z.object({ pick: z.enum(['alpha', 'beta']) }));
    expect(features.stringSizeChars).toBe('pick'.length + 'alpha'.length + 'beta'.length);
  });

  it('terminates on a recursive schema and still reports counts', () => {
    type Node = { value: string; children?: Node[] };
    const NodeSchema: z.ZodType<Node> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(NodeSchema).optional() }),
    );
    const features = analyzeSchema(NodeSchema);
    expect(features.hasRecursion).toBe(true);
    expect(features.objectPropertyCount).toBeGreaterThan(0);
  });
});

describe('checkSchemaSizeLimits', () => {
  it('says nothing when the dialect publishes no limits, however big the schema', () => {
    const huge = z.object({ pick: z.enum(names(5000)) });
    expect(checkSchemaSizeLimits(huge, LENIENT)).toEqual([]);
    expect(checkSchemaSizeLimits(huge, GOOGLE_STRICT)).toEqual([]);
  });

  it('passes an ordinary schema under OPENAI_STRICT', () => {
    expect(checkSchemaSizeLimits(z.object({ a: z.string(), b: z.enum(['x', 'y']) }), OPENAI_STRICT)).toEqual([]);
  });

  it('flags enum values SUMMED across properties, which no single-enum cap would catch', () => {
    // Six enums of 200, each fine on its own; 1200 together is over the 1000
    // the API counts. This is the shape the aggregate rule exists for.
    const schema = z.object(
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, z.enum(names(200, 4).map((n) => `${i}${n}`))])),
    );
    expect(checkSchemaSizeLimits(schema, OPENAI_STRICT)).toEqual([
      expect.stringContaining('enum values 1200 exceed maxTotalEnumValues 1000'),
    ]);
  });

  it('flags a large enum\'s characters only when that SAME enum is over the value threshold', () => {
    // 260 values × 100 chars = 26,000 > 15,000, and 260 > 250 → flagged.
    const big = z.object({ pick: z.enum(names(260, 100)) });
    expect(checkSchemaSizeLimits(big, OPENAI_STRICT)).toEqual([
      expect.stringContaining('maxLargeEnumStringChars'),
    ]);
    // 200 values × 100 chars = 20,000 characters, also over 15,000 — but the
    // rule does not apply below 250 values, so it must stay silent.
    const belowThreshold = z.object({ pick: z.enum(names(200, 100)) });
    expect(checkSchemaSizeLimits(belowThreshold, OPENAI_STRICT)).toEqual([]);
  });

  it('does not confuse a long-valued enum with a many-valued one', () => {
    // One enum is over the 250-value threshold but cheap in characters; the
    // other is expensive in characters but far under the threshold. Neither
    // trips BOTH halves, so the rule must stay silent — an implementation
    // keeping only "the largest value count" and "the largest character total"
    // would pair them up and report a violation nothing on the wire has.
    const schema = z.object({ many: z.enum(names(260, 4)), long: z.enum(names(4, 20_000)) });
    expect(checkSchemaSizeLimits(schema, OPENAI_STRICT)).toEqual([]);
  });

  it('flags total string characters, nesting depth and property count', () => {
    // TINY: 4 properties, depth 2, 100 characters.
    const deep = z.object({ a: z.object({ b: z.object({ c: z.string() }) }) });
    expect(checkSchemaSizeLimits(deep, TINY)).toEqual([expect.stringContaining('nesting depth 3 exceeds maxNestingDepth 2')]);

    const wide = z.object(Object.fromEntries(names(5, 2).map((n) => [n, z.string()])));
    expect(checkSchemaSizeLimits(wide, TINY)).toEqual([expect.stringContaining('object properties 5 exceed maxObjectProperties 4')]);

    const wordy = z.object({ a: z.enum(names(3, 60)) });
    expect(checkSchemaSizeLimits(wordy, TINY)).toEqual([expect.stringContaining('total string characters 181 exceed maxTotalStringChars 100')]);
  });

  it('reports every bound a schema breaks, not just the first', () => {
    const bad = z.object({ deep: z.object({ deeper: z.object({ pick: z.enum(names(20, 30)) }) }) });
    const problems = checkSchemaSizeLimits(bad, TINY);
    expect(problems.length).toBeGreaterThan(2);
  });
});

describe('SchemaBudget degrades an over-size schema', () => {
  const oversize = z.object({ pick: z.enum(names(1200, 4)) });
  const fine = z.object({ a: z.string() });

  it('degrades it even when strict was hard-required — the API would refuse to compile it', () => {
    const budget = new SchemaBudget(OPENAI_STRICT);
    expect(budget.allocateTool(oversize, true)).toBe(OPENAI_NON_STRICT);
    expect(budget.allocateTool(oversize, 5)).toBe(OPENAI_NON_STRICT);
  });

  it('leaves the rest of the request strict — the bound is per schema, not per request', () => {
    const budget = new SchemaBudget(OPENAI_STRICT);
    budget.allocateTool(oversize, true);
    expect(budget.allocateTool(fine, true)).toBe(OPENAI_STRICT);
  });

  it('still grants strict to a large-but-legal schema', () => {
    // 1000 values is the documented ceiling, not one past it, and 1000 × 4
    // characters is comfortably inside the 15,000-character large-enum rule.
    const budget = new SchemaBudget(OPENAI_STRICT);
    expect(budget.allocateTool(z.object({ pick: z.enum(names(1000, 4)) }), true)).toBe(OPENAI_STRICT);
  });

  it('ignores size for a dialect that publishes none', () => {
    const budget = new SchemaBudget(ANTHROPIC_STRICT);
    expect(budget.allocateTool(oversize, true)).toBe(ANTHROPIC_STRICT);
  });
});

describe('checkDescriptorConsistency guards the limit group itself', () => {
  const withLimits = (over: Partial<SchemaSizeLimits>): FormatDescriptor => ({
    ...TINY,
    schemaSizeLimits: { ...TINY_LIMITS, ...over },
  });

  it('flags a non-positive or fractional bound — it would silently disable strict mode', () => {
    expect(checkDescriptorConsistency(withLimits({ maxObjectProperties: 0 }))).toEqual([
      expect.stringContaining('schemaSizeLimits.maxObjectProperties must be a positive integer'),
    ]);
    expect(checkDescriptorConsistency(withLimits({ maxNestingDepth: 2.5 }))).toEqual([
      expect.stringContaining('schemaSizeLimits.maxNestingDepth must be a positive integer'),
    ]);
  });

  it('flags a large-enum threshold that can never be reached', () => {
    expect(checkDescriptorConsistency(withLimits({ largeEnumValueCount: 10 }))).toEqual([
      expect.stringContaining('can never apply'),
    ]);
  });

  it('flags size limits on a NON-strict descriptor — the API applies none', () => {
    expect(checkDescriptorConsistency({ ...LENIENT, schemaSizeLimits: TINY.schemaSizeLimits })).toEqual([
      expect.stringContaining('non-strict descriptor'),
    ]);
  });

  it('accepts the built-in that declares them', () => {
    expect(checkDescriptorConsistency(OPENAI_STRICT)).toEqual([]);
  });
});
