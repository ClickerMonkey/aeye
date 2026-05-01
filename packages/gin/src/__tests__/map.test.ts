import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry } from '../registry';
import { MapType } from '../types/map';

describe('MapType', () => {
  const r = createRegistry();

  test('builder with key/value types', () => {
    const t = r.map(r.text(), r.num());
    expect(t).toBeInstanceOf(MapType);
    expect(t.key.name).toBe('text');
    expect(t.value.name).toBe('num');
  });

  test('valid requires ES Map with [Value<K>, Value<V>] entries', () => {
    const t = r.map(r.text(), r.num());
    expect(t.valid(t.parse([['a', 1]]).raw)).toBe(true);
    expect(t.valid(new Map([['a', 1]]))).toBe(false); // raw primitives not allowed
    expect(t.valid({})).toBe(false);
    expect(t.valid([])).toBe(false);
  });

  test('parse from entry array preserves key/value Values', () => {
    const t = r.map(r.text(), r.num());
    const v = t.parse([['a', 1], ['b', 2]]);
    const entryA = v.raw.get('a')!;
    expect(entryA[0]!.type.name).toBe('text');
    expect(entryA[0]!.raw).toBe('a');
    expect(entryA[1]!.type.name).toBe('num');
    expect(entryA[1]!.raw).toBe(1);
    expect(primitives(v)).toEqual([['a', 1], ['b', 2]]);
  });

  test('encode produces {key, value} entries with JSONValue envelopes', () => {
    const t = r.map(r.text(), r.num());
    const v = t.parse([['a', 1]]);
    expect(t.encode(v.raw)).toEqual([{
      key: { type: { name: 'text', options: undefined }, value: 'a' },
      value: { type: { name: 'num', options: undefined }, value: 1 },
    }]);
  });

  test('create returns empty Map', () => {
    const t = r.map(r.text(), r.num());
    expect(t.create()).toBeInstanceOf(Map);
    expect(t.create().size).toBe(0);
  });

  test('compatible checks key + value', () => {
    expect(r.map(r.text(), r.num()).compatible(r.map(r.text(), r.num()))).toBe(true);
    expect(r.map(r.text(), r.num()).compatible(r.map(r.text(), r.bool()))).toBe(false);
  });

  test('get exposes indexGet/indexSet/iterate', () => {
    const g = r.map(r.text(), r.num()).get();
    expect(g).toBeDefined();
    expect(g!.key.name).toBe('text');
    expect(g!.value.name).toBe('num');
    expect(g!.loop).toBeDefined();
  });

  test('props include size/at/has/delete/clear/keys/values', () => {
    const p = r.map(r.text(), r.num()).props();
    for (const n of ['size', 'at', 'has', 'delete', 'clear', 'keys', 'values', 'isEmpty']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('at method returns optional V', () => {
    const p = r.map(r.text(), r.num()).props();
    expect(p.at?.type.name).toBe('fn');
  });

  test('encode + parse roundtrip', () => {
    const t = r.map(r.text(), r.num());
    const back = r.parse(t.toJSON()) as MapType;
    expect(back.key.name).toBe('text');
    expect(back.value.name).toBe('num');
  });
});
