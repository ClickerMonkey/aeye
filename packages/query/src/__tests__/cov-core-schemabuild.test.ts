/**
 * Coverage: the grammar's building blocks (`QueryGrammarBuild`) — a reference
 * with no field ('none' mode), `selectFunctions` array/per-shape selectors, and
 * the tabular + typed function-call branches — each checked through a bound,
 * rendered schema.
 */
import { describe, it, expect } from 'vitest';
import { a, Bundle, LENIENT, type AnySchema } from '@aeye/schema';
import { fixture } from './_utils';
import { selectFunctions } from '../schema-build';
import { QueryGrammarBuild } from '../llm/grammar';
import { resolveDepthFor } from '../llm/depth';
import { QueryGrammar } from '../llm/schemas';

const fx = fixture();
// Register a tabular function so the tabular branches have a member.
fx.registry.registerFunction({ name: 'genRows', shape: 'tabular', params: [{ name: 'n', type: { kind: 'number' } }], output: { type: 'user' } });

/** A build over the fixture at a depth, as the dynamic step makes one. */
function build(functions: 'open' | 'names' | 'typed', selector: Parameters<typeof selectFunctions>[1] = 'all'): QueryGrammarBuild {
  const types = fx.registry.typeList();
  const selected = selectFunctions(fx.registry, selector);
  const depth = { ...resolveDepthFor(types, selected, {}), functions };
  return new QueryGrammarBuild(fx.registry, types, depth, selected);
}

/** Whether `s` (with the build's shared fragments and the grammar's Expr) accepts `value`. */
function accepts(b: QueryGrammarBuild, s: AnySchema, value: unknown): boolean {
  const env = QueryGrammar.result('Expr').bind(fx.registry).env;
  const defs = { ...Object.fromEntries(env), ...b.defs };
  return new Bundle<unknown>(defs, s).bind().render(LENIENT).parse(structuredClone(value)).ok;
}

describe('a reference with field mode "none"', () => {
  it('is an object with only the key property (paired + flat)', () => {
    const b = build('open');
    const opts = { keyName: 'source' as const, fieldMode: 'none' as const, eligible: (t: typeof fx.user) => t.fields, describe: 'no fields' };
    expect(accepts(b, b.ref('both', opts), { source: 'user' })).toBe(true);
    expect(accepts(b, b.ref('paired', opts), { source: 'user' })).toBe(true);
    expect(accepts(b, b.ref('paired', opts), { source: 'ghost' })).toBe(false);
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

describe('function-call branches: tabular + typed', () => {
  const open = a.object({ kind: a.literal('tabular-function-call') });
  const lit = { kind: 'literal', value: 1 };

  it('open depth returns the open shape as given', () => {
    expect(build('open').fn('tabular-function-call', open)).toBe(open);
  });

  it('names + typed depth build the tabular-function-call object', () => {
    const named = build('names');
    expect(accepts(named, named.fn('tabular-function-call', open), { kind: 'tabular-function-call', function: 'genRows', args: { n: lit } })).toBe(true);
    expect(accepts(named, named.fn('tabular-function-call', open), { kind: 'tabular-function-call', function: 'nope', args: {} })).toBe(false);
    const typed = build('typed');
    expect(accepts(typed, typed.fn('tabular-function-call', open), { kind: 'tabular-function-call', function: 'genRows', args: { n: lit } })).toBe(true);
  });

  it('typed depth with no selected functions accepts nothing', () => {
    const none = build('typed', { tabular: 'none' });
    expect(accepts(none, none.fn('tabular-function-call', open), { kind: 'tabular-function-call', function: 'genRows', args: {} })).toBe(false);
  });

  it('typed depth: an optional param may be omitted; an undeclared one is refused; no required param ⇒ args optional', () => {
    fx.registry.registerFunction({
      name: 'optFn',
      shape: 'scalar',
      params: [{ name: 'a', type: { kind: 'number' } }, { name: 'b', type: { kind: 'number' }, optional: true }],
      output: { kind: 'number' },
    });
    fx.registry.registerFunction({ name: 'noArgs', shape: 'scalar', params: [], output: { kind: 'number' } });
    const scalarOpen = a.object({ kind: a.literal('function-call') });
    const b = build('typed', { scalar: ['optFn', 'noArgs'] });
    const typed = b.fn('function-call', scalarOpen);
    expect(accepts(b, typed, { kind: 'function-call', function: 'optFn', args: { a: lit } })).toBe(true);
    expect(accepts(b, typed, { kind: 'function-call', function: 'optFn', args: { a: lit, z: lit } })).toBe(false);
    expect(accepts(b, typed, { kind: 'function-call', function: 'noArgs' })).toBe(true);
    // Signatures, not functions, name the shared args objects.
    expect(Object.keys(b.defs).filter((k) => k.startsWith('Args'))).toHaveLength(2);
  });
});
