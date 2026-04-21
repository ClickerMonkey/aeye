import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { RefType } from '../types/ref';
import { NumType } from '../types/num';

describe('RefType', () => {
  const r = createRegistry();

  test('builder stores the name', () => {
    const t = r.ref('num') as RefType;
    expect(t).toBeInstanceOf(RefType);
    expect(t.options.name).toBe('num');
  });

  test('resolves via registry for built-in', () => {
    const t = r.ref('num');
    expect(t.valid(5)).toBe(true);
    expect(t.valid('x')).toBe(false);
  });

  test('resolves a registered named type', () => {
    const reg = createRegistry();
    const custom = reg.extend('num', { name: 'myNum', options: { min: 0 } });
    reg.register(custom);
    const ref = reg.ref('myNum');
    expect(ref.valid(5)).toBe(true);
    expect(ref.valid(-1)).toBe(false);
  });

  test('unresolved ref throws on use', () => {
    expect(() => r.ref('does-not-exist').valid(1)).toThrow();
  });

  test('flexible is true', () => {
    expect(r.ref('num').flexible()).toBe(true);
  });

  test('props delegate to resolved target', () => {
    const t = r.ref('num');
    const p = t.props();
    expect(p.add).toBeDefined();
  });

  test('simplify returns the resolved target', () => {
    expect(r.ref('num').simplify()).toBeInstanceOf(NumType);
  });

  test('encode + parse roundtrip', () => {
    const t = r.ref('num');
    const back = r.parse(t.toJSON()) as RefType;
    expect(back).toBeInstanceOf(RefType);
    expect(back.options.name).toBe('num');
  });
});
