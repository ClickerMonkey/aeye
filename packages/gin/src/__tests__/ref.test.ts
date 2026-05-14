import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { AliasType } from '../types/alias';
import { NumType } from '../types/num';

/**
 * Reference-style aliases: `r.alias(name)` produces a lazy bare-name
 * reference. Resolution walks `scope.lookup`, hitting the registered
 * named type or built-in class. Replaces the former dedicated `RefType`.
 */
describe('AliasType (reference flavor)', () => {
  const r = createRegistry();

  test('builder stores the name', () => {
    const t = r.alias('num') as AliasType;
    expect(t).toBeInstanceOf(AliasType);
    expect(t.options.name).toBe('num');
  });

  test('resolves via registry for built-in', () => {
    const t = r.alias('num');
    expect(t.valid(5)).toBe(true);
    expect(t.valid('x')).toBe(false);
  });

  test('resolves a registered named type', () => {
    const reg = createRegistry();
    const custom = reg.extend('num', { name: 'myNum', options: { min: 0 } });
    reg.register(custom);
    const ref = reg.alias('myNum');
    expect(ref.valid(5)).toBe(true);
    expect(ref.valid(-1)).toBe(false);
  });

  test('unresolved alias is permissive (placeholder semantics)', () => {
    // Forward-ref / unresolved name acts as an unbound placeholder:
    // permissive valid/compatible, no props. Once the name registers,
    // the alias starts delegating.
    const t = r.alias('does-not-exist');
    expect(t.valid(1)).toBe(true);
  });

  test('flexible is true', () => {
    expect(r.alias('num').flexible()).toBe(true);
  });

  test('props delegate to resolved target', () => {
    const t = r.alias('num');
    const p = t.props();
    expect(p.add).toBeDefined();
  });

  test('simplify returns the resolved target', () => {
    expect(r.alias('num').simplify()).toBeInstanceOf(NumType);
  });

  test('encode + parse roundtrip', () => {
    const t = r.alias('num');
    const json = t.toJSON();
    expect(json).toEqual({ name: 'num' });
    // Re-parsing the bare-name form returns the canonical class
    // instance directly (since 'num' is a built-in class), not an
    // AliasType wrapper. Structural equality is preserved.
    const back = r.parse(json);
    expect(back.name).toBe('num');
    expect(back.valid(5)).toBe(true);
  });
});
