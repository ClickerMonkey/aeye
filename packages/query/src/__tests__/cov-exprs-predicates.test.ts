/**
 * Coverage-focused tests for the predicate / conditional expr classes:
 * `case`, `is-null`, `between`, `excluded`, `in`. Exercises every public
 * method across BOTH SQL dialects plus the runtime 3VL branches.
 */
import { describe, it, expect } from 'vitest';
import { cctx, fixture, typeScope, runtimeFixture, lit, ref, param, cmp } from './_utils';
import { asFieldType } from '../resolved-type';
import { CaseExpr } from '../exprs/case';
import { IsNullExpr } from '../exprs/is-null';
import { BetweenExpr } from '../exprs/between';
import { ExcludedExpr, EXCLUDED_SOURCE } from '../exprs/excluded';
import { InExpr } from '../exprs/in';
import { RuntimeContext } from '../runtime/context';
import { JoinCtePlanner } from '../sql/planner';
import { SqlContext } from '../sql/emit';
import type { ExprDef, SelectDef, InsertDef, QueryDef } from '../schema';
import type { Problems } from '../problem';

const fx = fixture();

function codes(p: Problems): string[] {
  return p.list.map((x) => x.code);
}

/**
 * An expr that resolves to a (synthetic) TYPE rather than a value — a
 * tabular-function-call, the only remaining Type-resolving expr now that
 * `relation-path` is gone. Exercises the "operand is a type, not a value"
 * branches (categoryOf / asFieldType undefined). It also reports
 * `tabular-function.unknown`, irrelevant to the specific codes asserted here.
 */
const typeExpr: ExprDef = { kind: 'tabular-function-call', function: 'gen', args: {} };

/** A SELECT over `user` with a single value field and an optional WHERE. */
function userSelect(field: ExprDef, where?: ExprDef[]): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: field, as: 'c' }],
    from: { kind: 'type', type: 'user' },
    where: where ?? [],
    order: [{ expr: ref('user', 'id'), dir: 'asc' }],
  };
}

/** A SELECT of `user.id` filtered by a predicate (ordered). */
function whereUsers(...where: ExprDef[]): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('user', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'user' },
    where,
    order: [{ expr: ref('user', 'id'), dir: 'asc' }],
  };
}

/** A SELECT of `order.id` filtered by a predicate (ordered). */
function whereOrders(...where: ExprDef[]): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('order', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'order' },
    where,
    order: [{ expr: ref('order', 'id'), dir: 'asc' }],
  };
}

const bothSQL = (def: QueryDef): { base: string; pg: string } => ({
  base: fx.engine.toSQL(def, 'base').sql,
  pg: fx.engine.toSQL(def, 'postgres').sql,
});

// ─── CaseExpr ────────────────────────────────────────────────────────────────

