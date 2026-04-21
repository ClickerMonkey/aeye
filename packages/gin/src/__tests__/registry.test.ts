import { describe, test, expect } from 'vitest';
import { createRegistry, Registry, BUILTIN_TYPES } from '../registry';
import { NumType } from '../types/num';
import { Extension } from '../extension';

describe('Registry', () => {
  test('createRegistry registers all built-ins', () => {
    const r = createRegistry();
    for (const cls of BUILTIN_TYPES) {
      expect(r.lookup(cls.NAME)).toBeDefined();
    }
  });

  test('parse dispatches by name for built-in', () => {
    const r = createRegistry();
    const t = r.parse({ name: 'num', options: { min: 0 } });
    expect(t).toBeInstanceOf(NumType);
    expect((t as NumType).options.min).toBe(0);
  });

  test('parse resolves extends via lookup', () => {
    const r = createRegistry();
    const t = r.parse({ name: 'temperature', extends: 'num', options: { min: -273.15 } });
    expect(t).toBeInstanceOf(Extension);
  });

  test('parse throws for unknown name', () => {
    const r = createRegistry();
    expect(() => r.parse({ name: 'unknown-type' })).toThrow();
  });

  test('parse throws for extends of unknown base', () => {
    const r = createRegistry();
    expect(() => r.parse({ name: 'x', extends: 'does-not-exist' })).toThrow();
  });

  test('register + lookup roundtrip', () => {
    const r = createRegistry();
    const custom = r.extend('num', { name: 'pct', options: { min: 0, max: 100 } });
    r.register(custom);
    expect(r.lookup('pct')).toBe(custom);
  });

  test('parse resolves named type', () => {
    const r = createRegistry();
    const pct = r.extend('num', { name: 'pct', options: { min: 0, max: 100 } });
    r.register(pct);
    expect(r.parse({ name: 'pct' })).toBe(pct);
  });

  test('setNative / getNative roundtrip', () => {
    const r = new Registry();
    const impl = (() => null) as any;
    r.setNative('foo.bar', impl);
    expect(r.getNative('foo.bar')).toBe(impl);
  });

  test('prop helper builds field spec', () => {
    const r = createRegistry();
    const p = r.prop(r.num(), 'x.field');
    expect(p.type.name).toBe('num');
    expect((p.get as any).id).toBe('x.field');
  });

  test('method helper builds fn-typed prop', () => {
    const r = createRegistry();
    const p = r.method({ other: r.num() }, r.bool(), 'x.method');
    expect(p.type.name).toBe('function');
    expect((p.get as any).id).toBe('x.method');
  });

  test('parse handles nested types recursively', () => {
    const r = createRegistry();
    const t = r.parse({
      name: 'list',
      generic: { V: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } } },
    });
    expect(t.name).toBe('list');
  });

  test('empty Registry (no builtins) rejects parse', () => {
    const r = new Registry();
    expect(() => r.parse({ name: 'num' })).toThrow();
  });
});
