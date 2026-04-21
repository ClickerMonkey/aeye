import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { AnyType } from '../types/any';
import { Value } from '../value';

describe('AnyType', () => {
  const r = createRegistry();

  test('builder returns AnyType', () => {
    expect(r.any()).toBeInstanceOf(AnyType);
    expect(r.any().name).toBe('any');
  });

  test('valid accepts everything', () => {
    const t = r.any();
    expect(t.valid(0)).toBe(true);
    expect(t.valid('x')).toBe(true);
    expect(t.valid(null)).toBe(true);
    expect(t.valid(undefined)).toBe(true);
    expect(t.valid([])).toBe(true);
    expect(t.valid({})).toBe(true);
  });

  test('parse wraps anything', () => {
    const t = r.any();
    const v = t.parse({ foo: 1 });
    expect(v).toBeInstanceOf(Value);
    expect(v.raw).toEqual({ foo: 1 });
    expect(v.type).toBe(t);
  });

  test('dump is identity', () => {
    const t = r.any();
    expect(t.encode('x')).toBe('x');
    expect(t.encode(null)).toBe(null);
  });

  test('create returns null', () => {
    expect(r.any().create()).toBe(null);
  });

  test('random returns null', () => {
    expect(r.any().random(() => 0)).toBe(null);
  });

  test('compatible with everything', () => {
    const t = r.any();
    expect(t.compatible(r.num())).toBe(true);
    expect(t.compatible(r.text())).toBe(true);
    expect(t.compatible(r.list(r.bool()))).toBe(true);
  });

  test('flexible is true', () => {
    expect(r.any().flexible()).toBe(true);
  });

  test('narrow rejects any option', () => {
    expect(() => r.any().narrow({ foo: 1 } as any)).toThrow();
  });

  test('props expose typeOf/is/as/toText/toBoolean/eq/neq', () => {
    const p = r.any().props();
    for (const n of ['typeOf', 'is', 'as', 'toText', 'toBoolean', 'eq', 'neq']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode / parse roundtrip', () => {
    const t = r.any();
    const json = t.toJSON();
    expect(json).toEqual({ name: 'any' });
    expect(r.parse(json)).toBeInstanceOf(AnyType);
  });

  test('clone produces independent instance', () => {
    const t = r.any();
    const c = t.clone();
    expect(c).not.toBe(t);
    expect(c).toBeInstanceOf(AnyType);
  });
});