describe('CaseExpr', () => {
  it('static from throws on a mismatched kind; toSchema parses a case def', () => {
    expect(() => CaseExpr.from(lit(1), fx.registry)).toThrow();
    expect(CaseExpr.toSchema({}).safeParse({ kind: 'case', branches: [] }).success).toBe(true);
  });

  it('resolve mirrors the first then; nullable without else / with nullable branch', () => {
    const scope = typeScope(fx);
    // No else ⇒ nullable. first then is text.
    const noElse = fx.engine.resolveExpr(
      { kind: 'case', branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: lit('a') }] },
      scope,
    );
    expect(asFieldType(noElse)?.resolve()).toBe('text');
    if (noElse.kind === 'computed') expect(noElse.nullable).toBe(true);

    // With else, all non-null branches ⇒ not nullable.
    const elseNonNull = fx.engine.resolveExpr(
      { kind: 'case', branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: lit('a') }], else: lit('b') },
      scope,
    );
    if (elseNonNull.kind === 'computed') expect(elseNonNull.nullable).toBe(false);

    // With else but a nullable result branch ⇒ nullable.
    const elseNullable = fx.engine.resolveExpr(
      { kind: 'case', branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: ref('o', 'note') }], else: lit('b') },
      scope,
    );
    if (elseNullable.kind === 'computed') expect(elseNullable.nullable).toBe(true);
  });

  it('resolve flags aggregate when a branch is an aggregate', () => {
    const scope = typeScope(fx);
    const agg = fx.engine.resolveExpr(
      {
        kind: 'case',
        branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: { kind: 'aggregate', function: 'sum', args: { value: ref('o', 'total') } } }],
        else: lit(0),
      },
      scope,
    );
    if (agg.kind === 'computed') expect(agg.aggregate).toBe(true);
  });

  it('resolve falls back to text for an empty (no-branch, no-else) case', () => {
    const scope = typeScope(fx);
    const empty = fx.engine.resolveExpr({ kind: 'case', branches: [] }, scope);
    expect(asFieldType(empty)?.resolve()).toBe('text');
    if (empty.kind === 'computed') expect(empty.nullable).toBe(true);
  });

  it('resolve uses the text fallback when the first then is a (non-field) type', () => {
    const scope = typeScope(fx);
    const r = fx.engine.resolveExpr(
      { kind: 'case', branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: typeExpr }] },
      scope,
    );
    expect(asFieldType(r)?.resolve()).toBe('text');
  });

  it('validateWalk reports case.when-non-bool (scalar and type when) and case.then-mismatch', () => {
    // Numeric when ⇒ message names the category.
    const scalarWhen = fx.engine.validateExpr(
      { kind: 'case', branches: [{ when: lit(5), then: lit('a') }] },
      typeScope(fx),
    );
    expect(codes(scalarWhen)).toContain('case.when-non-bool');

    // Type when (a relation) ⇒ message falls back to 'a type'.
    const typeWhen = fx.engine.validateExpr(
      { kind: 'case', branches: [{ when: typeExpr, then: lit('a') }] },
      typeScope(fx),
    );
    expect(codes(typeWhen)).toContain('case.when-non-bool');

    // Result-branch mismatch ⇒ warning.
    const mismatch = fx.engine.validateExpr(
      { kind: 'case', branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: lit('a') }], else: lit(5) },
      typeScope(fx),
    );
    expect(codes(mismatch)).toContain('case.then-mismatch');
  });

  it('validateWalk skips the comparability loop when the first result is a type / a later result is a type', () => {
    // First then is a type ⇒ firstFt falsy ⇒ no then-mismatch.
    const firstType = fx.engine.validateExpr(
      { kind: 'case', branches: [{ when: cmp('>', ref('u', 'id'), lit(0)), then: typeExpr }] },
      typeScope(fx),
    );
    expect(codes(firstType)).not.toContain('case.then-mismatch');

    // A later result is a type ⇒ that ft is falsy ⇒ skipped (no mismatch from it).
    const laterType = fx.engine.validateExpr(
      {
        kind: 'case',
        branches: [
          { when: cmp('>', ref('u', 'id'), lit(0)), then: lit('a') },
          { when: cmp('>', ref('u', 'id'), lit(1)), then: typeExpr },
        ],
      },
      typeScope(fx),
    );
    expect(codes(laterType)).not.toContain('case.then-mismatch');
  });

  it('evaluate returns matching then / else / NULL at runtime', async () => {
    const rt = runtimeFixture();
    // id>1 ⇒ 'multi'; id=1 falls to else 'one'.
    const withElse = userSelect({
      kind: 'case',
      branches: [{ when: cmp('>', ref('user', 'id'), lit(1)), then: lit('multi') }],
      else: lit('one'),
    });
    expect((await rt.engine.run(withElse)).rows).toEqual([{ c: 'one' }, { c: 'multi' }, { c: 'multi' }]);

    // No else, no branch matches ⇒ NULL for every row.
    const noMatch = userSelect({
      kind: 'case',
      branches: [{ when: cmp('>', ref('user', 'id'), lit(100)), then: lit('big') }],
    });
    expect((await rt.engine.run(noMatch)).rows).toEqual([{ c: null }, { c: null }, { c: null }]);
  });

  it('evaluate with a null row uses else / NULL (no when evaluated)', async () => {
    const rt = runtimeFixture();
    const ctx = new RuntimeContext(rt.engine);
    const withElse = rt.engine.parse({
      kind: 'case',
      branches: [{ when: cmp('>', ref('user', 'id'), lit(0)), then: lit('a') }],
      else: lit('z'),
    });
    expect((await withElse.evaluate(ctx, null)).raw).toBe('z');
    const noElse = rt.engine.parse({
      kind: 'case',
      branches: [{ when: cmp('>', ref('user', 'id'), lit(0)), then: lit('a') }],
    });
    expect((await noElse.evaluate(ctx, null)).raw).toBe(null);
  });

  it('emits CASE SQL in both dialects', () => {
    const def = userSelect({
      kind: 'case',
      branches: [{ when: cmp('>', ref('user', 'id'), lit(1)), then: lit('multi') }],
      else: lit('one'),
    });
    const { base, pg } = bothSQL(def);
    expect(base).toContain('CASE WHEN');
    expect(base).toContain('THEN');
    expect(base).toContain('ELSE');
    expect(base).toContain('END');
    expect(pg).toContain('CASE WHEN');
  });

  it('cost / toJSON / clone / toCode / forEachChild', () => {
    const scope = typeScope(fx);
    const def: ExprDef = {
      kind: 'case',
      branches: [{ when: cmp('>', ref('u', 'id'), lit(1)), then: lit('multi') }],
      else: lit('one'),
    };
    const expr = fx.engine.parse(def);
    expect(expr.cost(cctx(fx.engine), scope).bytes).toBeGreaterThanOrEqual(0);
    expect(expr.toJSON()).toEqual(def);
    expect(expr.clone().toJSON()).toEqual(def);
    expect(expr.clone()).not.toBe(expr);
    expect(expr.toCode()).toBe('CASE WHEN (u.id > 1) THEN "multi" ELSE "one" END');

    // toCode without an else.
    const noElse = fx.engine.parse({ kind: 'case', branches: [{ when: cmp('>', ref('u', 'id'), lit(1)), then: lit('multi') }] });
    expect(noElse.toCode()).toBe('CASE WHEN (u.id > 1) THEN "multi" END');

    let kids = 0;
    expr.forEachChild(() => kids++);
    expect(kids).toBe(3); // when, then, else
  });
});

