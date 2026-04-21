import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { EnumType } from '../types/enum';

describe('EnumType', () => {
  const r = createRegistry();

  test('builder with values and inner type', () => {
    const t = r.enum({ RED: 'red', BLUE: 'blue' }, r.text()) as EnumType<string>;
    expect(t).toBeInstanceOf(EnumType);
    expect(t.value.name).toBe('text');
    expect(t.options.values).toEqual({ RED: 'red', BLUE: 'blue' });
  });

  test('valid requires membership', () => {
    const t = r.enum({ A: 1, B: 2 }, r.num());
    expect(t.valid(1)).toBe(true);
    expect(t.valid(2)).toBe(true);
    expect(t.valid(3)).toBe(false);
  });

  test('parse validates membership', () => {
    const t = r.enum({ A: 'a', B: 'b' }, r.text());
    expect(t.parse('a').raw).toBe('a');
    expect(() => t.parse('c')).toThrow();
  });

  test('create returns first value', () => {
    const t = r.enum({ A: 'a', B: 'b' }, r.text());
    expect(t.create()).toBe('a');
  });

  test('random picks a member', () => {
    const t = r.enum({ A: 'a', B: 'b' }, r.text());
    const picked = t.random((_a, _b, _w) => 0);
    expect(['a', 'b']).toContain(picked);
  });

  test('compatible checks inner + membership subset', () => {
    const a = r.enum({ A: 'a', B: 'b', C: 'c' }, r.text());
    const b = r.enum({ A: 'a' }, r.text());
    expect(a.compatible(b, { value: true })).toBe(true);
    expect(b.compatible(a, { value: true })).toBe(false);
  });

  test('narrow rejects widening values', () => {
    const t = r.enum({ A: 'a', B: 'b' }, r.text());
    expect(() => t.narrow({ values: { A: 'a', X: 'x' } })).toThrow();
    // narrower subset is OK
    const narrowed = t.narrow({ values: { A: 'a' } });
    expect(narrowed.values).toEqual({ A: 'a' });
  });

  test('props include name/value/eq/toText', () => {
    const p = r.enum({ A: 'a' }, r.text()).props();
    for (const n of ['name', 'value', 'eq', 'neq', 'toText']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip', () => {
    const t = r.enum({ RED: 'red', BLUE: 'blue' }, r.text());
    const back = r.parse(t.toJSON()) as EnumType;
    expect(back).toBeInstanceOf(EnumType);
    expect(back.options.values).toEqual({ RED: 'red', BLUE: 'blue' });
  });
});
