/**
 * `toValueSchema({ unknownKeys: 'refuse' })` — refusing a key the type does
 * not declare, at boundaries where an undeclared key is a TYPO.
 *
 * The measured hole: a settings payload validated through a generated value
 * schema parsed CLEAN with its mis-spelt knob silently gone.
 *
 *   obj{type: text, charThreshold: num}.toValueSchema()
 *     .safeParse({type:'graph', charThreshold:5000, bogus:1})
 *   → success, data = {type:'graph', charThreshold:5000}
 *
 * A REQUIRED knob is safe (it fails as missing); a mis-spelt OPTIONAL one
 * disappears without a word, is stored, and does nothing — with no error at any
 * layer for anyone to act on.
 *
 * WHY OPT-IN, when the wire side refuses unconditionally. Because on the value
 * side an extra key is not automatically a mistake: gin's own value semantics
 * are width-subtyped, and the tests below pin all three surfaces that say so —
 * `obj{a}` is `compatible` with `obj{a, zz}`, `valid` reads only the declared
 * fields, and `parse` copies them and drops the rest. Strict-by-default would
 * make the generated schema the one surface in the library that rejects a value
 * gin's type system calls a value of that type. Whether the extra key is width
 * or a typo depends on the BOUNDARY — an authored settings bag versus a wider
 * row flowing through a narrower view — and only the caller knows which.
 */
import { describe, test, expect } from 'vitest';
import { createRegistry, Value } from '../index';

const r = createRegistry();

/** The measured config: one required text, one required num. */
const config = () => r.obj({ type: { type: r.text() }, charThreshold: { type: r.num() } });

describe('the default is strip, and it matches the rest of the type system', () => {
  test('an undeclared key is dropped — the behaviour that lost a knob', () => {
    const got = config().toValueSchema().safeParse({ type: 'graph', charThreshold: 5000, bogus: 1 });
    expect(got.success).toBe(true);
    expect(got.data).toEqual({ type: 'graph', charThreshold: 5000 });
  });

  test('a REQUIRED knob is never the victim — it fails as missing', () => {
    expect(config().toValueSchema().safeParse({ type: 'graph' }).success).toBe(false);
  });

  test('why stripping is defensible: the type system is width-subtyped', () => {
    // 1. compatibility — a wider obj IS an acceptable value of a narrower one.
    const narrow = r.obj({ a: { type: r.num() } });
    const wide = r.obj({ a: { type: r.num() }, zz: { type: r.num() } });
    expect(narrow.compatible(wide)).toBe(true);
    expect(wide.compatible(narrow)).toBe(false);
    // 2. `valid` reads the declared fields and ignores the rest.
    const raw = { a: new Value(r.num(), 1) };
    expect(narrow.valid(raw)).toBe(true);
    expect(narrow.valid({ ...raw, zz: 9 })).toBe(true);
    // 3. `parse` keeps the declared fields and drops the rest.
    expect(Object.keys(narrow.parse({ a: 1, zz: 9 }).raw as object)).toEqual(['a']);
  });
});

describe("unknownKeys: 'refuse'", () => {
  test('the typo is named, with its path', () => {
    const got = config().toValueSchema({ unknownKeys: 'refuse' })
      .safeParse({ type: 'graph', charThreshold: 5000, bogus: 1 });
    expect(got.success).toBe(false);
    expect(got.error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', keys: ['bogus'], path: [] });
  });

  test('a legitimate payload is untouched', () => {
    const got = config().toValueSchema({ unknownKeys: 'refuse' })
      .safeParse({ type: 'graph', charThreshold: 5000 });
    expect(got.success).toBe(true);
    expect(got.data).toEqual({ type: 'graph', charThreshold: 5000 });
  });

  test('it reaches NESTED slots — one option, the whole payload', () => {
    const outer = r.obj({ inner: { type: config() }, items: { type: r.list(config()) } });
    const schema = outer.toValueSchema({ unknownKeys: 'refuse' });

    expect(schema.safeParse({
      inner: { type: 'g', charThreshold: 1, bogus: 1 },
      items: [],
    }).error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', path: ['inner'] });

    expect(schema.safeParse({
      inner: { type: 'g', charThreshold: 1 },
      items: [{ type: 'g', charThreshold: 1, bogus: 1 }],
    }).error?.issues[0]).toMatchObject({ code: 'unrecognized_keys', path: ['items', 0] });
  });

  test("a map's entry envelope is checked too", () => {
    const schema = r.map(r.text(), r.num()).toValueSchema({ unknownKeys: 'refuse' });
    expect(schema.safeParse([{ key: 'k', value: 1 }]).success).toBe(true);
    expect(schema.safeParse([{ key: 'k', value: 1, zz: 3 }]).error?.issues[0])
      .toMatchObject({ code: 'unrecognized_keys', keys: ['zz'], path: [0] });
  });

  test("an Extension's local props are part of the declared set, not an extra", () => {
    const ext = r.extend(r.obj({ a: { type: r.num() } }), {
      name: 'Settings',
      props: { c: { type: r.text() } },
    });
    const schema = ext.toValueSchema({ unknownKeys: 'refuse' });
    expect(schema.safeParse({ a: 1, c: 'x' }).success).toBe(true);
    expect(schema.safeParse({ a: 1, c: 'x', zz: 2 }).error?.issues[0])
      .toMatchObject({ code: 'unrecognized_keys', keys: ['zz'] });
  });

  test('an interface passes width through by DEFAULT and refuses when asked', () => {
    // An interface is a contract — a value carrying more still satisfies it,
    // which is why this one is passthrough rather than strip.
    const iface = r.iface({ props: { a: { type: r.num() } } });
    expect(iface.toValueSchema().safeParse({ a: 1, zz: 2 }).data).toEqual({ a: 1, zz: 2 });
    expect(iface.toValueSchema({ unknownKeys: 'refuse' }).safeParse({ a: 1, zz: 2 }).success).toBe(false);
  });

  test('it composes with the other schema options rather than replacing them', () => {
    const documented = r.obj({ a: { type: r.num(), docs: 'the a' } });
    const schema = documented.toValueSchema({ unknownKeys: 'refuse', includeDocs: 'all' });
    expect(schema.safeParse({ a: 1, zz: 2 }).success).toBe(false);
    const shape = (schema as unknown as { shape: Record<string, { description?: string }> }).shape;
    expect(shape.a!.description).toBe('the a');
  });

  test('the WIRE side is not affected — a TypeDef key is refused either way', () => {
    // The value-side choice is per-boundary; the def-side refusal is not a
    // choice at all, and `unknownKeys` must not read as a way to soften it.
    expect(() => r.parse({ name: 'text', options: { values: ['a'] } })).toThrow();
  });
});
