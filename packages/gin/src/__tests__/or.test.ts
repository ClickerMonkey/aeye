import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { OrType } from '../types/or';

describe('OrType', () => {
  const r = createRegistry();

  test('builder holds variants', () => {
    const t = r.or([r.num(), r.text()]) as OrType;
    expect(t).toBeInstanceOf(OrType);
    expect(t.variants).toHaveLength(2);
  });

  test('valid accepts if any variant matches', () => {
    const t = r.or([r.num(), r.text()]);
    expect(t.valid(5)).toBe(true);
    expect(t.valid('x')).toBe(true);
    expect(t.valid(true)).toBe(false);
  });

  test('parse tries variants in order', () => {
    const t = r.or([r.num(), r.text()]);
    expect(t.parse(5).raw).toBe(5);
    expect(t.parse('x').raw).toBe('x');
    expect(() => t.parse(true)).toThrow();
  });

  test('dump uses first matching variant', () => {
    const t = r.or([r.num(), r.text()]);
    expect(t.encode(5)).toBe(5);
    expect(t.encode('x')).toBe('x');
  });

  test('compatible: other assignable iff at least one variant accepts', () => {
    const t = r.or([r.num(), r.text()]);
    expect(t.compatible(r.num())).toBe(true);
    expect(t.compatible(r.text())).toBe(true);
    expect(t.compatible(r.bool())).toBe(false);
  });

  test('simplify: single-variant collapses', () => {
    const t = r.or([r.num()]) as OrType;
    expect(t.simplify().name).toBe('num');
  });

  test('props intersects variant names (TS A|B semantics)', () => {
    // both num and text expose `eq`, `neq`, and `toBool` — those survive
    const t = r.or([r.num(), r.text()]);
    const p = t.props();
    expect(p.eq).toBeDefined();
    expect(p.neq).toBeDefined();
    expect(p.toBool).toBeDefined();
    // `add` is num-only, `length` is text-only — both absent on Or<num|text>
    expect(p.add).toBeUndefined();
    expect(p.length).toBeUndefined();
  });

  test('or() merges variants', () => {
    const a = r.or([r.num(), r.text()]) as OrType;
    const b = r.or([r.bool()]) as OrType;
    const m = a.or(b) as OrType;
    expect(m.variants).toHaveLength(3);
  });

  test('encode + parse roundtrip', () => {
    const t = r.or([r.num(), r.text()]);
    const back = r.parse(t.toJSON()) as OrType;
    expect(back).toBeInstanceOf(OrType);
    expect(back.variants).toHaveLength(2);
  });
});
