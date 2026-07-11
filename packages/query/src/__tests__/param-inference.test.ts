import { describe, it, expect } from 'vitest';
import { fixture, typeScope, lit, ref, cmp, param } from './_utils';
import type { ExprDef } from '../schema';

const fx = fixture();

describe('contextual param-type inference', () => {
  it('infers a number param from comparison against a number field', () => {
    const scope = typeScope(fx);
    const def = cmp('=', ref('u', 'id'), param('p'));
    const problems = fx.engine.validateExpr(def, scope);
    expect(problems.hasErrors).toBe(false);
    expect(scope.params.resolved('p')?.resolve()).toBe('number');
    expect(scope.params.toJSON()).toEqual([{ name: 'p', type: { kind: 'number', whole: true } }]);
  });

  it('unifies consistent uses of the same param', () => {
    const scope = typeScope(fx);
    const def: ExprDef = {
      kind: 'logical',
      op: 'and',
      operands: [cmp('=', ref('u', 'id'), param('p')), cmp('>', ref('u', 'id'), param('p'))],
    };
    const problems = fx.engine.validateExpr(def, scope);
    expect(problems.hasErrors).toBe(false);
    expect(scope.params.resolved('p')?.resolve()).toBe('number');
  });

  it('reports param.conflict naming both conflicting paths', () => {
    const scope = typeScope(fx);
    const def: ExprDef = {
      kind: 'logical',
      op: 'and',
      operands: [
        cmp('=', ref('u', 'id'), param('p')), // number
        cmp('=', ref('u', 'name'), param('p')), // text
      ],
    };
    const problems = fx.engine.validateExpr(def, scope);
    const conflict = problems.list.find((x) => x.code === 'param.conflict');
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('operands.0.right');
    expect(conflict?.message).toContain('operands.1.right');
    expect(scope.params.resolved('p')).toBeUndefined();
  });

  it('reports param.untyped for a never-observed param', () => {
    const scope = typeScope(fx);
    const problems = fx.engine.validateExpr(param('lonely'), scope);
    expect(problems.list.some((x) => x.code === 'param.untyped')).toBe(true);
    expect(scope.params.resolved('lonely')).toBeUndefined();
  });

  it('infers a param from a between bound and an in list', () => {
    const scope = typeScope(fx);
    const between: ExprDef = { kind: 'between', value: ref('u', 'id'), lower: param('lo'), upper: lit(100) };
    fx.engine.validateExpr(between, scope);
    expect(scope.params.resolved('lo')?.resolve()).toBe('number');

    const scope2 = typeScope(fx);
    const inExpr: ExprDef = { kind: 'in', value: ref('u', 'name'), in: [param('n1'), lit('x')] };
    fx.engine.validateExpr(inExpr, scope2);
    expect(scope2.params.resolved('n1')?.resolve()).toBe('text');
  });
});