// ─── IsNullExpr ──────────────────────────────────────────────────────────────

describe('IsNullExpr', () => {
  it('static from throws on a mismatched kind; toSchema parses', () => {
    expect(() => IsNullExpr.from(lit(1), fx.registry)).toThrow();
    expect(IsNullExpr.toSchema({}).safeParse({ kind: 'is-null', value: { kind: 'literal' } }).success).toBe(true);
  });

  it('resolve / validateWalk yield a non-nullable bool', () => {
    const scope = typeScope(fx);
    const r = fx.engine.resolveExpr({ kind: 'is-null', value: ref('u', 'age') }, scope);
    expect(asFieldType(r)?.resolve()).toBe('bool');
    if (r.kind === 'computed') expect(r.nullable).toBe(false);
    expect(fx.engine.validateExpr({ kind: 'is-null', value: ref('u', 'age') }, scope).hasErrors).toBe(false);
  });

  it('evaluateBool covers IS NULL and IS NOT NULL', async () => {
    const rt = runtimeFixture();
    // order.note is null for orders 11 and 13.
    expect((await rt.engine.run(whereOrders({ kind: 'is-null', value: ref('order', 'note') }))).rows).toEqual([
      { id: 11 },
      { id: 13 },
    ]);
    expect(
      (await rt.engine.run(whereOrders({ kind: 'is-null', value: ref('order', 'note'), not: true }))).rows,
    ).toEqual([{ id: 10 }, { id: 12 }]);
  });

  it('emits IS [NOT] NULL SQL in both dialects', () => {
    const isNull = bothSQL(whereOrders({ kind: 'is-null', value: ref('order', 'note') }));
    expect(isNull.base).toContain('IS NULL');
    expect(isNull.pg).toContain('IS NULL');
    const notNull = bothSQL(whereOrders({ kind: 'is-null', value: ref('order', 'note'), not: true }));
    expect(notNull.base).toContain('IS NOT NULL');
    expect(notNull.pg).toContain('IS NOT NULL');
  });

  it('toJSON / clone / toCode / forEachChild for both `not` values', () => {
    const plain = fx.engine.parse({ kind: 'is-null', value: ref('u', 'age') });
    expect(plain.toJSON()).toEqual({ kind: 'is-null', value: ref('u', 'age') });
    expect(plain.toCode()).toBe('u.age IS NULL');
    expect(plain.clone().toJSON()).toEqual(plain.toJSON());
    let kids = 0;
    plain.forEachChild(() => kids++);
    expect(kids).toBe(1);

    const notDef: ExprDef = { kind: 'is-null', value: ref('u', 'age'), not: true };
    const notExpr = fx.engine.parse(notDef);
    expect(notExpr.toJSON()).toEqual(notDef);
    expect(notExpr.toCode()).toBe('u.age IS NOT NULL');
  });
});

