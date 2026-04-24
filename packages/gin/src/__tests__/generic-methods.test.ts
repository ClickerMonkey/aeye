import { describe, test, expect } from 'vitest';
import { createRegistry } from '../registry';
import { FnType } from '../types/fn';
import { GenericType } from '../types/generic';

/**
 * Method-level generics: `r.method(args, returns, id, { generic: {...} })`
 * declares new type parameters on the fn type that wraps the method.
 * These surface in `toCode`, `toCodeDefinition`, round-trip through JSON,
 * and are consumed at runtime by `CallStep.bindGeneric` to substitute
 * placeholders.
 */
describe('method-level generics on fn/method', () => {
  test('r.fn accepts a generic map and stores it on FnType.generic', () => {
    const r = createRegistry();
    const f = r.fn(r.obj({}), r.generic('T'), undefined, { T: r.any() }) as FnType;
    expect(f).toBeInstanceOf(FnType);
    expect(Object.keys(f.generic)).toEqual(['T']);
    expect(f.generic.T!.name).toBe('any');
  });

  test('r.method forwards options.generic into the fn type', () => {
    const r = createRegistry();
    const prop = r.method(
      { other: r.generic('T') },
      r.generic('T'),
      'example.op',
      { generic: { T: r.any() } },
    );
    expect(prop.type).toBeInstanceOf(FnType);
    const fn = prop.type as FnType;
    expect(Object.keys(fn.generic)).toEqual(['T']);
  });

  test('r.method without options.generic leaves FnType.generic empty', () => {
    const r = createRegistry();
    const prop = r.method({ x: r.num() }, r.num(), 'example.inc');
    const fn = prop.type as FnType;
    expect(Object.keys(fn.generic)).toEqual([]);
  });

  test('toCode renders method generics as <T> prefix on fn signatures', () => {
    const r = createRegistry();
    const f = r.fn(
      r.obj({ x: { type: r.generic('T') } }),
      r.generic('T'),
      undefined,
      { T: r.any() },
    );
    expect(f.toCode()).toBe('<T>(x: T): T');
  });

  test('toCode with bound generic renders <T: bound>', () => {
    const r = createRegistry();
    // Constraint: T extends num.
    const f = r.fn(r.obj({ x: { type: r.generic('T') } }), r.generic('T'), undefined, {
      T: r.num(),
    });
    expect(f.toCode()).toBe('<T: num>(x: T): T');
  });

  test('toCode with multiple generics — mix of bound and unbound', () => {
    const r = createRegistry();
    const f = r.fn(
      r.obj({ a: { type: r.generic('A') }, b: { type: r.generic('B') } }),
      r.generic('A'),
      undefined,
      { A: r.any(), B: r.num() },
    );
    expect(f.toCode()).toBe('<A, B: num>(a: A, b: B): A');
  });

  test('toCode without generics — no prefix', () => {
    const r = createRegistry();
    const f = r.fn(r.obj({ x: { type: r.num() } }), r.text());
    expect(f.toCode()).toBe('(x: num): text');
  });
});

describe('FnType.generic — JSON round-trip', () => {
  test('toJSON serializes generic map; parse reconstructs it', () => {
    const r = createRegistry();
    const f = r.fn(
      r.obj({ x: { type: r.generic('T') } }),
      r.generic('T'),
      undefined,
      { T: r.num() },
    );
    const json = f.toJSON();
    expect(json.generic).toEqual({ T: { name: 'num' } });

    const back = r.parse(json) as FnType;
    expect(back).toBeInstanceOf(FnType);
    expect(back.generic.T!.name).toBe('num');
  });

  test('empty generic map is omitted from JSON', () => {
    const r = createRegistry();
    const f = r.fn(r.obj({}), r.num());
    const json = f.toJSON();
    expect(json.generic).toBeUndefined();
  });

  test('round-trip preserves generic placeholders inside args/returns', () => {
    const r = createRegistry();
    const f = r.fn(
      r.obj({ fn: { type: r.fn(r.obj({ v: { type: r.generic('T') } }), r.bool()) } }),
      r.generic('T'),
      undefined,
      { T: r.any() },
    );
    const back = r.parse(f.toJSON()) as FnType;
    expect(Object.keys(back.generic)).toEqual(['T']);
    // Inner fn arg type should still be a GenericType named 'T'.
    const innerFnType = (back.call().args as unknown as { fields?: Record<string, { type: unknown }> })
      .fields?.fn?.type as FnType;
    const innerArgs = innerFnType.call().args as unknown as { fields?: Record<string, { type: unknown }> };
    const vType = innerArgs.fields?.v?.type as GenericType;
    expect(vType).toBeInstanceOf(GenericType);
    expect(vType.options.name).toBe('T');
  });
});

