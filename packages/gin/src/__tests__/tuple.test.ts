import { describe, test, expect } from 'vitest';
import { primitives } from './_utils';
import { createRegistry } from '../registry';
import { TupleType } from '../types/tuple';

describe('TupleType', () => {
  const r = createRegistry();

  test('builder with positional elements', () => {
    const t = r.tuple([r.text(), r.num(), r.bool()]);
    expect(t).toBeInstanceOf(TupleType);
    expect((t as unknown as TupleType).elements).toHaveLength(3);
  });

  test('valid checks length + positional types (raw is Value[])', () => {
    const t = r.tuple([r.text(), r.num()]) as unknown as TupleType;
    expect(t.valid(t.parse(['a', 1]).raw)).toBe(true);
    expect(t.valid(['a'])).toBe(false);
    expect(t.valid(['a', 1, 2])).toBe(false);
  });

  test('parse each element by position into Value[]', () => {
    const t = r.tuple([r.text(), r.num()]) as unknown as TupleType;
    const v = t.parse(['a', 1]);
    expect(v.raw[0]!.type.name).toBe('text');
    expect(v.raw[0]!.raw).toBe('a');
    expect(v.raw[1]!.type.name).toBe('num');
    expect(v.raw[1]!.raw).toBe(1);
    expect(primitives(v)).toEqual(['a', 1]);
  });

  test('parse rejects wrong length', () => {
    const t = r.tuple([r.text(), r.num()]) as unknown as TupleType;
    expect(() => t.parse(['a'])).toThrow();
  });

  test('create produces Value-wrapped defaults per position', () => {
    const t = r.tuple([r.text(), r.num(), r.bool()]) as unknown as TupleType;
    const raw = t.create();
    expect(raw.map((v) => v.raw)).toEqual(['', 0, false]);
    expect(t.encode(raw)).toEqual([
      { type: { name: 'text', options: undefined }, value: '' },
      { type: { name: 'num', options: undefined }, value: 0 },
      { type: { name: 'bool', options: undefined }, value: false },
    ]);
  });

  test('compatible positionally', () => {
    const a = r.tuple([r.text(), r.num()]) as unknown as TupleType;
    const b = r.tuple([r.text(), r.num()]) as unknown as TupleType;
    expect(a.compatible(b)).toBe(true);
    const c = r.tuple([r.num(), r.text()]) as unknown as TupleType;
    expect(a.compatible(c)).toBe(false);
  });

  test('get exposes dynamic index access', () => {
    const t = r.tuple([r.text(), r.num()]) as unknown as TupleType;
    const g = t.get();
    expect(g).toBeDefined();
    expect(g!.loop).toBeDefined();
  });

  test('props include length/first/last/toList', () => {
    const t = r.tuple([r.text(), r.num(), r.bool()]) as unknown as TupleType;
    const p = t.props();
    for (const n of ['length', 'first', 'last', 'toList']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip', () => {
    const t = r.tuple([r.text(), r.num()]) as unknown as TupleType;
    const back = r.parse(t.toJSON()) as TupleType;
    expect(back.elements).toHaveLength(2);
    expect(back.elements[0]?.name).toBe('text');
    expect(back.elements[1]?.name).toBe('num');
  });
});