// ─── BetweenExpr ─────────────────────────────────────────────────────────────

describe('BetweenExpr', () => {
  it('static from throws on a mismatched kind; toSchema parses', () => {
    expect(() => BetweenExpr.from(lit(1), fx.registry)).toThrow();
    expect(
      BetweenExpr.toSchema({}).safeParse({
        kind: 'between',
        value: { kind: 'literal' },
        lower: { kind: 'literal' },
        upper: { kind: 'literal' },
      }).success,
    ).toBe(true);
  });

  it('validateWalk reports between.type for a non-comparable bound', () => {
    const p = fx.engine.validateExpr(
      { kind: 'between', value: ref('u', 'name'), lower: lit(5), upper: lit(9) },
      typeScope(fx),
    );
    expect(codes(p)).toContain('between.type');
  });

  it('validateWalk infers a param bound from the value type', () => {
    const scope = typeScope(fx);
    fx.engine.validateExpr(
      { kind: 'between', value: ref('u', 'id'), lower: param('lo'), upper: lit(9) },
      scope,
    );
    expect(scope.params.resolved('lo')?.resolve()).toBe('number');
  });

  it('validateWalk infers a param value from a bound type (right side of the ?? fallback too)', () => {
    const scope = typeScope(fx);
    // lower resolves to a number ⇒ value param takes number.
    fx.engine.validateExpr(
      { kind: 'between', value: param('v'), lower: ref('u', 'id'), upper: ref('u', 'id') },
      scope,
    );
    expect(scope.params.resolved('v')?.resolve()).toBe('number');

    // lower resolves to a TYPE (asFieldType undefined) ⇒ upper supplies the type.
    const scope2 = typeScope(fx);
    fx.engine.validateExpr(
      { kind: 'between', value: param('w'), lower: typeExpr, upper: ref('u', 'id') },
      scope2,
    );
    expect(scope2.params.resolved('w')?.resolve()).toBe('number');
  });

  it('validateWalk does not flag a non-comparable bound when the value is a type', () => {
    const p = fx.engine.validateExpr(
      { kind: 'between', value: typeExpr, lower: lit('x'), upper: lit('y') },
      typeScope(fx),
    );
    expect(codes(p)).not.toContain('between.type');
  });

  it('evaluateBool covers within / NOT / NULL bound / NULL value under 3VL', async () => {
    const rt = runtimeFixture();
    // ages: Ada 36, Bob 42, Cleo 29.
    expect((await rt.engine.run(whereUsers({ kind: 'between', value: ref('user', 'age'), lower: lit(30), upper: lit(40) }))).rows).toEqual([
      { id: 1 },
    ]);
    // NOT BETWEEN ⇒ the complement.
    expect(
      (await rt.engine.run(whereUsers({ kind: 'between', value: ref('user', 'age'), lower: lit(30), upper: lit(40), not: true }))).rows,
    ).toEqual([{ id: 2 }, { id: 3 }]);
    // NULL lower bound ⇒ ge UNKNOWN; only FALSE le can exclude ⇒ no row is TRUE.
    expect((await rt.engine.run(whereUsers({ kind: 'between', value: ref('user', 'age'), lower: lit(null), upper: lit(40) }))).rows).toEqual(
      [],
    );
    // NULL upper bound, NOT BETWEEN (matches SQL 3VL): Cleo age 29 ⇒
    //   29 BETWEEN 30 AND NULL = (29>=30) AND (29<=NULL) = FALSE AND UNKNOWN = FALSE,
    //   so NOT(FALSE) = TRUE ⇒ Cleo qualifies. Ada/Bob are >=30 so ge is TRUE and the
    //   le bound is UNKNOWN ⇒ TRUE AND UNKNOWN = UNKNOWN ⇒ NOT(UNKNOWN) = UNKNOWN ⇒ excluded.
    expect(
      (await rt.engine.run(whereUsers({ kind: 'between', value: ref('user', 'age'), lower: lit(30), upper: lit(null), not: true }))).rows,
    ).toEqual([{ id: 3 }]);
    // NULL value ⇒ both sides UNKNOWN ⇒ no row.
    expect((await rt.engine.run(whereUsers({ kind: 'between', value: lit(null), lower: lit(1), upper: lit(9) }))).rows).toEqual([]);
  });

  it('emits BETWEEN / NOT BETWEEN SQL in both dialects', () => {
    const between = bothSQL(whereUsers({ kind: 'between', value: ref('user', 'age'), lower: lit(1), upper: lit(9) }));
    expect(between.base).toContain('BETWEEN');
    expect(between.pg).toContain('BETWEEN');
    const notBetween = bothSQL(whereUsers({ kind: 'between', value: ref('user', 'age'), lower: lit(1), upper: lit(9), not: true }));
    expect(notBetween.base).toContain('NOT BETWEEN');
  });

  it('toJSON / clone / toCode / forEachChild for both `not` values', () => {
    const def: ExprDef = { kind: 'between', value: ref('u', 'age'), lower: lit(1), upper: lit(9) };
    const expr = fx.engine.parse(def);
    expect(expr.toJSON()).toEqual(def);
    expect(expr.clone().toJSON()).toEqual(def);
    expect(expr.clone()).not.toBe(expr);
    expect(expr.toCode()).toBe('u.age BETWEEN 1 AND 9');
    let kids = 0;
    expr.forEachChild(() => kids++);
    expect(kids).toBe(3);

    const notDef: ExprDef = { kind: 'between', value: ref('u', 'age'), lower: lit(1), upper: lit(9), not: true };
    const notExpr = fx.engine.parse(notDef);
    expect(notExpr.toJSON()).toEqual(notDef);
    expect(notExpr.toCode()).toBe('u.age NOT BETWEEN 1 AND 9');
  });
});

