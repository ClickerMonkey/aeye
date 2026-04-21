import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { NumType } from '../types/num';

describe('NumType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.num()).toBeInstanceOf(NumType);
    expect(r.num().name).toBe('num');
  });

  test('valid without options', () => {
    const t = r.num();
    expect(t.valid(0)).toBe(true);
    expect(t.valid(-5.5)).toBe(true);
    expect(t.valid(NaN)).toBe(false);
    expect(t.valid('1')).toBe(false);
  });

  test('valid respects min/max', () => {
    const t = r.num({ min: 0, max: 10 });
    expect(t.valid(5)).toBe(true);
    expect(t.valid(-1)).toBe(false);
    expect(t.valid(11)).toBe(false);
  });

  test('valid respects whole', () => {
    const t = r.num({ whole: true });
    expect(t.valid(3)).toBe(true);
    expect(t.valid(3.5)).toBe(false);
  });

  test('parse coerces string numbers', () => {
    expect(r.num().parse('42').raw).toBe(42);
    expect(() => r.num().parse('foo')).toThrow();
  });

  test('parse rejects out-of-range', () => {
    expect(() => r.num({ min: 0 }).parse(-1)).toThrow();
  });

  test('dump is identity', () => {
    expect(r.num().encode(7)).toBe(7);
  });

  test('create returns min or 0', () => {
    expect(r.num().create()).toBe(0);
    expect(r.num({ min: 5 }).create()).toBe(5);
  });

  test('random within bounds', () => {
    const rnd = (a: number, b: number, whole: boolean) => (whole ? Math.floor((a + b) / 2) : (a + b) / 2);
    const n = r.num({ min: 10, max: 20, whole: true }).random(rnd);
    expect(n).toBeGreaterThanOrEqual(10);
    expect(n).toBeLessThanOrEqual(20);
  });

  test('compatible across num instances', () => {
    expect(r.num().compatible(r.num())).toBe(true);
    expect(r.num().compatible(r.text())).toBe(false);
  });

  test('compatible with value-mode range subset', () => {
    const wide = r.num({ min: 0, max: 100 });
    const narrow = r.num({ min: 10, max: 90 });
    expect(wide.compatible(narrow, { value: true })).toBe(true);
    expect(narrow.compatible(wide, { value: true })).toBe(false);
  });

  test('or widens min/max', () => {
    const a = r.num({ min: 0, max: 10 });
    const b = r.num({ min: 5, max: 20 });
    const m = a.or(b) as NumType;
    expect(m.options.min).toBe(0);
    expect(m.options.max).toBe(20);
  });

  test('narrow rejects widening min/max', () => {
    expect(() => r.num({ min: 0 }).narrow({ min: -5 })).toThrow();
    expect(() => r.num({ max: 10 }).narrow({ max: 100 })).toThrow();
  });

  test('narrow accepts tightening', () => {
    const t = r.num({ min: 0, max: 100 });
    const o = t.narrow({ min: 10, max: 50 });
    expect(o.min).toBe(10);
    expect(o.max).toBe(50);
  });

  test('narrow rejects dropping whole', () => {
    expect(() => r.num({ whole: true }).narrow({ whole: false })).toThrow();
  });

  test('props include arithmetic + comparison + conversion', () => {
    const p = r.num().props();
    for (const n of ['add', 'sub', 'mul', 'div', 'eq', 'lt', 'gt', 'abs', 'floor', 'toText']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('get().loop is defined for iteration', () => {
    const g = r.num().get();
    expect(g).toBeDefined();
    expect(g!.loop).toBeDefined();
  });

  test('encode + parse roundtrip', () => {
    const t = r.num({ min: 0, max: 10, whole: true });
    const back = r.parse(t.toJSON()) as NumType;
    expect(back.options).toEqual({ min: 0, max: 10, whole: true });
  });

  test('describe picks whole for integers', () => {
    const t = r.num().describe!(7) as NumType;
    expect(t).toBeInstanceOf(NumType);
    expect(t.options.whole).toBe(true);
    const f = r.num().describe!(3.5) as NumType;
    expect(f.options.whole).toBe(false);
  });
});
