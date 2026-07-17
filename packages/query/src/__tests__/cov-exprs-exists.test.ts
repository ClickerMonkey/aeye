/**
 * Coverage-focused tests for `ExistsExpr` — `[NOT] EXISTS (subquery)`. Exercises
 * every public method: parse guards, schema, resolve (definite bool), validate,
 * cost (inner scan), the correlated runtime 3VL, both SQL dialects, and the
 * JSON / clone / code round-trips.
 */
import { describe, it, expect } from 'vitest';
import { cctx, fixture, typeScope, runtimeFixture, ref, cmp, lit } from './_utils';
import { asFieldType } from '../resolved-type';
import { ExistsExpr } from '../exprs/exists';
import type { ExprDef, QueryDef, SelectDef } from '../schema';

const fx = fixture();

/**
 * A subquery of `order` rows correlated to the outer `user` (its buyer). The
 * correlation JOINS the `order.userId` relation (as `u`) and compares the joined
 * key `u.id` to the outer `user.id` — the CORRECT pattern (comparing the relation
 * field-ref `order.userId` to the scalar `user.id` is a `compare.relation-vs-value`).
 */
const ordersOfUser: QueryDef = {
  kind: 'select',
  fields: [{ expr: ref('order', 'id') }],
  from: { kind: 'type', type: 'order' },
  joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'u' } }],
  where: [cmp('=', ref('u', 'id'), ref('user', 'id'))],
};

/** A SELECT of `user.id` filtered by an `[NOT] EXISTS` predicate (ordered). */
function whereUsers(where: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('user', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'user' },
    where: [where],
    order: [{ expr: ref('user', 'id'), dir: 'asc' }],
  };
}

describe('ExistsExpr', () => {
  it('static from throws on a mismatched kind; toSchema parses an exists def', () => {
    expect(() => ExistsExpr.from(lit(1), fx.registry)).toThrow();
    expect(ExistsExpr.toSchema({}).safeParse({ kind: 'exists', query: { kind: 'expr', expr: lit(1) } }).success).toBe(true);
  });

  it('resolves to a definite (non-nullable) boolean', () => {
    const e = fx.engine.parse({ kind: 'exists', query: ordersOfUser });
    const rt = e.resolve(fx.engine, typeScope(fx));
    expect(asFieldType(rt)?.resolve()).toBe('bool');
    if (rt.kind === 'computed') expect(rt.nullable).toBe(false);
  });

  it('validateWalk validates the correlated inner query and resolves to bool', () => {
    // Bind the OUTER `user` source the subquery correlates to (its `user.id`).
    const scope = fx.engine.globalScope();
    scope.bind('user', { kind: 'type', type: fx.user, source: 'user', synthetic: false });
    const p = fx.engine.validateExpr({ kind: 'exists', query: ordersOfUser }, scope);
    expect(p.hasErrors).toBe(false);
  });

  it('surfaces a BAD ref INSIDE the correlated subquery (the relation-vs-scalar bug)', () => {
    const scope = fx.engine.globalScope();
    scope.bind('user', { kind: 'type', type: fx.user, source: 'user', synthetic: false });
    // The classic correlation bug: comparing the RELATION `order.userId` to the
    // scalar `user.id` — now caught inside the subquery (was silent before).
    const bad: QueryDef = {
      kind: 'select',
      fields: [{ expr: ref('order', 'id') }],
      from: { kind: 'type', type: 'order' },
      where: [cmp('=', ref('order', 'userId'), ref('user', 'id'))],
    };
    const p = fx.engine.validateExpr({ kind: 'exists', query: bad }, scope);
    const rel = p.list.find((x) => x.code === 'compare.relation-vs-value');
    expect(rel).toBeDefined();
    // Nested under the exists `query` path.
    expect(rel!.path).toContain('query');
  });

  it('cost is the inner subquery scan cost', () => {
    const e = fx.engine.parse({ kind: 'exists', query: ordersOfUser });
    expect(e.cost(cctx(fx.engine), typeScope(fx)).rows).toBeGreaterThan(0);
  });

  it('evaluates (correlated) under EXISTS and NOT EXISTS', async () => {
    const rt = runtimeFixture();
    // Ada(1) & Bob(2) have orders; Cleo(3) has none.
    const yes = await rt.engine.run(whereUsers({ kind: 'exists', query: ordersOfUser }));
    expect(yes.rows).toEqual([{ id: 1 }, { id: 2 }]);
    const no = await rt.engine.run(whereUsers({ kind: 'exists', query: ordersOfUser, not: true }));
    expect(no.rows).toEqual([{ id: 3 }]);
  });

  it('emits [NOT] EXISTS (subquery) in both dialects', () => {
    const pos = fx.engine.toSQL(whereUsers({ kind: 'exists', query: ordersOfUser }), 'base').sql;
    expect(pos).toContain('EXISTS (');
    expect(pos).not.toContain('NOT EXISTS');
    const neg = fx.engine.toSQL(whereUsers({ kind: 'exists', query: ordersOfUser, not: true }), 'postgres').sql;
    expect(neg).toContain('NOT EXISTS (');
  });

  it('round-trips through toJSON / clone / toCode (with and without NOT)', () => {
    const plain = fx.engine.parse({ kind: 'exists', query: ordersOfUser });
    expect(plain.toJSON()).toEqual({ kind: 'exists', query: ordersOfUser });
    expect(plain.toCode()).toBe('EXISTS (subquery)');
    expect(plain.clone().toJSON()).toEqual(plain.toJSON());

    const negated = fx.engine.parse({ kind: 'exists', query: ordersOfUser, not: true });
    expect(negated.toJSON()).toEqual({ kind: 'exists', query: ordersOfUser, not: true });
    expect(negated.toCode()).toBe('NOT EXISTS (subquery)');
    const cloned = negated.clone();
    expect(cloned.toJSON()).toEqual(negated.toJSON());
  });
});
