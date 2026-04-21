import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { NullType } from '../types/null';

describe('NullType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.null()).toBeInstanceOf(NullType);
    expect(r.null().name).toBe('null');
  });

  test('valid only accepts null', () => {
    const t = r.null();
    expect(t.valid(null)).toBe(true);
    expect(t.valid(undefined)).toBe(false);
    expect(t.valid(0)).toBe(false);
    expect(t.valid('')).toBe(false);
  });

  test('parse accepts null, rejects others', () => {
    const t = r.null();
    expect(t.parse(null).raw).toBe(null);
    expect(() => t.parse(0)).toThrow();
    expect(() => t.parse(undefined)).toThrow();
  });

  test('create / dump', () => {
    expect(r.null().create()).toBe(null);
    expect(r.null().encode(null)).toBe(null);
  });

  test('compatible only with null', () => {
    expect(r.null().compatible(r.null())).toBe(true);
    expect(r.null().compatible(r.void())).toBe(false);
  });

  test('narrow rejects options', () => {
    expect(() => r.null().narrow({ x: 1 } as any)).toThrow();
  });

  test('encode + parse roundtrip', () => {
    expect(r.null().toJSON()).toEqual({ name: 'null' });
    expect(r.parse({ name: 'null' })).toBeInstanceOf(NullType);
  });
});
