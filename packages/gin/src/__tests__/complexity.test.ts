import { describe, test, expect } from 'vitest';
import { createRegistry, LOOP_COMPLEXITY_PENALTY, LAMBDA_COMPLEXITY_BASE } from '../index';
import type { ExprDef } from '../index';

/**
 * Expr/Path complexity metric — gated by ginny's `finish` tool against
 * `GIN_MAX_COMPLEXITY` to push the model toward decomposition before a
 * single fn body grows past what's testable in one round.
 */

function parse(reg: ReturnType<typeof createRegistry>, def: ExprDef) {
  return reg.parseExpr(def);
}

describe('Expr.complexity() by kind', () => {
  const reg = createRegistry();

  test('NewExpr scalar literal → 1', () => {
    expect(parse(reg, { kind: 'new', type: { name: 'num' }, value: 5 }).complexity()).toBe(1);
  });

  test('GetExpr single prop step → 1', () => {
    expect(parse(reg, { kind: 'get', path: [{ prop: 'x' }] }).complexity()).toBe(1);
  });

  test('GetExpr with arg-bearing call step pays for args', () => {
    const e = parse(reg, {
      kind: 'get',
      path: [
        { prop: 'x' },
        { prop: 'add' },
        { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
      ],
    });
    // PropStep(x)=1 + PropStep(add)=1 + CallStep(1 + new=1)=2 → 4
    expect(e.complexity()).toBe(4);
  });

  test('SetExpr = path + value', () => {
    const e = parse(reg, {
      kind: 'set',
      path: [{ prop: 'x' }],
      value: { kind: 'new', type: { name: 'num' }, value: 5 },
    });
    expect(e.complexity()).toBe(2); // PropStep(1) + new(1)
  });

  test('BlockExpr 1 + sum(lines)', () => {
    const e = parse(reg, {
      kind: 'block',
      lines: [
        { kind: 'new', type: { name: 'num' }, value: 1 },
        { kind: 'new', type: { name: 'num' }, value: 2 },
        { kind: 'new', type: { name: 'num' }, value: 3 },
      ],
    });
    expect(e.complexity()).toBe(4); // 1 + 1+1+1
  });

  test('LoopExpr pays the flat LOOP_PENALTY plus body', () => {
    const e = parse(reg, {
      kind: 'loop',
      over: { kind: 'new', type: { name: 'num' }, value: 5 },
      body: { kind: 'new', type: { name: 'num' }, value: 0 },
    });
    // 1 + LOOP_PENALTY + over=1 + body=1
    expect(e.complexity()).toBe(1 + LOOP_COMPLEXITY_PENALTY + 1 + 1);
  });

  test('Nested loops add linearly, NOT geometrically', () => {
    // Critical regression guard — the prior multiplicative weighting
    // made 4-deep loops with simple bodies land at ~150*4^4 = 38000,
    // overshooting the cap on perfectly natural permutation/op-combo
    // patterns. Additive weighting keeps deep-but-shallow nesting
    // approximately linear in depth.
    const leaf = { kind: 'new', type: { name: 'num' }, value: 0 } as const;
    const inner = {
      kind: 'loop',
      over: { kind: 'new', type: { name: 'num' }, value: 5 },
      body: leaf,
    } as const;
    const outer = parse(reg, {
      kind: 'loop',
      over: { kind: 'new', type: { name: 'num' }, value: 5 },
      body: inner,
    });
    // inner: 1 + LOOP_PENALTY + over=1 + leaf=1 = 3 + LOOP_PENALTY
    // outer: 1 + LOOP_PENALTY + over=1 + inner
    const innerCost = 1 + LOOP_COMPLEXITY_PENALTY + 1 + 1;
    expect(outer.complexity()).toBe(1 + LOOP_COMPLEXITY_PENALTY + 1 + innerCost);
  });

  test('LambdaExpr pays the baseline plus body', () => {
    const e = parse(reg, {
      kind: 'lambda',
      type: {
        name: 'fn',
        call: {
          args: { name: 'obj', props: { n: { type: { name: 'num' } } } },
          returns: { name: 'num' },
        },
      },
      body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] },
    });
    // LAMBDA_BASE + body (PropStep + PropStep = 2)
    expect(e.complexity()).toBe(LAMBDA_COMPLEXITY_BASE + 2);
  });

  test('IfExpr pays per branch', () => {
    const e = parse(reg, {
      kind: 'if',
      ifs: [{
        condition: { kind: 'new', type: { name: 'bool' }, value: true },
        body: { kind: 'new', type: { name: 'num' }, value: 1 },
      }],
      else: { kind: 'new', type: { name: 'num' }, value: 0 },
    });
    expect(e.complexity()).toBe(1 + 1 + 1 + 1); // 1 base + cond + body + else
  });

  test('NativeExpr → 1 (opaque, ignores impl)', () => {
    // Use a native we know exists in the base registry — list.length is fine.
    const e = parse(reg, { kind: 'native', id: 'list.length' });
    expect(e.complexity()).toBe(1);
  });

  test('Helper discount — CallStep does NOT walk the called fn body', () => {
    // A CallStep with a 5-arg call costs 1 (the call) + sum(arg costs).
    // It does NOT walk into the body of whatever function the path
    // resolves to — that's the whole point: factoring work into a
    // helper genuinely reduces the caller's complexity.
    const heavyArgs: Record<string, ExprDef> = {};
    for (let i = 0; i < 5; i++) {
      heavyArgs[`a${i}`] = { kind: 'new', type: { name: 'num' }, value: i };
    }
    const e = parse(reg, {
      kind: 'get',
      path: [{ prop: 'someFn' }, { args: heavyArgs }],
    });
    // PropStep(1) + CallStep(1 + 5*1) → 7
    expect(e.complexity()).toBe(1 + 1 + 5);
  });

  test('Composite new list — element complexity sums', () => {
    const e = parse(reg, {
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'num' } } },
      value: [
        { kind: 'new', type: { name: 'num' }, value: 1 },
        { kind: 'new', type: { name: 'num' }, value: 2 },
        { kind: 'new', type: { name: 'num' }, value: 3 },
      ],
    });
    // list base (1) + 3 element news (3 × 1)
    expect(e.complexity()).toBe(4);
  });
});
