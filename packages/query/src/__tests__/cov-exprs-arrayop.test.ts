/**
 * Coverage-focused tests for `ArrayOpExpr` (src/exprs/array-op.ts). Exercises
 * every method and branch: `from` (single / list / omitted value + wrong-kind
 * throw), `toSchema`, `forEachChild`, `validateWalk` (every Problem code plus
 * param element observation and the item-absent / type-element branches),
 * `evaluateBool` (every op, null array, case-sensitive vs case-insensitive
 * element match, NULL needle, NULL array element), `toSQL` (every op across the
 * postgres + base dialects, including the base containment degrade/throw),
 * `cost`, `toJSON`, `clone`, and `toCode` (no-value / single / list forms).
 */
import { describe, it, expect } from 'vitest';
import { cctx, fixture, typeScope, runtimeFixture, ref, lit, param } from './_utils';
import { ArrayOpExpr } from '../exprs/array-op';
import { ParamExpr } from '../exprs/param';
import { RuntimeContext } from '../runtime/context';
import type { ArrayOp, ExprDef, SelectDef, QueryDef } from '../schema';

const fx = fixture();

/** Build an `array-op` ExprDef (`op` is already typed as `ArrayOp`). */
const arrayOp = (op: ArrayOp, target: ExprDef, value?: ExprDef | ExprDef[]): ExprDef =>
  value === undefined
    ? { kind: 'array-op', op, target }
    : { kind: 'array-op', op, target, value };

const codes = (def: ExprDef): string[] =>
  fx.engine.validateExpr(def, typeScope(fx)).list.map((p) => p.code);

/**
 * An expr that resolves to a (synthetic) TYPE rather than a value — a
 * tabular-function-call (the only remaining Type-resolving expr now that
 * `relation-path` is gone). Used to exercise the "target/element is a type,
 * not a value" branches. It also reports `tabular-function.unknown`, which is
 * irrelevant to (and filtered out of) the array-op assertions below.
 */
const typeExpr: ExprDef = { kind: 'tabular-function-call', function: 'gen', args: {} };

/** A SELECT over `user.name` filtered by `where`, for SQL emission. */
const select = (where: ExprDef): SelectDef => ({
  kind: 'select',
  fields: [{ expr: ref('user', 'name'), as: 'name' }],
  from: { kind: 'type', type: 'user' },
  where: [where],
});

const bothSQL = (def: QueryDef): { base: string; pg: string } => ({
  base: fx.engine.toSQL(def, 'base').sql,
  pg: fx.engine.toSQL(def, 'postgres').sql,
});

/** Resolve in-memory `user.name`s for which `where` holds. */
const names = async (where: ExprDef): Promise<string[]> => {
  const rt = runtimeFixture();
  const def: QueryDef = {
    kind: 'select',
    fields: [{ expr: ref('user', 'name') }],
    from: { kind: 'type', type: 'user' },
    where: [where],
  };
  const r = await rt.engine.run(def);
  return r.rows.map((row) => String(row['name'])).sort();
};

// ─── from / toSchema ─────────────────────────────────────────────────────────

describe('ArrayOpExpr.from / toSchema', () => {
  it('static from throws on a mismatched kind', () => {
    expect(() => ArrayOpExpr.from(lit(1), fx.registry)).toThrow(/expected 'array-op'/);
  });

  it('static from reconstructs single / list / omitted value forms', () => {
    const single = fx.engine.parse(arrayOp('contains', ref('u', 'tags'), lit('x')));
    expect(single.toJSON()).toEqual({ kind: 'array-op', op: 'contains', target: ref('u', 'tags'), value: lit('x') });

    const listForm = fx.engine.parse(arrayOp('containsAny', ref('u', 'tags'), [lit('a'), lit('b')]));
    expect(listForm.toJSON()).toEqual({
      kind: 'array-op', op: 'containsAny', target: ref('u', 'tags'), value: [lit('a'), lit('b')],
    });

    const omitted = fx.engine.parse(arrayOp('isEmpty', ref('u', 'tags')));
    expect(omitted.toJSON()).toEqual({ kind: 'array-op', op: 'isEmpty', target: ref('u', 'tags') });
  });

  it('toSchema parses an array-op def', () => {
    expect(
      ArrayOpExpr.toSchema({}).safeParse({
        kind: 'array-op', op: 'contains', target: { kind: 'literal' }, value: { kind: 'literal' },
      }).success,
    ).toBe(true);
  });
});

