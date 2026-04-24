import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { NullableType } from '../types/nullable';

describe('NullableType', () => {
  const r = createRegistry();

  test('builder wraps inner', () => {
    const t = r.nullable(r.num()) as NullableType<number>;
    expect(t).toBeInstanceOf(NullableType);
    expect(t.inner.name).toBe('num');
  });

  test('valid accepts null + inner values', () => {
    const t = r.nullable(r.num());
    expect(t.valid(null)).toBe(true);
    expect(t.valid(5)).toBe(true);
    expect(t.valid(undefined)).toBe(false);
  });

  test('parse accepts null or inner', () => {
    const t = r.nullable(r.num());
    expect(t.parse(null).raw).toBe(null);
    expect(t.parse(3).raw).toBe(3);
  });

  test('dump maps null to null', () => {
    const t = r.nullable(r.num());
    expect(t.encode(null)).toBe(null);
    expect(t.encode(5)).toBe(5);
  });

  test('create returns null', () => {
    expect(r.nullable(r.num()).create()).toBe(null);
  });

  test('required() unwraps inner', () => {
    expect(r.nullable(r.num()).required().name).toBe('num');
  });

  test('props overlay: value/isNull/or/map', () => {
    const p = r.nullable(r.num()).props();
    expect(Object.keys(p).sort()).toEqual(['isNull', 'map', 'or', 'toAny', 'value']);
  });

  test('encode + parse roundtrip', () => {
    const t = r.nullable(r.text());
    const back = r.parse(t.toJSON()) as NullableType;
    expect(back).toBeInstanceOf(NullableType);
    expect(back.inner.name).toBe('text');
  });
});