// ─── ExcludedExpr ────────────────────────────────────────────────────────────

describe('ExcludedExpr', () => {
  it('static from throws on a mismatched kind; toSchema parses; EXCLUDED_SOURCE', () => {
    expect(() => ExcludedExpr.from(lit(1), fx.registry)).toThrow();
    expect(ExcludedExpr.toSchema({}).safeParse({ kind: 'excluded', field: 'name' }).success).toBe(true);
    expect(EXCLUDED_SOURCE).toBe('excluded');
  });

  it('resolve: text fallback with no / non-type binding; FieldResolved with a type binding', () => {
    // No `excluded` binding ⇒ text fallback.
    const noBinding = fx.engine.resolveExpr({ kind: 'excluded', field: 'name' }, typeScope(fx));
    expect(asFieldType(noBinding)?.resolve()).toBe('text');

    // A non-type binding (computed) ⇒ text fallback (the `bound.kind !== 'type'` arm).
    const scopeComputed = typeScope(fx);
    scopeComputed.bind(EXCLUDED_SOURCE, fx.engine.resolveExpr(lit(1), scopeComputed));
    expect(asFieldType(fx.engine.resolveExpr({ kind: 'excluded', field: 'name' }, scopeComputed))?.resolve()).toBe('text');

    // A type binding, known field ⇒ FieldResolved.
    const scopeType = typeScope(fx);
    scopeType.bind(EXCLUDED_SOURCE, { kind: 'type', type: fx.user, source: EXCLUDED_SOURCE, synthetic: false });
    const fieldR = fx.engine.resolveExpr({ kind: 'excluded', field: 'name' }, scopeType);
    expect(fieldR.kind).toBe('field');

    // A type binding, unknown field ⇒ text fallback.
    const unknown = fx.engine.resolveExpr({ kind: 'excluded', field: 'nope' }, scopeType);
    expect(asFieldType(unknown)?.resolve()).toBe('text');
  });

  it('validateWalk: outside-conflict (no / non-type binding), unknown-field, and a valid reference', () => {
    expect(codes(fx.engine.validateExpr({ kind: 'excluded', field: 'name' }, typeScope(fx)))).toContain(
      'excluded.outside-conflict',
    );

    const scopeComputed = typeScope(fx);
    scopeComputed.bind(EXCLUDED_SOURCE, fx.engine.resolveExpr(lit(1), scopeComputed));
    expect(codes(fx.engine.validateExpr({ kind: 'excluded', field: 'name' }, scopeComputed))).toContain(
      'excluded.outside-conflict',
    );

    const scopeType = typeScope(fx);
    scopeType.bind(EXCLUDED_SOURCE, { kind: 'type', type: fx.user, source: EXCLUDED_SOURCE, synthetic: false });
    expect(codes(fx.engine.validateExpr({ kind: 'excluded', field: 'nope' }, scopeType))).toContain(
      'excluded.unknown-field',
    );
    expect(fx.engine.validateExpr({ kind: 'excluded', field: 'name' }, scopeType).hasErrors).toBe(false);
  });

  it('cost reflects the resolved field (binding) vs the text fallback (no binding)', () => {
    const scopeType = typeScope(fx);
    scopeType.bind(EXCLUDED_SOURCE, { kind: 'type', type: fx.user, source: EXCLUDED_SOURCE, synthetic: false });
    const expr = fx.engine.parse({ kind: 'excluded', field: 'name' });
    expect(expr.cost(cctx(fx.engine), scopeType).rows).toBe(0);
    expect(expr.cost(cctx(fx.engine), typeScope(fx)).rows).toBe(0);
  });

  it('evaluate reads the proposed row (present / absent field / null row)', async () => {
    const rt = runtimeFixture();
    const ctx = new RuntimeContext(rt.engine);
    const expr = rt.engine.parse({ kind: 'excluded', field: 'name' });
    expect((await expr.evaluate(ctx, { [EXCLUDED_SOURCE]: { name: 'Ada' } })).raw).toBe('Ada');
    expect((await expr.evaluate(ctx, { [EXCLUDED_SOURCE]: {} })).raw).toBe(null);
    expect((await expr.evaluate(ctx, null)).raw).toBe(null);
  });

  it('emits EXCLUDED."field" SQL inside an upsert in both dialects', () => {
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      rows: [{ id: { kind: 'literal', value: 1 }, name: { kind: 'literal', value: 'Ada' } }],
      onConflict: { fields: ['id'], update: { name: { kind: 'excluded', field: 'name' } } },
    };
    expect(fx.engine.toSQL(def, 'base').sql).toContain('EXCLUDED."name"');
    expect(fx.engine.toSQL(def, 'postgres').sql).toContain('EXCLUDED."name"');
  });

  it('toJSON / clone / toCode', () => {
    const expr = fx.engine.parse({ kind: 'excluded', field: 'name' });
    expect(expr.toJSON()).toEqual({ kind: 'excluded', field: 'name' });
    expect(expr.clone().toJSON()).toEqual({ kind: 'excluded', field: 'name' });
    expect(expr.clone()).not.toBe(expr);
    expect(expr.toCode()).toBe('EXCLUDED.name');
  });
});