// ─── forEachChild ────────────────────────────────────────────────────────────

describe('ArrayOpExpr.forEachChild', () => {
  it('visits target plus every value', () => {
    const contains = fx.engine.parse(arrayOp('contains', ref('u', 'tags'), lit('x')));
    let n = 0;
    contains.forEachChild(() => n++);
    expect(n).toBe(2); // target + 1 value

    const isEmpty = fx.engine.parse(arrayOp('isEmpty', ref('u', 'tags')));
    let m = 0;
    isEmpty.forEachChild(() => m++);
    expect(m).toBe(1); // target only

    const any = fx.engine.parse(arrayOp('containsAny', ref('u', 'tags'), [lit('a'), lit('b')]));
    let k = 0;
    any.forEachChild(() => k++);
    expect(k).toBe(3); // target + 2 values
  });
});

// ─── validateWalk ────────────────────────────────────────────────────────────

describe('ArrayOpExpr.validateWalk', () => {
  it('reports array-op.not-array for a non-array target', () => {
    expect(codes(arrayOp('contains', ref('u', 'name'), lit('x')))).toContain('array-op.not-array');
  });

  it('reports array-op.value-arity for every op shape', () => {
    // No-value op given a value.
    expect(codes(arrayOp('isEmpty', ref('u', 'tags'), lit('x')))).toContain('array-op.value-arity');
    // Single-value op missing its value.
    expect(codes(arrayOp('contains', ref('u', 'tags')))).toContain('array-op.value-arity');
    // List op given an empty list.
    expect(codes(arrayOp('containsAny', ref('u', 'tags'), []))).toContain('array-op.value-arity');
  });

  it('reports array-op.type-mismatch for an incompatible element', () => {
    expect(codes(arrayOp('contains', ref('u', 'tags'), lit(5)))).toContain('array-op.type-mismatch');
  });

  it('falls back to "a value" in the not-array message when the target is a type', () => {
    // A target that resolves to a TYPE (not an array) ⇒ `categoryOf` is undefined.
    const def = arrayOp('contains', typeExpr, lit('x'));
    const problems = fx.engine.validateExpr(def, typeScope(fx)).list;
    const notArray = problems.find((p) => p.code === 'array-op.not-array');
    expect(notArray?.message).toContain('a value');
  });

  it('does not flag an element that resolves to a type (eft absent)', () => {
    const def = arrayOp('contains', ref('u', 'tags'), typeExpr);
    expect(codes(def)).not.toContain('array-op.type-mismatch');
  });

  it('observes a param element against the array item type (item present)', () => {
    const scope = typeScope(fx);
    fx.engine.validateExpr(arrayOp('contains', ref('u', 'tags'), param('p')), scope);
    expect(scope.params.resolved('p')?.resolve()).toBe('text');
  });

  it('skips param observation when the target is not an array (item absent)', () => {
    const scope = typeScope(fx);
    // Non-array target ⇒ `item` is undefined ⇒ the param is not observed here.
    fx.engine.validateExpr(arrayOp('contains', ref('u', 'name'), param('q')), scope);
    expect(scope.params.resolved('q')).toBeUndefined();
  });

  it('accepts well-formed clauses (no errors) for each arity', () => {
    const scope = typeScope(fx);
    expect(fx.engine.validateExpr(arrayOp('contains', ref('u', 'tags'), lit('admin')), scope).hasErrors).toBe(false);
    expect(fx.engine.validateExpr(arrayOp('isEmpty', ref('u', 'tags')), scope).hasErrors).toBe(false);
    expect(fx.engine.validateExpr(arrayOp('containsAny', ref('u', 'tags'), [lit('a')]), scope).hasErrors).toBe(false);
  });
});

// ─── evaluateBool ────────────────────────────────────────────────────────────

