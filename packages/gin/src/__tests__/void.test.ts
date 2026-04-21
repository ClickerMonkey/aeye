import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { VoidType } from '../types/void';

describe('VoidType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.void()).toBeInstanceOf(VoidType);
    expect(r.void().name).toBe('void');
  });

  test('valid only accepts undefined', () => {
    const t = r.void();
    expect(t.valid(undefined)).toBe(true);
    expect(t.valid(null)).toBe(false);
    expect(t.valid(0)).toBe(false);
    expect(t.valid('')).toBe(false);
  });

  test('parse accepts undefined/null, rejects others', () => {
    const t = r.void();
    expect(t.parse(undefined).raw).toBe(undefined);
    expect(t.parse(null).raw).toBe(undefined);
    expect(() => t.parse(0)).toThrow();
  });

  test('dump returns null', () => {
    expect(r.void().encode(undefined)).toBe(null);
  });

  test('create returns undefined', () => {
    expect(r.void().create()).toBe(undefined);
  });

  test('compatible only with void', () => {
    expect(r.void().compatible(r.void())).toBe(true);
    expect(r.void().compatible(r.num())).toBe(false);
  });

  test('narrow rejects options', () => {
    expect(() => r.void().narrow({ foo: 1 } as any)).toThrow();
  });

  test('encode + parse roundtrip', () => {
    const t = r.void();
    expect(t.toJSON()).toEqual({ name: 'void' });
    expect(r.parse({ name: 'void' })).toBeInstanceOf(VoidType);
  });

  test('props expose toText/toBoolean', () => {
    const p = r.void().props();
    expect(p.toText).toBeDefined();
    expect(p.toBoolean).toBeDefined();
  });
});
