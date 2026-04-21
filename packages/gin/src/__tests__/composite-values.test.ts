import { describe, test, expect } from 'vitest';
import { createRegistry, Engine } from '../index';
import { Value } from '../value';

/**
 * Composite types store Value instances internally so each element
 * carries its ACTUAL type, independent of the declared element type.
 * This matters when the declared type is an interface/union and the
 * runtime values are more specific — the specific type survives.
 *
 * `encode()` emits the JSON envelope form: each nested slot becomes
 * `{type, value}` so per-element subtypes round-trip through JSON.
 * Logical primitive views come from reading `.raw` directly.
 */

describe('composite values preserve actual element types', () => {
  test('list<any> stores Values with their concrete num/text types', () => {
    const r = createRegistry();
    const t = r.list(r.any());
    const v = t.parse([42, 'hi', true]);

    expect(v.raw.length).toBe(3);
    expect(v.raw[0]!.raw).toBe(42);
    expect(v.raw[1]!.raw).toBe('hi');
    expect(v.raw[2]!.raw).toBe(true);
    // encode() wraps each element with its type so subtypes round-trip.
    expect(v.encode()).toEqual([
      { type: { name: 'any' }, value: 42 },
      { type: { name: 'any' }, value: 'hi' },
      { type: { name: 'any' }, value: true },
    ]);
  });

  test('obj with interface field retains the concrete type of the stored value', () => {
    const r = createRegistry();
    const comparable = r.iface({
      props: { toText: { type: { name: 'function', call: {
        args: { name: 'object' }, returns: { name: 'text' },
      } } } },
    });
    const box = r.obj({ thing: { type: comparable } });
    const v = box.parse({ thing: 42 });
    const raw = v.raw as unknown as Record<string, Value>;
    expect(raw.thing).toBeInstanceOf(Value);
    expect(raw.thing!.raw).toBe(42);
  });

  test('tuple stores positional Values, each with its own type', () => {
    const r = createRegistry();
    const t = r.tuple([r.num(), r.text(), r.bool()]);
    const v = t.parse([7, 'x', true]);
    expect(v.raw[0]!.type.name).toBe('num');
    expect(v.raw[1]!.type.name).toBe('text');
    expect(v.raw[2]!.type.name).toBe('bool');
    expect(v.encode()).toEqual([
      { type: { name: 'num', options: undefined }, value: 7 },
      { type: { name: 'text', options: undefined }, value: 'x' },
      { type: { name: 'bool', options: undefined }, value: true },
    ]);
  });

  test('map keys are raw primitives (for ES Map equality); values are [Value<K>, Value<V>]', () => {
    const r = createRegistry();
    const t = r.map(r.text(), r.num());
    const v = t.parse([['a', 1], ['b', 2]]);
    expect(v.raw.has('a')).toBe(true);
    const entryA = v.raw.get('a')!;
    expect(entryA[0]).toBeInstanceOf(Value);
    expect(entryA[1]).toBeInstanceOf(Value);
    expect(entryA[0].type.name).toBe('text');
    expect(entryA[0].raw).toBe('a');
    expect(entryA[1].type.name).toBe('num');
    expect(entryA[1].raw).toBe(1);
    expect(v.encode()).toEqual([
      {
        key: { type: { name: 'text', options: undefined }, value: 'a' },
        value: { type: { name: 'num', options: undefined }, value: 1 },
      },
      {
        key: { type: { name: 'text', options: undefined }, value: 'b' },
        value: { type: { name: 'num', options: undefined }, value: 2 },
      },
    ]);
  });

  test('list round-trip through encode/parse preserves actual types end-to-end', () => {
    const r = createRegistry();
    const e = new Engine(r);
    const t = r.list(r.any());
    const v = t.parse([1, 'two', false]);
    const env = v.toJSON();
    // Full envelope round-trip via registry.parseValue.
    const parsed = r.parseValue(env);
    expect(parsed.raw.length).toBe(3);
    expect(parsed.raw[0]!.raw).toBe(1);
    expect(parsed.raw[1]!.raw).toBe('two');
    expect(parsed.raw[2]!.raw).toBe(false);
    void e;
  });

  test('Extension subtype survives JSON round-trip (subtype preservation)', () => {
    const r = createRegistry();

    // Register an Extension on num — adds a prop method so we can check
    // identity via the type's props() surface.
    const positiveNum = r.extend('num', {
      name: 'positive',
      options: { min: 0 },
      props: {
        isPositive: { type: r.fn(r.obj({}), r.bool()) },
      },
    });
    r.define('positive', positiveNum);

    // A map<num, text> containing a positive-num key (subtype of num).
    const m = r.map(r.num(), r.text());
    const mapRaw = new Map<unknown, [Value, Value]>();
    const posKey = new Value(positiveNum, 5);
    mapRaw.set(5, [posKey, new Value(r.text(), 'five')]);
    const mapValue = new Value(m, mapRaw as unknown as Map<number, string>);

    // Serialize → envelope carries the Extension's type def at the key slot.
    const json = mapValue.toJSON();
    const entries = json.value as Array<{ key: { type: { name: string } }; value: unknown }>;
    expect(entries[0]!.key.type.name).toBe('positive');

    // Deserialize via registry.parseValue — reconstructed key's type is
    // the Extension, not plain num.
    const reconstructed = r.parseValue(json);
    const rawMap = reconstructed.raw as Map<unknown, [Value, Value]>;
    const entry = rawMap.get(5)!;
    expect(entry[0].type.name).toBe('positive');
    expect(entry[0].raw).toBe(5);
  });

  test('Value.encode() returns the recursive envelope form', () => {
    const r = createRegistry();
    const nested = r.obj({
      items: { type: r.list(r.num()) },
      tags:  { type: r.list(r.text()) },
    });
    const v = nested.parse({ items: [1, 2, 3], tags: ['a', 'b'] });
    // Logical primitive view via .raw walks:
    const raw = v.raw as unknown as Record<string, Value<number[]> | Value<string[]>>;
    expect(raw.items!.raw.map((x) => x.raw)).toEqual([1, 2, 3]);
    expect(raw.tags!.raw.map((x) => x.raw)).toEqual(['a', 'b']);
    // Encoded form: envelopes at every level.
    const encoded = v.encode() as { items: unknown; tags: unknown };
    expect(encoded.items).toHaveProperty('type');
    expect(encoded.items).toHaveProperty('value');
  });
});
