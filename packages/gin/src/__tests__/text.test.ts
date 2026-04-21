import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { TextType } from '../types/text';

describe('TextType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.text()).toBeInstanceOf(TextType);
    expect(r.text().name).toBe('text');
  });

  test('valid accepts strings', () => {
    expect(r.text().valid('')).toBe(true);
    expect(r.text().valid('abc')).toBe(true);
    expect(r.text().valid(42)).toBe(false);
  });

  test('valid respects length bounds', () => {
    const t = r.text({ minLength: 2, maxLength: 5 });
    expect(t.valid('ab')).toBe(true);
    expect(t.valid('a')).toBe(false);
    expect(t.valid('abcdef')).toBe(false);
  });

  test('valid respects regex pattern', () => {
    const t = r.text({ pattern: '^[a-z]+$' });
    expect(t.valid('abc')).toBe(true);
    expect(t.valid('ABC')).toBe(false);
    expect(t.valid('a1')).toBe(false);
  });

  test('parse validates constraints', () => {
    const t = r.text({ minLength: 3 });
    expect(t.parse('abc').raw).toBe('abc');
    expect(() => t.parse('ab')).toThrow();
    expect(() => t.parse(42)).toThrow();
  });

  test('create returns empty string', () => {
    expect(r.text().create()).toBe('');
  });

  test('random respects length', () => {
    const rnd = (a: number, b: number, whole: boolean) => (whole ? 3 : (a + b) / 2);
    const s = r.text({ minLength: 3, maxLength: 3 }).random(rnd);
    expect(s).toHaveLength(3);
  });

  test('compatible same class', () => {
    expect(r.text().compatible(r.text())).toBe(true);
    expect(r.text().compatible(r.num())).toBe(false);
  });

  test('narrow rejects widening length', () => {
    expect(() => r.text({ minLength: 5 }).narrow({ minLength: 1 })).toThrow();
    expect(() => r.text({ maxLength: 10 }).narrow({ maxLength: 100 })).toThrow();
  });

  test('narrow rejects different pattern', () => {
    expect(() => r.text({ pattern: '^a' }).narrow({ pattern: '^b' })).toThrow();
  });

  test('get() enables char indexing + loop', () => {
    const g = r.text().get();
    expect(g).toBeDefined();
    expect(g!.key.name).toBe('num');
    expect(g!.value.name).toBe('text');
    expect(g!.loop).toBeDefined();
  });

  test('props include length/contains/slice/upper/toNumber', () => {
    const p = r.text().props();
    for (const n of ['length', 'contains', 'slice', 'upper', 'lower', 'toNumber', 'split']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip', () => {
    const t = r.text({ minLength: 1, maxLength: 10, pattern: '\\w+', flags: 'i' });
    const back = r.parse(t.toJSON()) as TextType;
    expect(back.options.minLength).toBe(1);
    expect(back.options.pattern).toBe('\\w+');
  });

  test('describe picks text for strings', () => {
    expect(r.text().describe!('hi')).toBeInstanceOf(TextType);
    expect(r.text().describe!(1)).toBeUndefined();
  });
});