describe('ArrayOpExpr.evaluateBool', () => {
  it('contains / containsAny / containsAll / isEmpty / notEmpty over real rows', async () => {
    // Ada=['admin','beta'], Bob=['beta'], Cleo=[].
    expect(await names(arrayOp('contains', ref('user', 'tags'), lit('admin')))).toEqual(['Ada']);
    expect(await names(arrayOp('containsAny', ref('user', 'tags'), [lit('admin'), lit('nope')]))).toEqual(['Ada']);
    expect(await names(arrayOp('containsAny', ref('user', 'tags'), [lit('nope')]))).toEqual([]);
    expect(await names(arrayOp('containsAll', ref('user', 'tags'), [lit('admin'), lit('beta')]))).toEqual(['Ada']);
    expect(await names(arrayOp('containsAll', ref('user', 'tags'), [lit('admin'), lit('nope')]))).toEqual([]);
    expect(await names(arrayOp('isEmpty', ref('user', 'tags')))).toEqual(['Cleo']);
    expect(await names(arrayOp('notEmpty', ref('user', 'tags')))).toEqual(['Ada', 'Bob']);
  });

  it('matches case-insensitively when the item type folds case (text default)', async () => {
    // `tags` item is plain text (sensitive: false) ⇒ 'BETA' matches 'beta'.
    expect(await names(arrayOp('contains', ref('user', 'tags'), lit('BETA')))).toEqual(['Ada', 'Bob']);
  });

  it('treats a NULL target array per op (no array metadata ⇒ case-sensitive path)', async () => {
    const rt = runtimeFixture();
    // A param target carries no field type, so `elementCaseSensitive` returns
    // true; a NULL param value yields a null array for every op.
    const ctx = new RuntimeContext(rt.engine, { params: { a: null } });
    const nul = new ParamExpr('a');
    const needle = fx.engine.parse(lit('x'));
    expect(await new ArrayOpExpr('isEmpty', nul, []).evaluateBool(ctx, null)).toBe(true);
    expect(await new ArrayOpExpr('notEmpty', nul, []).evaluateBool(ctx, null)).toBe(false);
    expect(await new ArrayOpExpr('contains', nul, [needle]).evaluateBool(ctx, null)).toBe(false);
    expect(await new ArrayOpExpr('containsAny', nul, [needle]).evaluateBool(ctx, null)).toBe(false);
    expect(await new ArrayOpExpr('containsAll', nul, [needle]).evaluateBool(ctx, null)).toBe(false);
  });

  it('matches case-sensitively (and skips NULL elements / NULL needle) for an untyped array', async () => {
    const rt = runtimeFixture();
    const ctx = new RuntimeContext(rt.engine, { params: { a: ['admin', null, 'beta'] } });
    const arr = new ParamExpr('a');
    const has = (v: ExprDef): Promise<boolean> =>
      new ArrayOpExpr('contains', arr, [fx.engine.parse(v)]).evaluateBool(ctx, null);

    expect(await has(lit('admin'))).toBe(true); // exact match, skips the NULL element
    expect(await has(lit('ADMIN'))).toBe(false); // case-sensitive (no type metadata)
    expect(await has(lit(null))).toBe(false); // a NULL needle never matches

    // Non-empty / empty arrays under the no-metadata path.
    const full = new ParamExpr('a');
    expect(await new ArrayOpExpr('isEmpty', full, []).evaluateBool(ctx, null)).toBe(false);
    expect(await new ArrayOpExpr('notEmpty', full, []).evaluateBool(ctx, null)).toBe(true);

    const emptyCtx = new RuntimeContext(rt.engine, { params: { e: [] } });
    const empty = new ParamExpr('e');
    expect(await new ArrayOpExpr('isEmpty', empty, []).evaluateBool(emptyCtx, null)).toBe(true);
    expect(await new ArrayOpExpr('notEmpty', empty, []).evaluateBool(emptyCtx, null)).toBe(false);
  });
});

// ─── toSQL ───────────────────────────────────────────────────────────────────

