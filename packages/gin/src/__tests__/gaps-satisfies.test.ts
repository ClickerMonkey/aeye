import { describe, test, expect } from 'vitest';
import { createRegistry } from '../index';

describe('satisfies enforcement', () => {
  test('claimed interface not found → error', () => {
    const r = createRegistry();
    expect(() => r.parse({ name: 'num', satisfies: ['missing_iface'] })).toThrow(/unknown interface/);
  });

  test('structural mismatch → error', () => {
    const r = createRegistry();
    // Iface requires a property num never has.
    const iface = r.iface({
      props: { fictional: { type: { name: 'any' } } },
    });
    // Give it a lookup name by wrapping in a named Extension.
    const namedIface = r.extend(iface, { name: 'fictional_iface' });
    r.register(namedIface);
    expect(() => r.parse({ name: 'num', satisfies: ['fictional_iface'] })).toThrow(/does not structurally match/);
  });

  test('structurally satisfying types pass', () => {
    const r = createRegistry();
    // Any interface whose requirements num already meets (e.g., has eq).
    const iface = r.iface({
      props: {
        eq: { type: { name: 'fn', call: { args: { name: 'obj', props: { other: { type: { name: 'any' } } } }, returns: { name: 'bool' } } } },
      },
    });
    const named = r.extend(iface, { name: 'has_eq' });
    r.register(named);
    expect(() => r.parse({ name: 'num', satisfies: ['has_eq'] })).not.toThrow();
  });
});

describe('Registry.getTypesFor', () => {
  test('enumerates class defaults matching the interface', () => {
    const r = createRegistry();
    // Build an interface requiring a `toText` method.
    const iface = r.iface({
      props: {
        toText: { type: { name: 'fn', call: { args: { name: 'obj' }, returns: { name: 'text' } } } },
      },
    });
    const named = r.extend(iface, { name: 'has_toText' });
    r.register(named);
    const matches = r.getTypesFor('has_toText');
    // At minimum: bool, num, any, void, null, not — all declare toText.
    const names = matches.map((t) => t.name);
    expect(names).toContain('num');
    expect(names).toContain('bool');
  });

  test('returns empty for unknown interface', () => {
    const r = createRegistry();
    expect(r.getTypesFor('not_a_real_iface')).toEqual([]);
  });
});
