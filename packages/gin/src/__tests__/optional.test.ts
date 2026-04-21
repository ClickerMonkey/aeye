import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { OptionalType } from '../types/optional';

describe('OptionalType', () => {
  const r = createRegistry();

  test('builder wraps inner', () => {
    const t = r.optional(r.num()) as OptionalType<number>;
    expect(t).toBeInstanceOf(OptionalType);
    expect(t.inner.name).toBe('num');
  });

  test('valid accepts undefined + inner values', () => {
    const t = r.optional(r.num());
    expect(t.valid(undefined)).toBe(true);
    expect(t.valid(5)).toBe(true);
    expect(t.valid('x')).toBe(false);
  });

  test('parse accepts undefined/null or inner', () => {
    const t = r.optional(r.num());
    expect(t.parse(undefined).raw).toBe(undefined);
    expect(t.parse(null).raw).toBe(undefined);
    expect(t.parse(3).raw).toBe(3);
  });

  test('dump maps undefined to null', () => {
    const t = r.optional(r.num());
    expect(t.encode(undefined)).toBe(null);
    expect(t.encode(5)).toBe(5);
  });

  test('create returns undefined', () => {
    expect(r.optional(r.num()).create()).toBe(undefined);
  });

  test('compatible delegates to inner for non-optional', () => {
    expect(r.optional(r.num()).compatible(r.num())).toBe(true);
    expect(r.optional(r.num()).compatible(r.text())).toBe(false);
  });

  test('exact requires optional wrapping', () => {
    expect(r.optional(r.num()).compatible(r.num(), { exact: true })).toBe(false);
    expect(r.optional(r.num()).compatible(r.optional(r.num()), { exact: true })).toBe(true);
  });

  test('required() unwraps inner', () => {
    expect(r.optional(r.num()).required().name).toBe('num');
  });

  test('props are overlay: value/has/or/map only', () => {
    const p = r.optional(r.num()).props();
    expect(Object.keys(p).sort()).toEqual(['has', 'map', 'or', 'value']);
  });

  test('encode + parse roundtrip', () => {
    const t = r.optional(r.num());
    const back = r.parse(t.toJSON()) as OptionalType<number>;
    expect(back).toBeInstanceOf(OptionalType);
    expect(back.inner.name).toBe('num');
  });
});
