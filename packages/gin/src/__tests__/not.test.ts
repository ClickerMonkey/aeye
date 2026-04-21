import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { NotType } from '../types/not';

describe('NotType', () => {
  const r = createRegistry();

  test('builder with excluded', () => {
    const t = r.not(r.num()) as NotType;
    expect(t).toBeInstanceOf(NotType);
    expect(t.excluded.name).toBe('num');
  });

  test('valid rejects values matching excluded', () => {
    const t = r.not(r.num());
    expect(t.valid('abc')).toBe(true);
    expect(t.valid(null)).toBe(true);
    expect(t.valid(5)).toBe(false);
  });

  test('parse throws on excluded value', () => {
    const t = r.not(r.num());
    expect(() => t.parse(5)).toThrow();
    expect(t.parse('x').raw).toBe('x');
  });

  test('flexible is true', () => {
    expect(r.not(r.num()).flexible()).toBe(true);
  });

  test('compatible rejects structurally excluded types', () => {
    const t = r.not(r.num());
    expect(t.compatible(r.text())).toBe(true);
    expect(t.compatible(r.num())).toBe(false);
  });

  test('encode + parse roundtrip', () => {
    const t = r.not(r.num()) as NotType;
    const back = r.parse(t.toJSON()) as NotType;
    expect(back).toBeInstanceOf(NotType);
    expect(back.excluded.name).toBe('num');
  });
});
