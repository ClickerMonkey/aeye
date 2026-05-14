import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry } from '../registry';
import { ListType } from '../types/list';

describe('ListType', () => {
  const r = createRegistry();

  test('builder with item type', () => {
    const t = r.list(r.num());
    expect(t).toBeInstanceOf(ListType);
    expect(t.name).toBe('list');
    expect(t.item.name).toBe('num');
  });

  test('valid checks array + length + items', () => {
    const t = r.list(r.num(), { minLength: 1, maxLength: 3 });
    // raw is Value<V>[] now — valid() requires Values.
    expect(t.valid(t.parse([1, 2]).raw)).toBe(true);
    expect(t.valid([])).toBe(false);
    expect(t.valid([1, 'x'])).toBe(false);
    expect(t.valid('not array')).toBe(false);
  });

  test('parse maps items into Value<V>[] preserving element types', () => {
    const t = r.list(r.num());
    const v = t.parse([1, 2, 3]);
    expect(v.raw.length).toBe(3);
    expect(v.raw[0]!.raw).toBe(1);
    expect(v.raw[0]!.type.name).toBe('num');
    expect(primitives(v)).toEqual([1, 2, 3]);
  });

  test('parse rejects non-array', () => {
    expect(() => r.list(r.num()).parse('x')).toThrow();
  });

  test('encode wraps items as JSONValue envelopes', () => {
    const t = r.list(r.num());
    const v = t.parse([1, 2]);
    expect(t.encode(v.raw)).toEqual([
      { type: { name: 'num', options: undefined }, value: 1 },
      { type: { name: 'num', options: undefined }, value: 2 },
    ]);
  });

  test('create honors minLength with Value-wrapped defaults', () => {
    const t = r.list(r.num(), { minLength: 3 });
    const raw = t.create();
    expect(raw.length).toBe(3);
    expect(raw.every((v) => v.type.name === 'num' && v.raw === 0)).toBe(true);
  });

  test('compatible checks item + length', () => {
    expect(r.list(r.num()).compatible(r.list(r.num()))).toBe(true);
    expect(r.list(r.num()).compatible(r.list(r.text()))).toBe(false);
  });

  test('narrow rejects widening lengths', () => {
    expect(() => r.list(r.num(), { minLength: 5 }).narrow({ minLength: 1 })).toThrow();
    expect(() => r.list(r.num(), { maxLength: 10 }).narrow({ maxLength: 100 })).toThrow();
  });

  test('get exposes indexGet/indexSet/iterate', () => {
    const g = r.list(r.num()).get();
    expect(g).toBeDefined();
    expect(g!.key.name).toBe('num');
    expect(g!.value.name).toBe('num');
    expect(g!.get).toBeDefined();
    expect(g!.set).toBeDefined();
    expect(g!.loop).toBeDefined();
  });

  test('props include at/push/pop/map/filter/length/unique/duplicates/first/last', () => {
    const p = r.list(r.num()).props();
    for (const n of ['at', 'push', 'pop', 'map', 'filter', 'length', 'unique', 'duplicates', 'first', 'last', 'reduce', 'sort', 'slice']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('at method returns optional V', () => {
    const p = r.list(r.num()).props();
    expect(p.at?.type.name).toBe('fn');
  });

  test('encode + parse roundtrip', () => {
    const t = r.list(r.num(), { minLength: 0, maxLength: 10 });
    const back = r.parse(t.toJSON()) as ListType<number>;
    expect(back.item.name).toBe('num');
    expect(back.options.maxLength).toBe(10);
  });
});
