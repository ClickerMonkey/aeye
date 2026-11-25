/**
 * `toA({ unknownKeys: 'refuse' })` (and `ginValue(type, { unknownKeys: 'refuse' })`) — refusing a key the type does
 * not declare, at boundaries where an undeclared key is a TYPO.
 *
 * The measured hole: a settings payload validated through a generated value
 * schema parsed CLEAN with its mis-spelt knob silently gone.
 *
 *   obj{type: text, charThreshold: num} value schema
 *     .safeParse({type:'graph', charThreshold:5000, bogus:1})
 *   → success, and `parse` keeps {type:'graph', charThreshold:5000}
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
import { LENIENT } from '@aeye/schema';
import { valueParser } from './_a';
import { createRegistry, Value } from '../index';

const r = createRegistry();

/** The measured config: one required text, one required num. */
const config = () => r.obj({ type: { type: r.text() }, charThreshold: { type: r.num() } });

describe('the default lets it through, and it matches the rest of the type system', () => {
  test('an undeclared key passes the schema and gin drops it — the behaviour that lost a knob', () => {
    const got = valueParser(config()).safeParse({ type: 'graph', charThreshold: 5000, bogus: 1 });
    expect(got.success).toBe(true);
    expect(config().parse(got.data).toLogical()).toEqual({ type: 'graph', charThreshold: 5000 });
  });

  test('a REQUIRED knob is never the victim — it fails as missing', () => {
    expect(valueParser(config()).safeParse({ type: 'graph' }).success).toBe(false);
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
    const got = valueParser(config(), { unknownKeys: 'refuse' })
      .safeParse({ type: 'graph', charThreshold: 5000, bogus: 1 });
    expect(got.success).toBe(false);
    expect(got.issues?.[0]).toMatchObject({ path: ['bogus'] });
    expect(got.issues?.[0]?.message).toContain('bogus');
  });

  test('a legitimate payload is untouched', () => {
    const got = valueParser(config(), { unknownKeys: 'refuse' })
      .safeParse({ type: 'graph', charThreshold: 5000 });
    expect(got.success).toBe(true);
    expect(got.data).toEqual({ type: 'graph', charThreshold: 5000 });
  });

  test('it reaches NESTED slots — one option, the whole payload', () => {
    const outer = r.obj({ inner: { type: config() }, items: { type: r.list(config()) } });
    const schema = valueParser(outer, { unknownKeys: 'refuse' });

    expect(schema.safeParse({
      inner: { type: 'g', charThreshold: 1, bogus: 1 },
      items: [],
    }).issues?.[0]).toMatchObject({ path: ['inner', 'bogus'] });

    expect(schema.safeParse({
      inner: { type: 'g', charThreshold: 1 },
      items: [{ type: 'g', charThreshold: 1, bogus: 1 }],
    }).issues?.[0]).toMatchObject({ path: ['items', 0, 'bogus'] });
  });

  test("a map's values are checked too", () => {
    // map<text, V> is a record in the code shape; map<num, V> is { key, value } pairs.
    const schema = valueParser(r.map(r.text(), config()), { unknownKeys: 'refuse' });
    expect(schema.safeParse({ k: { type: 'g', charThreshold: 1 } }).success).toBe(true);
    expect(schema.safeParse({ k: { type: 'g', charThreshold: 1, zz: 3 } }).issues?.[0])
      .toMatchObject({ path: ['k', 'zz'] });
    const pairs = valueParser(r.map(r.num(), r.num()), { unknownKeys: 'refuse' });
    expect(pairs.safeParse([{ key: 1, value: 1 }]).success).toBe(true);
    expect(pairs.safeParse([{ key: 1, value: 1, zz: 3 }]).issues?.[0])
      .toMatchObject({ path: [0, 'zz'] });
  });

  test("an Extension's local props are part of the declared set, not an extra", () => {
    const ext = r.extend(r.obj({ a: { type: r.num() } }), {
      name: 'Settings',
      props: { c: { type: r.text() } },
    });
    const schema = valueParser(ext, { unknownKeys: 'refuse' });
    expect(schema.safeParse({ a: 1, c: 'x' }).success).toBe(true);
    expect(schema.safeParse({ a: 1, c: 'x', zz: 2 }).issues?.[0])
      .toMatchObject({ path: ['zz'] });
  });

  test('an interface passes width through by DEFAULT and refuses when asked', () => {
    // An interface is a contract — a value carrying more still satisfies it,
    // which is why this one is passthrough rather than strip.
    const iface = r.iface({ props: { a: { type: r.num() } } });
    expect(valueParser(iface).safeParse({ a: 1, zz: 2 }).data).toEqual({ a: 1, zz: 2 });
    expect(valueParser(iface, { unknownKeys: 'refuse' }).safeParse({ a: 1, zz: 2 }).success).toBe(false);
  });

  test('it composes with the other schema options rather than replacing them', () => {
    const documented = r.obj({ a: { type: r.num(), docs: 'the a' } });
    const schema = valueParser(documented, { unknownKeys: 'refuse', includeDocs: 'all' });
    expect(schema.safeParse({ a: 1, zz: 2 }).success).toBe(false);
    const js = schema.bound.render(LENIENT).jsonSchema as { properties: Record<string, { description?: string }> };
    expect(js.properties.a!.description).toBe('the a');
  });

  test('the WIRE side is not affected — a TypeDef key is refused either way', () => {
    // The value-side choice is per-boundary; the def-side refusal is not a
    // choice at all, and `unknownKeys` must not read as a way to soften it.
    expect(() => r.parse({ name: 'text', options: { values: ['a'] } })).toThrow();
  });
});
