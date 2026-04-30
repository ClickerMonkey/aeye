import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { AliasType } from '../types/alias';
import { LocalScope } from '../type-scope';

/**
 * Generic-parameter behavior under the unified AliasType + scope-based
 * resolution. A bare `r.alias('V')` resolves through its captured
 * scope; an extra TypeScope can be passed at access time to override
 * the captured layer (this is how call-site `<R: num>` bindings reach
 * AliasTypes inside a fn signature without rebuilding the type tree).
 * No `Type.bind` / `substitute` API any more.
 */
describe('AliasType (generic flavor)', () => {
  const r = createRegistry();

  test('builder stores the param name', () => {
    const g = r.alias('V') as AliasType;
    expect(g).toBeInstanceOf(AliasType);
    expect(g.options.name).toBe('V');
  });

  test('valid accepts anything before binding', () => {
    const g = r.alias('V');
    expect(g.valid(5)).toBe(true);
    expect(g.valid('x')).toBe(true);
  });

  test('compatible is true before binding', () => {
    expect(r.alias('V').compatible(r.num())).toBe(true);
  });

  test('flexible is true', () => {
    expect(r.alias('V').flexible()).toBe(true);
  });

  test('extra-scope resolution: V → num via passed scope', () => {
    // The captured scope (registry root) doesn't know V. But when we
    // pass an extra LocalScope binding V to num, the AliasType's
    // value-side ops delegate to num.
    const g = r.alias('V');
    const local = new LocalScope(r, { V: r.num() });
    expect(g.valid(5, local)).toBe(true);
    expect(g.valid('x', local)).toBe(false);     // num rejects strings
    expect(g.simplify(local).name).toBe('num');  // collapses to the bound type
  });

  test('extra-scope without matching name is a no-op', () => {
    const g = r.alias('V');
    const local = new LocalScope(r, { X: r.num() });
    expect(g.simplify(local)).toBe(g);            // unresolved → self
  });

  test('list<V> resolves V via extra scope on parse', () => {
    // The list type contains AliasType('V') captured at registry root.
    // Parsing a list of 5s should validate when V is bound to num.
    const list = r.list(r.alias('V'));
    const local = new LocalScope(r, { V: r.num() });
    const v = list.parse([1, 2, 3], local);
    expect(v.raw.length).toBe(3);
    expect(v.raw[0]!.type.name).toBe('alias');    // alias preserved
    expect((v.raw[0]!.type as AliasType).simplify(local).name).toBe('num');
  });

  test('encode + parse roundtrip', () => {
    const t = r.alias('T');
    const json = t.toJSON();
    expect(json).toEqual({ name: 'T' });
    // Bare-name 'T' is unknown to the root registry — re-parsed in
    // root scope it stays an AliasType (forward-ref / placeholder).
    const back = r.parse(json) as AliasType;
    expect(back).toBeInstanceOf(AliasType);
    expect(back.options.name).toBe('T');
  });
});
