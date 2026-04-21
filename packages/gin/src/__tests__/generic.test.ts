import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { GenericType } from '../types/generic';
import { NumType } from '../types/num';

describe('GenericType', () => {
  const r = createRegistry();

  test('builder stores the param name', () => {
    const g = r.generic('V') as GenericType;
    expect(g).toBeInstanceOf(GenericType);
    expect(g.options.name).toBe('V');
  });

  test('valid accepts anything before binding', () => {
    const g = r.generic('V');
    expect(g.valid(5)).toBe(true);
    expect(g.valid('x')).toBe(true);
  });

  test('compatible is true before binding', () => {
    expect(r.generic('V').compatible(r.num())).toBe(true);
  });

  test('flexible is true', () => {
    expect(r.generic('V').flexible()).toBe(true);
  });

  test('bind resolves against matching name', () => {
    const g = r.generic('V');
    const bound = g.bind({ V: r.num() });
    expect(bound).toBeInstanceOf(NumType);
  });

  test('bind keeps self when no matching binding', () => {
    const g = r.generic('V');
    const bound = g.bind({ X: r.num() });
    expect(bound).toBeInstanceOf(GenericType);
  });

  test('bind substitutes through a list type', () => {
    const listGeneric = r.list(r.generic('V'));
    const bound = listGeneric.bind({ V: r.num() });
    // after binding, the list's item should be num
    expect((bound as any).item?.name).toBe('num');
  });

  test('encode + parse roundtrip', () => {
    const t = r.generic('T');
    const back = r.parse(t.toJSON()) as GenericType;
    expect(back).toBeInstanceOf(GenericType);
    expect(back.options.name).toBe('T');
  });
});
