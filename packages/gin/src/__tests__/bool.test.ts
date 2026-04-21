import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { BoolType } from '../types/bool';

describe('BoolType', () => {
  const r = createRegistry();

  test('builder and name', () => {
    expect(r.bool()).toBeInstanceOf(BoolType);
    expect(r.bool().name).toBe('bool');
  });

  test('valid accepts booleans', () => {
    expect(r.bool().valid(true)).toBe(true);
    expect(r.bool().valid(false)).toBe(true);
    expect(r.bool().valid(1)).toBe(false);
    expect(r.bool().valid('true')).toBe(false);
  });

  test('parse raw booleans', () => {
    expect(r.bool().parse(true).raw).toBe(true);
    expect(r.bool().parse(false).raw).toBe(false);
    expect(() => r.bool().parse('yes')).toThrow();
  });

  test('parse with text aliases', () => {
    const t = r.bool({ trueText: 'yes', falseText: 'no' });
    expect(t.parse('yes').raw).toBe(true);
    expect(t.parse('no').raw).toBe(false);
  });

  test('create returns false', () => {
    expect(r.bool().create()).toBe(false);
  });

  test('compatible only with bool', () => {
    expect(r.bool().compatible(r.bool())).toBe(true);
    expect(r.bool().compatible(r.num())).toBe(false);
  });

  test('or merges aliases', () => {
    const a = r.bool({ trueText: 'yes' });
    const b = r.bool({ falseText: 'no' });
    const m = a.or(b) as BoolType;
    expect(m.options.trueText).toBe('yes');
    expect(m.options.falseText).toBe('no');
  });

  test('narrow allows alias replacement', () => {
    const t = r.bool({ trueText: 'yes' });
    const o = t.narrow({ trueText: 'y' });
    expect(o.trueText).toBe('y');
  });

  test('props include and/or/not/xor/eq/toText/toNumber', () => {
    const p = r.bool().props();
    for (const n of ['and', 'or', 'not', 'xor', 'eq', 'neq', 'toText', 'toNumber']) {
      expect(p[n]).toBeDefined();
    }
  });

  test('encode + parse roundtrip preserves options', () => {
    const t = r.bool({ trueText: 'y', falseText: 'n' });
    const back = r.parse(t.toJSON()) as BoolType;
    expect(back.options.trueText).toBe('y');
    expect(back.options.falseText).toBe('n');
  });

  test('describe infers bool from booleans', () => {
    expect(r.bool().describe?.(true)).toBeInstanceOf(BoolType);
    expect(r.bool().describe?.('x')).toBeUndefined();
  });
});
