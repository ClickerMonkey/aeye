import { describe, test, expect } from 'vitest';
import { valueParser } from './_a';
import { createRegistry, type Type } from '../index';

/**
 * What leaves gin as JSON is plain JSON: a type definition (`toJSON`) has no
 * key holding `undefined`, and an encoded value (`encodeLogical`, `encode`,
 * `toJSON`) leaves an absent optional field out instead of writing `null`,
 * so it passes the type's own value schema and parses back to the same value.
 */
const r = createRegistry();

/** Every path in `value` whose value is `undefined`. */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path];
  if (Array.isArray(value)) return value.flatMap((item, i) => undefinedPaths(item, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => undefinedPaths(item, `${path}.${key}`));
}

describe('type definitions are plain JSON', () => {
  const Base = r.obj({ id: r.text() });
  const cases: Record<string, Type> = {
    text: r.text(),
    'text with options': r.text({ minLength: 1 }),
    num: r.num(),
    bool: r.bool(),
    date: r.date(),
    timestamp: r.timestamp(),
    color: r.color(),
    list: r.list(r.num()),
    'obj with optional and documented fields': r.obj({
      a: r.text(),
      b: r.optional(r.num()),
      c: r.field(r.text(), { docs: 'a documented field' }),
    }),
    fn: r.fn({ args: r.obj({ path: r.text() }), returns: r.list(r.text()) }),
    'fn without returns': r.fn({ args: r.obj({}) }),
    'generic fn': r.fn({ generic: { T: r.any() }, args: r.obj({ x: r.alias('T') }), returns: r.alias('T') }),
    iface: r.iface({ props: { name: r.text() } }),
    extension: r.extend(Base, { name: 'Customer', props: { email: r.text(), note: r.optional(r.text()) } }),
    'extension with docs': r.extend(r.text({ pattern: '@' }), { name: 'Email', docs: 'An email address.' }),
  };

  for (const [name, type] of Object.entries(cases)) {
    test(`${name}: no undefined keys, and the definition round-trips`, () => {
      const def = type.toJSON();
      expect(undefinedPaths(def)).toEqual([]);
      expect(JSON.parse(JSON.stringify(def))).toEqual(def);
      expect(r.parse(def).toJSON()).toEqual(def);
    });
  }
});

describe('encoded values leave absent optional fields out', () => {
  const T = r.obj({ a: r.text(), b: r.optional(r.num()), when: r.optional(r.timestamp()) });

  test('encodeLogical omits the absent field and passes the value schema', () => {
    const encoded = T.parse({ a: 'x' }).encodeLogical();
    expect(encoded).toEqual({ a: 'x' });
    expect(Object.keys(encoded as object)).toEqual(['a']);
    expect(valueParser(T).safeParse(encoded).success).toBe(true);
  });

  test('a present optional field is kept, and the encoding parses back to the same value', () => {
    const when = new Date('2026-01-02T03:04:05.000Z');
    const value = T.parse({ a: 'x', b: 2, when });
    const encoded = value.encodeLogical();
    expect(encoded).toEqual({ a: 'x', b: 2, when: when.toISOString() });
    expect(valueParser(T).safeParse(encoded).success).toBe(true);
    expect(T.parse(encoded).toLogical()).toEqual({ a: 'x', b: 2, when });
  });

  test('the envelope forms leave the absent field out too and still round-trip', () => {
    const value = T.parse({ a: 'x' });
    expect(Object.keys(value.encode() as object)).toEqual(['a']);
    const back = r.parseValue(JSON.parse(JSON.stringify(value.toJSON())));
    expect(back.toLogical()).toEqual({ a: 'x', b: undefined, when: undefined });
  });

  test('nested objects and lists of objects omit absent fields at every depth', () => {
    const Outer = r.obj({ items: r.list(T), inner: r.optional(T) });
    const encoded = Outer.parse({ items: [{ a: 'x' }, { a: 'y', b: 1 }] }).encodeLogical();
    expect(encoded).toEqual({ items: [{ a: 'x' }, { a: 'y', b: 1 }] });
    expect(valueParser(Outer).safeParse(encoded).success).toBe(true);
  });

  test('an Extension\'s own optional stored prop is left out when absent', () => {
    const Customer = r.extend(r.obj({ id: r.text() }), { name: 'PlainCustomer', props: { note: r.optional(r.text()) } });
    const encoded = Customer.parse({ id: '1' }).encodeLogical();
    expect(encoded).toEqual({ id: '1' });
    expect(valueParser(Customer).safeParse(encoded).success).toBe(true);
  });
});