// ─── InExpr ──────────────────────────────────────────────────────────────────

describe('InExpr', () => {
  it('static from throws on a mismatched kind; toSchema parses list and subquery forms', () => {
    expect(() => InExpr.from(lit(1), fx.registry)).toThrow();
    expect(
      InExpr.toSchema({}).safeParse({ kind: 'in', value: { kind: 'literal' }, in: [{ kind: 'literal' }] }).success,
    ).toBe(true);
  });

  it('validateWalk (list): reports in.type, skips on param sides, infers param element/value', () => {
    // A non-comparable element ⇒ in.type.
    expect(codes(fx.engine.validateExpr({ kind: 'in', value: ref('u', 'id'), in: [lit('x')] }, typeScope(fx)))).toContain(
      'in.type',
    );

    // A param element is skipped (no in.type) and inferred from the value.
    const scopeEl = typeScope(fx);
    fx.engine.validateExpr({ kind: 'in', value: ref('u', 'id'), in: [param('e')] }, scopeEl);
    expect(scopeEl.params.resolved('e')?.resolve()).toBe('number');

    // A param value is skipped on the element check and inferred from the list.
    const scopeVal = typeScope(fx);
    fx.engine.validateExpr({ kind: 'in', value: param('v'), in: [lit(1), lit(2)] }, scopeVal);
    expect(scopeVal.params.resolved('v')?.resolve()).toBe('number');

    // An empty list ⇒ no element type to infer the value param from, so `v` is
    // referenced but never observed ⇒ ParamSet reports it as `param.untyped`
    // (an error). The param stays unresolved.
    const scopeEmpty = typeScope(fx);
    expect(fx.engine.validateExpr({ kind: 'in', value: param('v'), in: [] }, scopeEmpty).hasErrors).toBe(true);
    expect(scopeEmpty.params.resolved('v')).toBeUndefined();
  });

  it('validateWalk (subquery): reports in.type, accepts comparable, and infers a param value', () => {
    // text value vs number subquery field ⇒ in.type.
    const bad: ExprDef = {
      kind: 'in',
      value: ref('u', 'name'),
      in: { kind: 'select', fields: [{ expr: ref('o', 'id') }], from: { kind: 'type', type: 'order' } },
    };
    expect(codes(fx.engine.validateExpr(bad, typeScope(fx)))).toContain('in.type');

    // number value vs number subquery field ⇒ no in.type.
    const ok: ExprDef = {
      kind: 'in',
      value: ref('u', 'id'),
      in: { kind: 'select', fields: [{ expr: ref('o', 'id') }], from: { kind: 'type', type: 'order' } },
    };
    expect(codes(fx.engine.validateExpr(ok, typeScope(fx)))).not.toContain('in.type');

    // param value vs subquery ⇒ skipped + inferred to the subquery field type.
    const scope = typeScope(fx);
    const paramQ: ExprDef = {
      kind: 'in',
      value: param('v'),
      in: { kind: 'select', fields: [{ expr: ref('o', 'id') }], from: { kind: 'type', type: 'order' } },
    };
    fx.engine.validateExpr(paramQ, scope);
    expect(scope.params.resolved('v')?.resolve()).toBe('number');
  });

  it('cost: list (children only) vs subquery (adds the inner scan)', () => {
    const scope = typeScope(fx);
    const listExpr = fx.engine.parse({ kind: 'in', value: ref('u', 'id'), in: [lit(1), lit(2)] });
    const subExpr = fx.engine.parse({
      kind: 'in',
      value: ref('u', 'id'),
      in: { kind: 'select', fields: [{ expr: ref('o', 'id') }], from: { kind: 'type', type: 'order' } },
    });
    expect(listExpr.cost(cctx(fx.engine), scope).bytes).toBeGreaterThanOrEqual(0);
    expect(subExpr.cost(cctx(fx.engine), scope).bytes).toBeGreaterThanOrEqual(0);
  });

  it('evaluateBool (list) under 3VL: matched / NULL element / no-match / NOT IN / NULL value', async () => {
    const rt = runtimeFixture();
    expect((await rt.engine.run(whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(1), lit(2)] }))).rows).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    // A NULL element adds no rows; only the equal one matches.
    expect((await rt.engine.run(whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(1), lit(null)] }))).rows).toEqual([
      { id: 1 },
    ]);
    // No match, no NULL ⇒ FALSE for every row.
    expect((await rt.engine.run(whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(99)] }))).rows).toEqual([]);
    // NOT IN with a clean list ⇒ the complement.
    expect((await rt.engine.run(whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(1), lit(2)], not: true }))).rows).toEqual([
      { id: 3 },
    ]);
    // NULL value ⇒ UNKNOWN ⇒ no row.
    expect((await rt.engine.run(whereUsers({ kind: 'in', value: lit(null), in: [lit(1), lit(2)] }))).rows).toEqual([]);
  });

  it('evaluateBool (subquery) under 3VL: matched and NULL-in-subquery', async () => {
    const rt = runtimeFixture();
    // userId values {1,1,2,2} ⇒ users 1 and 2 match. The subquery CROSSES the
    // relation with a `relation` join and projects the JOINED alias's scalar id
    // — the library's prescribed shape. Projecting `order.userId` directly would
    // yield that relation's IDENTITY object, and comparing a relation to a
    // scalar is refused by validation (`compare.relation-vs-value`) — see below.
    const matched: ExprDef = {
      kind: 'in',
      value: ref('user', 'id'),
      in: {
        kind: 'select',
        fields: [{ expr: ref('ou', 'id') }],
        from: { kind: 'type', type: 'order' },
        joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'ou' } }],
      },
    };
    expect((await rt.engine.run(whereUsers(matched))).rows).toEqual([{ id: 1 }, { id: 2 }]);

    // The un-joined form is (and already was) a validation error.
    const relationProjected: ExprDef = {
      kind: 'in',
      value: ref('user', 'id'),
      in: { kind: 'select', fields: [{ expr: ref('order', 'userId') }], from: { kind: 'type', type: 'order' } },
    };
    expect(rt.engine.validateQuery(whereUsers(relationProjected)).list.map((p) => p.code)).toContain(
      'compare.relation-vs-value',
    );

    // note has NULLs and never equals an id ⇒ no match, the NULL makes it UNKNOWN ⇒ no row.
    const nullable: ExprDef = {
      kind: 'in',
      value: ref('user', 'id'),
      in: { kind: 'select', fields: [{ expr: ref('order', 'note') }], from: { kind: 'type', type: 'order' } },
    };
    expect((await rt.engine.run(whereUsers(nullable))).rows).toEqual([]);
  });

  it('emits IN / NOT IN SQL (list + subquery) in both dialects', () => {
    const list = bothSQL(whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(1), lit(2)] }));
    expect(list.base).toContain('IN (');
    expect(list.pg).toContain('IN (');
    const notList = bothSQL(whereUsers({ kind: 'in', value: ref('user', 'id'), in: [lit(1)], not: true }));
    expect(notList.base).toContain('NOT IN (');
    const sub = bothSQL(
      whereUsers({
        kind: 'in',
        value: ref('user', 'id'),
        in: { kind: 'select', fields: [{ expr: ref('order', 'userId') }], from: { kind: 'type', type: 'order' } },
      }),
    );
    expect(sub.base).toContain('IN (SELECT');
    expect(sub.pg).toContain('IN (SELECT');
  });

  it('emits `()` for a degenerate IN with neither list nor subquery', () => {
    const dialect = fx.registry.dialect('base');
    if (!dialect) throw new Error('base dialect missing');
    const scope = typeScope(fx);
    const planner = new JoinCtePlanner(dialect, fx.engine, undefined);
    const ctx = new SqlContext(dialect, fx.engine, scope, planner, undefined);
    const degenerate = new InExpr(fx.engine.parse(lit(1)), undefined, undefined, false);
    expect(degenerate.toSQL(dialect, ctx).render(dialect).sql).toContain('IN ()');
  });

  it('toJSON / clone / toCode / forEachChild for list and subquery forms', () => {
    const listDef: ExprDef = { kind: 'in', value: ref('u', 'id'), in: [lit(1), lit(2)] };
    const listExpr = fx.engine.parse(listDef);
    expect(listExpr.toJSON()).toEqual(listDef);
    expect(listExpr.clone().toJSON()).toEqual(listDef);
    expect(listExpr.clone()).not.toBe(listExpr);
    expect(listExpr.toCode()).toBe('u.id IN (1, 2)');
    let listKids = 0;
    listExpr.forEachChild(() => listKids++);
    expect(listKids).toBe(3); // value + 2 list elements

    const notDef: ExprDef = { kind: 'in', value: ref('u', 'id'), in: [lit(1)], not: true };
    const notExpr = fx.engine.parse(notDef);
    expect(notExpr.toJSON()).toEqual(notDef);
    expect(notExpr.toCode()).toBe('u.id NOT IN (1)');

    const subDef: ExprDef = {
      kind: 'in',
      value: ref('u', 'id'),
      in: { kind: 'select', fields: [{ expr: ref('o', 'id') }], from: { kind: 'type', type: 'order' } },
    };
    const subExpr = fx.engine.parse(subDef);
    expect(subExpr.toJSON()).toEqual(subDef);
    expect(subExpr.clone().toJSON()).toEqual(subDef);
    expect(subExpr.toCode()).toBe('u.id IN (subquery)');
    let subKids = 0;
    subExpr.forEachChild(() => subKids++);
    expect(subKids).toBe(1); // only the value (subquery is not an Expr child)
  });
});
