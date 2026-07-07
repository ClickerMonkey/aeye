/**
 * Top-level condition clauses (WHERE / HAVING / a join's `and` / DML WHERE)
 * must resolve to a boolean — the `condition.non-bool` check, consistent with
 * how `logical` operands and `case` `when` clauses are already required to be
 * boolean. A bare `param` predicate is EXEMPT (its type is inferred).
 */
import { describe, it, expect } from 'vitest';
import { fixture, ref, lit, cmp, param } from './_utils';
import type { Problems } from '../problem';
import type { SelectDef, UpdateDef, DeleteDef, ExprDef } from '../schema';

const fx = fixture();

/** Every `condition.non-bool` problem raised for a query def. */
function condProblems(def: SelectDef | UpdateDef | DeleteDef): Problems['list'] {
  return fx.engine.validateQuery(def).list.filter((x) => x.code === 'condition.non-bool');
}

// A bool comparison (`order.total > 60`), reused as a passing predicate.
const boolPred: ExprDef = cmp('>', ref('order', 'total'), lit(60));
// A non-bool predicate: a money field-ref resolves to `money`, not `bool`.
const moneyPred: ExprDef = ref('order', 'total');

describe('condition.non-bool — WHERE (select)', () => {
  const base = (where: ExprDef[]): SelectDef => ({
    kind: 'select',
    fields: [{ expr: ref('order', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'order' },
    where,
  });

  it('a boolean WHERE predicate passes', () => {
    expect(condProblems(base([boolPred]))).toHaveLength(0);
  });

  it('a non-boolean WHERE predicate is flagged at its own path', () => {
    const probs = condProblems(base([moneyPred]));
    expect(probs).toHaveLength(1);
    expect(probs[0]?.path).toEqual(['where', 0]);
    expect(probs[0]?.message).toBe('Expected a boolean condition; got money.');
  });

  it('a bare `param` WHERE predicate is exempt (inferred)', () => {
    expect(condProblems(base([param('flag')]))).toHaveLength(0);
  });

  it('a non-scalar predicate (relation-path ending on a relation) reads "a value"', () => {
    const relPath: ExprDef = { kind: 'relation-path', source: 'order', path: ['userId'] };
    const probs = condProblems({
      kind: 'select',
      fields: [{ expr: ref('order', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'order' },
      where: [relPath],
    });
    expect(probs).toHaveLength(1);
    expect(probs[0]?.message).toBe('Expected a boolean condition; got a value.');
  });
});

describe('condition.non-bool — HAVING (select)', () => {
  const base = (having: ExprDef[]): SelectDef => ({
    kind: 'select',
    fields: [{ expr: ref('order', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'order' },
    having,
  });

  it('a boolean HAVING predicate passes', () => {
    expect(condProblems(base([boolPred]))).toHaveLength(0);
  });

  it('a non-boolean HAVING predicate is flagged at its own path', () => {
    const probs = condProblems(base([lit(5)]));
    expect(probs).toHaveLength(1);
    expect(probs[0]?.path).toEqual(['having', 0]);
    expect(probs[0]?.message).toBe('Expected a boolean condition; got number.');
  });

  it('a bare `param` HAVING predicate is exempt', () => {
    expect(condProblems(base([param('flag')]))).toHaveLength(0);
  });
});

describe('condition.non-bool — join `and` (select)', () => {
  const base = (and: ExprDef): SelectDef => ({
    kind: 'select',
    fields: [{ expr: ref('user', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'user' },
    joins: [{ on: { source: 'user', field: 'orders' }, and }],
  });

  it('a boolean join `and` predicate passes', () => {
    expect(condProblems(base(boolPred))).toHaveLength(0);
  });

  it('a non-boolean join `and` predicate is flagged at the `and` path', () => {
    const probs = condProblems(base(moneyPred));
    expect(probs).toHaveLength(1);
    expect(probs[0]?.path).toEqual(['joins', 0, 'and']);
    expect(probs[0]?.message).toBe('Expected a boolean condition; got money.');
  });

  it('a bare `param` join `and` predicate is exempt', () => {
    expect(condProblems(base(param('flag')))).toHaveLength(0);
  });
});

describe('condition.non-bool — WHERE (update)', () => {
  const base = (where: ExprDef[]): UpdateDef => ({
    kind: 'update',
    type: 'order',
    set: [{ field: 'note', value: lit('x') }],
    where,
  });

  it('a boolean UPDATE WHERE predicate passes', () => {
    expect(condProblems(base([boolPred]))).toHaveLength(0);
  });

  it('a non-boolean UPDATE WHERE predicate is flagged at its own path', () => {
    const probs = condProblems(base([moneyPred]));
    expect(probs).toHaveLength(1);
    expect(probs[0]?.path).toEqual(['where', 0]);
    expect(probs[0]?.message).toBe('Expected a boolean condition; got money.');
  });

  it('a bare `param` UPDATE WHERE predicate is exempt', () => {
    expect(condProblems(base([param('flag')]))).toHaveLength(0);
  });
});

describe('condition.non-bool — WHERE (delete)', () => {
  const base = (where: ExprDef[]): DeleteDef => ({
    kind: 'delete',
    from: 'order',
    where,
  });

  it('a boolean DELETE WHERE predicate passes', () => {
    expect(condProblems(base([boolPred]))).toHaveLength(0);
  });

  it('a non-boolean DELETE WHERE predicate is flagged at its own path', () => {
    const probs = condProblems(base([moneyPred]));
    expect(probs).toHaveLength(1);
    expect(probs[0]?.path).toEqual(['where', 0]);
    expect(probs[0]?.message).toBe('Expected a boolean condition; got money.');
  });

  it('a bare `param` DELETE WHERE predicate is exempt', () => {
    expect(condProblems(base([param('flag')]))).toHaveLength(0);
  });
});

describe('condition.non-bool — no regression for normal conditions', () => {
  it('a select with ordinary WHERE + HAVING validates clean', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('order', 'userId'), as: 'userId' }],
      from: { kind: 'type', type: 'order' },
      where: [cmp('>', ref('order', 'total'), lit(0))],
      groupBy: [ref('order', 'userId')],
      having: [cmp('>=', ref('order', 'total'), lit(0))],
    };
    expect(condProblems(def)).toHaveLength(0);
  });
});
