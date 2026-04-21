import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { LiteralType } from '../types/literal';

describe('LiteralType', () => {
  const r = createRegistry();

  test('builder with inner type + value', () => {
    const t = r.literal(r.text(), 'hello') as LiteralType<string>;
    expect(t).toBeInstanceOf(LiteralType);
    expect(t.inner.name).toBe('text');
    expect(t.literal).toBe('hello');
  });

  test('valid accepts only the literal value', () => {
    const t = r.literal(r.text(), 'hello');
    expect(t.valid('hello')).toBe(true);
    expect(t.valid('world')).toBe(false);
    expect(t.valid(5)).toBe(false);
  });

  test('parse only accepts exact match', () => {
    const t = r.literal(r.num(), 42);
    expect(t.parse(42).raw).toBe(42);
    expect(() => t.parse(43)).toThrow();
  });

  test('dump delegates to inner', () => {
    expect(r.literal(r.text(), 'hi').encode('hi')).toBe('hi');
  });

  test('create returns the literal', () => {
    expect(r.literal(r.num(), 7).create()).toBe(7);
  });

  test('random returns the literal', () => {
    expect(r.literal(r.num(), 7).random(() => 0)).toBe(7);
  });

  test('compatible: same literal passes, different fails', () => {
    const a = r.literal(r.text(), 'x');
    const b = r.literal(r.text(), 'x');
    const c = r.literal(r.text(), 'y');
    expect(a.compatible(b)).toBe(true);
    expect(a.compatible(c)).toBe(false);
  });

  test('compatible: in non-exact mode, accepts inner', () => {
    const lit = r.literal(r.text(), 'x');
    expect(lit.compatible(r.text())).toBe(true);
    expect(lit.compatible(r.text(), { exact: true })).toBe(false);
  });

  test('narrow rejects value change', () => {
    const t = r.literal(r.num(), 5);
    expect(() => t.narrow({ value: 6 })).toThrow();
  });

  test('props are inherited from inner', () => {
    const t = r.literal(r.num(), 5);
    const p = t.props();
    expect(p.add).toBeDefined();
    expect(p.eq).toBeDefined();
  });

  test('encode + parse roundtrip', () => {
    const t = r.literal(r.text(), 'hello');
    const back = r.parse(t.toJSON()) as LiteralType<string>;
    expect(back).toBeInstanceOf(LiteralType);
    expect(back.literal).toBe('hello');
    expect(back.inner.name).toBe('text');
  });
});
