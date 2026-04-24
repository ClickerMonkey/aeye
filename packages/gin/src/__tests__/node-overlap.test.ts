import { describe, test, expect } from 'vitest';
import { createRegistry, Engine, Expr } from '../index';
import { Type } from '../type';
import type { Node } from '../node';

/**
 * Type and Expr both implement the Node interface:
 *   toCode(registry?)  — TS-like rendering
 *   toJSON()           — JSON shape (TypeDef / ExprDef)
 *   validate(engine)   — collects Problems
 *   clone()            — deep copy
 * Downstream tooling can treat the two uniformly.
 */

describe('Node interface uniformity', () => {
  test('Type instances satisfy Node', () => {
    const r = createRegistry();
    const nodes: Node[] = [r.num(), r.text(), r.list(r.num())];
    for (const n of nodes) {
      expect(typeof n.toCode).toBe('function');
      expect(typeof n.toJSON).toBe('function');
      expect(typeof n.validate).toBe('function');
      expect(typeof n.clone).toBe('function');
    }
  });

  test('Expr instances satisfy Node', () => {
    const r = createRegistry();
    const exprs: Node[] = [
      r.parseExpr({ kind: 'new', type: { name: 'num' }, value: 42 }),
      r.parseExpr({ kind: 'get', path: [{ prop: 'x' }] }),
    ];
    for (const n of exprs) {
      expect(typeof n.toCode).toBe('function');
      expect(typeof n.toJSON).toBe('function');
      expect(typeof n.validate).toBe('function');
      expect(typeof n.clone).toBe('function');
    }
  });

  test('Both support validate(engine) returning Problems', () => {
    const r = createRegistry();
    const e = new Engine(r);

    const t = r.list(r.num());
    expect(t.validate(e).hasErrors).toBe(false);

    const okExpr = r.parseExpr({ kind: 'new', type: { name: 'num' }, value: 7 });
    expect(okExpr.validate(e).hasErrors).toBe(false);

    // A bad expr — unknown variable — surfaces a problem via validate(engine).
    const bad = r.parseExpr({ kind: 'get', path: [{ prop: 'doesNotExist' }] });
    const probs = bad.validate(e);
    expect(probs.list.some((x) => x.code === 'var.unknown')).toBe(true);
  });

  test('toJSON round-trips: registry.parse ∘ toCode symmetry', () => {
    const r = createRegistry();
    const e = new Engine(r);

    // Type round-trip.
    const t = r.obj({ a: { type: r.num() }, b: { type: r.text() } });
    expect(r.parse(t.toJSON()).toCode()).toBe(t.toCode());

    // Expr round-trip.
    const x = r.parseExpr({ kind: 'new', type: { name: 'num' }, value: 42 });
    expect(r.parseExpr(x.toJSON()).toCode(r)).toBe(x.toCode(r));
    expect(e.toCode(x.toJSON())).toBe(e.toCode(x));
  });

  test('clone returns a deep copy that serializes identically', () => {
    const r = createRegistry();

    const t = r.list(r.num());
    expect(t.clone().toJSON()).toEqual(t.toJSON());

    const x = r.parseExpr({
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: { kind: 'new', type: { name: 'num' }, value: 1 },
      }],
      else: { kind: 'new', type: { name: 'num' }, value: 2 },
    });
    expect((x.clone() as Expr).toJSON()).toEqual(x.toJSON());
  });
});

describe('Type and Expr render to TypeScript uniformly', () => {
  test('toCode produces readable text for either', () => {
    const r = createRegistry();
    const e = new Engine(r);

    const nodes: { node: Node; expected: string }[] = [
      { node: r.num(),                           expected: 'num' },
      { node: r.list(r.text()),                  expected: 'list<text>' },
      { node: r.obj({ x: { type: r.num() } }),   expected: 'obj{x: num}' },
      { node: r.parseExpr({ kind: 'new', type: { name: 'num' }, value: 5 }),             expected: '5' },
      { node: r.parseExpr({ kind: 'get', path: [{ prop: 'arr' }, { key: { kind: 'new', type: { name: 'num' }, value: 0 } }] }), expected: 'arr[0]' },
    ];

    for (const { node, expected } of nodes) {
      expect(node.toCode(r)).toBe(expected);
    }
  });
});
