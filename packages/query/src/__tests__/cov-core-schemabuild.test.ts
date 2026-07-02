/**
 * Coverage: schema-build primitives — empty enum/orFold, refSchema 'none'
 * field mode, selectFunctions array/per-shape selectors, and the tabular +
 * typed function-call schema branches.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { fixture } from './_utils';
import {
  enumOf,
  orFold,
  refSchema,
  selectFunctions,
  functionExprSchema,
} from '../schema-build';

const fx = fixture();
// Register a tabular function so the tabular schema branches have a member.
fx.registry.registerFunction({ name: 'genRows', shape: 'tabular', params: [{ name: 'n', type: { kind: 'number' } }], output: { type: 'user' } });

const child = z.object({ kind: z.string() }).loose();

describe('enumOf / orFold empties collapse to never', () => {
  it('empty inputs → z.never()', () => {
    expect(enumOf([]).safeParse('x').success).toBe(false);
    expect(orFold([]).safeParse({}).success).toBe(false);
    // de-dupes + single-branch fold still works
    expect(enumOf(['a', 'a', 'b']).safeParse('b').success).toBe(true);
  });
});

describe('refSchema field mode "none"', () => {
  it('produces an object with only the key property (paired + flat)', () => {
    const opts = { keyName: 'source' as const, fieldMode: 'none' as const, eligible: (t: (typeof fx.user)) => t.fields, describe: 'no fields' };
    const flat = refSchema([fx.user], 'both', opts);
    expect(flat.safeParse({ source: 'user' }).success).toBe(true);
    const paired = refSchema([fx.user], 'paired', opts);
    expect(paired.safeParse({ source: 'user' }).success).toBe(true);
  });
});

describe('selectFunctions selectors', () => {
  it('array of names + per-shape object', () => {
    const byArray = selectFunctions(fx.registry, ['sum', 'concat', 'genRows']);
    expect(byArray.aggregate.map((f) => f.name)).toContain('sum');
    expect(byArray.scalar.map((f) => f.name)).toContain('concat');
    expect(byArray.tabular.map((f) => f.name)).toContain('genRows');
    // Per-shape object: scalar 'none', others default to 'all'.
    const byShape = selectFunctions(fx.registry, { scalar: 'none' });
    expect(byShape.scalar.length).toBe(0);
    expect(byShape.aggregate.length).toBeGreaterThan(0);
  });
});

describe('functionExprSchema tabular + typed branches', () => {
  const open = z.object({ kind: z.literal('tabular-function-call') }).loose();

  it('open depth / no selection returns the open schema', () => {
    expect(functionExprSchema('tabular-function-call', open, undefined, 'open', child)).toBe(open);
    const selected = selectFunctions(fx.registry, 'all');
    expect(functionExprSchema('tabular-function-call', open, selected, 'open', child)).toBe(open);
  });

  it('names + typed depth builds the tabular-function-call object', () => {
    const selected = selectFunctions(fx.registry, 'all');
    const named = functionExprSchema('tabular-function-call', open, selected, 'names', child);
    expect(named.safeParse({ kind: 'tabular-function-call', function: 'genRows', args: { n: { kind: 'literal' } } }).success).toBe(true);
    const typed = functionExprSchema('tabular-function-call', open, selected, 'typed', child);
    expect(typed.safeParse({ kind: 'tabular-function-call', function: 'genRows', args: { n: { kind: 'x' } } }).success).toBe(true);
  });

  it('typed depth with no selected functions collapses to never', () => {
    const none = selectFunctions(fx.registry, { tabular: 'none' });
    const typed = functionExprSchema('tabular-function-call', open, none, 'typed', child);
    expect(typed.safeParse({ kind: 'tabular-function-call', function: 'genRows', args: {} }).success).toBe(false);
  });
});
