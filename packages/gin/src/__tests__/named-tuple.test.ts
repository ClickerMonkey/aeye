import { describe, test, expect } from 'vitest';
import { createRegistry, buildSchemas } from '../index';
import { TupleType } from '../types/tuple';

/**
 * Registering a named tuple via Extension — e.g. `Pair = [string, number]` —
 * should preserve its positional shape end-to-end: toValueSchema, toJSON
 * round-trip, and the opts.Type union from buildSchemas.
 */
describe('named tuple via Extension', () => {
  test('toValueSchema enforces the positional shape', () => {
    const r = createRegistry();
    const Pair = r.extend(r.tuple([r.text(), r.num()]), { name: 'Pair' });
    r.register(Pair);

    const s = Pair.toValueSchema();
    expect(s.safeParse(['hi', 42]).success).toBe(true);
    expect(s.safeParse([42, 'hi']).success).toBe(false); // wrong order
    expect(s.safeParse(['hi']).success).toBe(false);     // wrong length
  });

  test('JSON round-trip preserves elements', () => {
    const r = createRegistry();
    const Pair = r.extend(r.tuple([r.text(), r.num()]), { name: 'Pair' });
    r.register(Pair);

    const json = Pair.toJSON();
    // Cross-extend from an anonymous tuple → elements live in options.
    expect(json).toMatchObject({
      name: 'Pair',
      extends: 'tuple',
      options: { elements: [{ name: 'text' }, { name: 'num' }] },
    });

    const reparsed = r.parse(json);
    // Pull through to the base TupleType and check positions.
    const base = (reparsed as { base?: unknown }).base as TupleType;
    expect(base).toBeInstanceOf(TupleType);
    expect(base.elements.map((e) => e.name)).toEqual(['text', 'num']);
  });

  test('Pair appears in opts.Type as a name-only reference', () => {
    const r = createRegistry();
    const Pair = r.extend(r.tuple([r.text(), r.num()]), { name: 'Pair' });
    r.register(Pair);

    const opts = buildSchemas(r);
    // LLM can reference Pair by name.
    expect(opts.Type.safeParse({ name: 'Pair' }).success).toBe(true);
    // Nested usage: list<Pair>.
    expect(opts.Type.safeParse({
      name: 'list',
      generic: { V: { name: 'Pair' } },
    }).success).toBe(true);
  });

  test('compound: list<Pair> round-trip preserves the tuple shape at parse time', () => {
    const r = createRegistry();
    const Pair = r.extend(r.tuple([r.text(), r.num()]), { name: 'Pair' });
    r.register(Pair);

    const list = r.list(r.parse({ name: 'Pair' }));
    // The list's item resolves via lookup('Pair') → Extension over Tuple.
    const pairItem = list.item;
    expect(pairItem.name).toBe('Pair');
    // Drilling through to the effective tuple base:
    const base = (pairItem as { base?: unknown }).base as TupleType;
    expect(base.elements.map((e) => e.name)).toEqual(['text', 'num']);
  });
});