describe('ArrayOpExpr.toSQL', () => {
  it('postgres: every op via native array operators', () => {
    const contains = fx.engine.toSQL(select(arrayOp('contains', ref('user', 'tags'), lit('admin'))), 'postgres');
    expect(contains.sql).toContain('$1 = ANY("user"."tags")');

    const all = fx.engine.toSQL(select(arrayOp('containsAll', ref('user', 'tags'), [lit('a'), lit('b')])), 'postgres');
    expect(all.sql).toContain('"user"."tags" @> ARRAY[$1, $2]');

    const any = fx.engine.toSQL(select(arrayOp('containsAny', ref('user', 'tags'), [lit('a')])), 'postgres');
    expect(any.sql).toContain('"user"."tags" && ARRAY[$1]');

    const isEmpty = fx.engine.toSQL(select(arrayOp('isEmpty', ref('user', 'tags'))), 'postgres');
    expect(isEmpty.sql).toContain('cardinality("user"."tags") = 0');

    const notEmpty = fx.engine.toSQL(select(arrayOp('notEmpty', ref('user', 'tags'))), 'postgres');
    expect(notEmpty.sql).toContain('cardinality("user"."tags") <> 0');
  });

  it('base: emptiness works, containment degrades to a documented throw', () => {
    const { base } = bothSQL(select(arrayOp('isEmpty', ref('user', 'tags'))));
    expect(base).toContain('COALESCE(json_array_length("user"."tags"), 0) = 0');
    expect(fx.engine.toSQL(select(arrayOp('notEmpty', ref('user', 'tags'))), 'base').sql).toContain('<> 0');

    for (const op of ['contains', 'containsAny', 'containsAll'] as const) {
      const value = op === 'contains' ? lit('admin') : [lit('admin')];
      expect(() => fx.engine.toSQL(select(arrayOp(op, ref('user', 'tags'), value)), 'base')).toThrow(
        /unsupported in the base/i,
      );
    }
  });
});

// ─── cost / toJSON / clone / toCode ──────────────────────────────────────────

describe('ArrayOpExpr.cost / toJSON / clone / toCode', () => {
  it('cost is a non-negative byte estimate', () => {
    const scope = typeScope(fx);
    const expr = fx.engine.parse(arrayOp('contains', ref('u', 'tags'), lit('admin')));
    expect(expr.cost(cctx(fx.engine), scope).bytes).toBeGreaterThanOrEqual(0);
  });

  it('toJSON / clone round-trip single / list / no-value forms', () => {
    const single: ExprDef = { kind: 'array-op', op: 'contains', target: ref('u', 'tags'), value: lit('admin') };
    const singleExpr = fx.engine.parse(single);
    expect(singleExpr.toJSON()).toEqual(single);
    expect(singleExpr.clone().toJSON()).toEqual(single);
    expect(singleExpr.clone()).not.toBe(singleExpr);

    const listDef: ExprDef = { kind: 'array-op', op: 'containsAny', target: ref('u', 'tags'), value: [lit('a'), lit('b')] };
    expect(fx.engine.parse(listDef).toJSON()).toEqual(listDef);

    const noValue: ExprDef = { kind: 'array-op', op: 'isEmpty', target: ref('u', 'tags') };
    expect(fx.engine.parse(noValue).toJSON()).toEqual(noValue);
  });

  it('toJSON omits the value for a single-value op with no operand', () => {
    const target = fx.engine.parse(ref('u', 'tags'));
    const noOperand = new ArrayOpExpr('contains', target, []);
    expect(noOperand.toJSON()).toEqual({ kind: 'array-op', op: 'contains', target: ref('u', 'tags') });
  });

  it('toCode renders no-value / single / list forms', () => {
    expect(fx.engine.parse(arrayOp('isEmpty', ref('u', 'tags'))).toCode()).toBe('isEmpty(u.tags)');
    expect(fx.engine.parse(arrayOp('contains', ref('u', 'tags'), lit('admin'))).toCode()).toBe('u.tags contains "admin"');
    expect(fx.engine.parse(arrayOp('containsAny', ref('u', 'tags'), [lit('a'), lit('b')])).toCode()).toBe(
      'u.tags containsAny ["a", "b"]',
    );
  });

  it('toCode falls back to NULL for a single-value op with no operand', () => {
    const target = fx.engine.parse(ref('u', 'tags'));
    expect(new ArrayOpExpr('contains', target, []).toCode()).toBe('u.tags contains NULL');
  });
});