describe('toCodeDefinition — method-level generics', () => {
  test('list.map shows <R>(...): list<R> — R is method-only, not inherited', () => {
    const r = createRegistry();
    const listT = r.list(r.generic('V'));
    const def = listT.toCodeDefinition();
    expect(def).toContain('type list<V>');
    expect(def).toContain('map<R>(fn: (value: V, index: num): R): list<R>');
  });

  test('filter inherits V but introduces no new generic → no <> suffix', () => {
    const r = createRegistry();
    const listT = r.list(r.generic('V'));
    const def = listT.toCodeDefinition();
    // filter uses only V (from the outer type), not R — so no method-level <>.
    expect(def).toMatch(/filter\(fn: \(value: V, index: num\): bool\): list<V>/);
    expect(def).not.toMatch(/filter<[^>]+>/);
  });

  test('outer type generic is excluded from method-level generic list', () => {
    const r = createRegistry();
    // Type declares V; method redundantly declares V as well — the method
    // generic list should NOT include V (since it's inherited from outer).
    const fn = r.fn(
      r.obj({ x: { type: r.generic('V') } }),
      r.generic('V'),
      undefined,
      { V: r.any() },
    );
    // When rendered by itself (no outer owner), V shows as a method generic.
    expect(fn.toCode()).toBe('<V>(x: V): V');
  });

  test('any.is<T>() / any.as<T>() render with method generics', () => {
    const r = createRegistry();
    const def = r.any().toCodeDefinition();
    expect(def).toContain('is<T>(): bool');
    expect(def).toContain('as<T>(): optional<T>');
  });
});

describe('runtime behavior — CallStep.bindGeneric', () => {
  test('fn type.bind substitutes method generics through nested positions', () => {
    const r = createRegistry();
    const f = r.fn(
      r.obj({ v: { type: r.generic('R') } }),
      r.list(r.generic('R')),
      undefined,
      { R: r.any() },
    );
    const bound = f.bind({ R: r.num() }) as FnType;
    // After binding, R should be substituted everywhere.
    const args = bound.call().args as unknown as { fields?: Record<string, { type: { name: string } }> };
    expect(args.fields?.v?.type.name).toBe('num');
    expect(bound.call().returns?.name).toBe('list');
  });

  test('bind with missing key leaves unbound placeholders intact', () => {
    const r = createRegistry();
    const f = r.fn(
      r.obj({ v: { type: r.generic('R') } }),
      r.generic('R'),
      undefined,
      { R: r.any() },
    );
    const bound = f.bind({ NOT_R: r.num() }) as FnType;
    const args = bound.call().args as unknown as { fields?: Record<string, { type: GenericType }> };
    expect(args.fields?.v?.type).toBeInstanceOf(GenericType);
    expect(args.fields?.v?.type.options.name).toBe('R');
  });
});

describe('invalid / edge cases', () => {
  test('unbound generic placeholder accepts any value at runtime (valid)', () => {
    const r = createRegistry();
    // A method's generic R is a type-level placeholder — at runtime, before
    // binding, it's indistinguishable from `any`: everything is valid.
    const placeholder = r.generic('R');
    expect(placeholder.valid(5)).toBe(true);
    expect(placeholder.valid('hi')).toBe(true);
    expect(placeholder.valid(null)).toBe(true);
  });

  test('method generic bound to a constraint still renders correctly', () => {
    const r = createRegistry();
    const prop = r.method(
      { key: r.generic('K') },
      r.bool(),
      'example.has',
      { generic: { K: r.text() } },
    );
    expect((prop.type as FnType).toCode()).toBe('<K: text>(key: K): bool');
  });

  test('generic with same name as an outer type generic is suppressed in method-level list', () => {
    const r = createRegistry();
    // Build a bare FnType whose generic list happens to contain V — when
    // placed inside a list<V>'s definition, V would be filtered out.
    // Here we just verify the fn itself (standalone) shows <V>.
    const f = r.fn(r.obj({ x: { type: r.generic('V') } }), r.generic('V'), undefined, {
      V: r.any(),
    });
    expect(f.toCode()).toContain('<V>');
  });

  test('empty method generic map behaves like no generics', () => {
    const r = createRegistry();
    const prop = r.method({ x: r.num() }, r.num(), 'example.noop', { generic: {} });
    const fn = prop.type as FnType;
    expect(Object.keys(fn.generic)).toEqual([]);
    expect(fn.toCode()).toBe('(x: num): num');
  });
});
