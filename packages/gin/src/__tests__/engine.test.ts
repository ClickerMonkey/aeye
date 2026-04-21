import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, createEngine } from '../index';
import { val } from '../value';

describe('Engine', () => {
  test('createEngine wraps a registry', () => {
    const r = createRegistry();
    const e = createEngine(r);
    expect(e).toBeInstanceOf(Engine);
    expect(e.registry).toBe(r);
  });

  test('parse requires an ExprDef-shaped object', () => {
    const e = new Engine(createRegistry());
    expect(() => e.parse(null)).toThrow();
    expect(() => e.parse({})).toThrow();
    expect(e.parse({ kind: 'new', type: { name: 'any' } })).toBeDefined();
  });

  test('createRootScope seeds globals', () => {
    const e = new Engine(createRegistry());
    e.registerGlobal('PI', { type: e.registry.num(), value: 3.14 });
    const s = e.createRootScope();
    expect(s.get('PI')?.raw).toBe(3.14);
  });

  test('createRootScope accepts extras', () => {
    const e = new Engine(createRegistry());
    const s = e.createRootScope({ x: val(e.registry.num(), 42) });
    expect(s.get('x')?.raw).toBe(42);
  });

  test('run dispatches by kind (end-to-end)', async () => {
    const e = new Engine(createRegistry());
    const result = await e.run({ kind: 'new', type: { name: 'num' }, value: 7 });
    expect(result.raw).toBe(7);
    expect(result.type.name).toBe('num');
  });

  test('run catches exit signal and returns its value', async () => {
    const e = new Engine(createRegistry());
    const result = await e.run({
      kind: 'block',
      lines: [
        { kind: 'flow', action: 'exit', value: { kind: 'new', type: { name: 'num' }, value: 99 } },
        { kind: 'new', type: { name: 'num' }, value: 0 },
      ],
    });
    expect(result.raw).toBe(99);
  });
});
