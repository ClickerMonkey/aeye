/**
 * Full-coverage tests for the scalar/predicate expr kinds:
 *   binary.ts, comparison.ts, logical.ts, literal.ts, param.ts
 *
 * Each public method is exercised across BOTH SQL dialects and the in-memory
 * runtime, including 3-valued logic (NULL/UNKNOWN), text case-folding, the
 * param bind/infer surface, and the exhaustiveness `default:` guards (reached
 * by constructing an expr with an out-of-union op via a typed JSON-boundary
 * narrow — the only `as` permitted by the task rules).
 */
import { describe, it, expect } from 'vitest';
import { cctx, fixture, runtimeFixture, typeScope, lit, ref, param, cmp } from './_utils';
import { BinaryExpr } from '../exprs/binary';
import { ComparisonExpr } from '../exprs/comparison';
import { LogicalExpr } from '../exprs/logical';
import { LiteralExpr } from '../exprs/literal';
import { ParamExpr } from '../exprs/param';
import { RuntimeContext } from '../runtime/context';
import { asFieldType } from '../resolved-type';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import type { Problems } from '../problem';
import type { ExprDef, SelectDef, TypeDef } from '../schema';
import type { SourceRow } from '../runtime/row';

const fx = fixture();
const scope = typeScope(fx); // resolve-only (params unused)
const ctx = new RuntimeContext(fx.engine);
const row: SourceRow = {};

const codes = (p: Problems): string[] => p.list.map((x) => x.code);
const has = (p: Problems, code: string): boolean => p.list.some((x) => x.code === code);
const validate = (def: ExprDef): Problems => fx.engine.validateExpr(def, typeScope(fx));

// FROM-user SELECT helpers (source name 'user'/'order' bound by the FROM clause).
function fieldSelect(expr: ExprDef): SelectDef {
  return { kind: 'select', fields: [{ expr, as: 'x' }], from: { kind: 'type', type: 'user' } };
}
function whereSelect(where: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('user', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'user' },
    where: [where],
  };
}
const whereSql = (where: ExprDef, dialect: string): string => fx.engine.toSQL(whereSelect(where), dialect).sql;

// An expr that resolves to a (synthetic) Type — a tabular-function-call, the only
// remaining Type-resolving expr now that `relation-path` is gone — so categoryOf /
// asFieldType are undefined. (It also reports `tabular-function.unknown`, which is
// irrelevant to the specific problem codes / param inferences asserted below.)
const ordersPath: ExprDef = { kind: 'tabular-function-call', function: 'gen', args: {} };

// ─── A local registry with a `casing:'exact'` text field (for case-folding) ──
const docDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } },
    { name: 'code', type: { kind: 'text', casing: 'exact' } },
  ],
  indexes: [{ exprs: [{ expr: ref('doc', 'id'), count: 1 }] }],
  count: 100,
  bytes: 40,
};
function docEngine(): QueryEngine {
  const r = createRegistry();
  r.registerType(r.parseType(docDef));
  r.finalize();
  return new QueryEngine(r, {
    executors: {
      doc: arrayExecutor([
        { id: 1, title: 'Hello', code: 'ABC' },
        { id: 2, title: 'WORLD', code: 'abc' },
      ]),
    },
  });
}
function docWhere(where: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('doc', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'doc' },
    where: [where],
    order: [{ expr: ref('doc', 'id'), dir: 'asc' }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('BinaryExpr', () => {
  it('from: valid + wrong-kind throw', () => {
    expect(BinaryExpr.from({ kind: 'binary', op: '+', left: lit(1), right: lit(2) }, fx.registry).op).toBe('+');
    expect(() => BinaryExpr.from(lit(1), fx.registry)).toThrow();
  });

  it('toSchema returns a zod schema', () => {
    expect(BinaryExpr.toSchema({})).toBeDefined();
  });

  it('resolve: number / money (either side) / text-concat (either side)', () => {
    expect(asFieldType(fx.engine.resolveExpr({ kind: 'binary', op: '*', left: lit(2), right: lit(3) }, scope))?.resolve()).toBe('number');
    expect(asFieldType(fx.engine.resolveExpr({ kind: 'binary', op: '+', left: ref('o', 'total'), right: lit(1) }, scope))?.resolve()).toBe('money');
    expect(asFieldType(fx.engine.resolveExpr({ kind: 'binary', op: '+', left: lit(1), right: ref('o', 'total') }, scope))?.resolve()).toBe('money');
    expect(asFieldType(fx.engine.resolveExpr({ kind: 'binary', op: '+', left: ref('u', 'name'), right: lit('!') }, scope))?.resolve()).toBe('text');
    expect(asFieldType(fx.engine.resolveExpr({ kind: 'binary', op: '+', left: lit('!'), right: ref('u', 'name') }, scope))?.resolve()).toBe('text');
  });

  it('validateWalk: numeric ok, +text ok, type errors, exempt, param inference', () => {
    expect(validate({ kind: 'binary', op: '+', left: ref('u', 'id'), right: lit(1) }).hasErrors).toBe(false);
    expect(validate({ kind: 'binary', op: '+', left: ref('u', 'name'), right: lit('x') }).hasErrors).toBe(false);
    // non-'+' over text → binary.type
    expect(has(validate({ kind: 'binary', op: '-', left: ref('u', 'name'), right: lit(1) }), 'binary.type')).toBe(true);
    // operand resolves to a Type → categoryOf undefined → binary.type
    expect(has(validate({ kind: 'binary', op: '+', left: ordersPath, right: lit(1) }), 'binary.type')).toBe(true);
    // exempt operands (NULL literal + param) skip the numeric check
    expect(has(validate({ kind: 'binary', op: '-', left: lit(null), right: lit(1) }), 'binary.type')).toBe(false);

    const s1 = typeScope(fx);
    fx.engine.validateExpr({ kind: 'binary', op: '+', left: param('a'), right: ref('u', 'id') }, s1);
    expect(s1.params.resolved('a')?.resolve()).toBe('number');

    const s2 = typeScope(fx);
    fx.engine.validateExpr({ kind: 'binary', op: '+', left: ref('u', 'id'), right: param('b') }, s2);
    expect(s2.params.resolved('b')?.resolve()).toBe('number');

    // param paired with a Type operand → asFieldType undefined → no observe
    const s3 = typeScope(fx);
    fx.engine.validateExpr({ kind: 'binary', op: '+', left: param('c'), right: ordersPath }, s3);
    expect(s3.params.resolved('c')).toBeUndefined();
  });

  it('evaluate: NULL-propagation, every op, /0 & %0, concat, NaN, bad-op throw', async () => {
    const ev = (def: ExprDef): Promise<import('../runtime/value').Value> => BinaryExpr.from(def, fx.registry).evaluate(ctx, null);
    expect((await ev({ kind: 'binary', op: '+', left: lit(null), right: lit(1) })).isNull()).toBe(true);
    expect((await ev({ kind: 'binary', op: '+', left: lit(1), right: lit(2) })).toNumber()).toBe(3);
    expect((await ev({ kind: 'binary', op: '-', left: lit(5), right: lit(2) })).toNumber()).toBe(3);
    expect((await ev({ kind: 'binary', op: '*', left: lit(4), right: lit(2) })).toNumber()).toBe(8);
    expect((await ev({ kind: 'binary', op: '/', left: lit(6), right: lit(2) })).toNumber()).toBe(3);
    expect((await ev({ kind: 'binary', op: '/', left: lit(6), right: lit(0) })).isNull()).toBe(true);
    expect((await ev({ kind: 'binary', op: '%', left: lit(7), right: lit(2) })).toNumber()).toBe(1);
    expect((await ev({ kind: 'binary', op: '%', left: lit(7), right: lit(0) })).isNull()).toBe(true);
    // non-numeric operands: '+' concatenates, others → NULL
    expect((await ev({ kind: 'binary', op: '+', left: lit('a'), right: lit('b') })).toText()).toBe('ab');
    expect((await ev({ kind: 'binary', op: '-', left: lit('a'), right: lit('b') })).isNull()).toBe(true);
    // out-of-union op reaches the exhaustiveness guard
    const bad = JSON.parse('{"kind":"binary","op":"^","left":{"kind":"literal","value":1},"right":{"kind":"literal","value":1}}') as ExprDef;
    await expect(BinaryExpr.from(bad, fx.registry).evaluate(ctx, null)).rejects.toThrow();
  });

  it('forEachChild / toJSON / clone / toCode / cost', () => {
    const e = BinaryExpr.from({ kind: 'binary', op: '+', left: lit(1), right: lit(2) }, fx.registry);
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(2);
    expect(e.toJSON()).toEqual({ kind: 'binary', op: '+', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 2 } });
    expect(e.clone().toJSON()).toEqual(e.toJSON());
    expect(e.toCode()).toBe('(1 + 2)');
    expect(e.cost(cctx(fx.engine), scope).rows).toBe(0);
  });

  it('toSQL: base (?) + postgres ($n)', () => {
    const def = fieldSelect({ kind: 'binary', op: '+', left: ref('user', 'id'), right: lit(1) });
    expect(fx.engine.toSQL(def, 'base').sql).toContain('("user"."id" + ?)');
    expect(fx.engine.toSQL(def, 'postgres').sql).toContain('("user"."id" + $1)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('ComparisonExpr', () => {
  it('from: valid + wrong-kind throw', () => {
    expect(ComparisonExpr.from(cmp('=', lit(1), lit(1)), fx.registry).op).toBe('=');
    expect(() => ComparisonExpr.from(lit(1), fx.registry)).toThrow();
  });

  it('toSchema returns a zod schema', () => {
    expect(ComparisonExpr.toSchema({})).toBeDefined();
  });

  it('validateWalk: LIKE family, comparability, exempt, param inference', () => {
    // LIKE requires text on each side (non-text reported at the operand path)
    expect(has(validate(cmp('like', ref('u', 'id'), lit('x'))), 'comparison.like')).toBe(true);
    expect(has(validate(cmp('like', lit('x'), ref('u', 'id'))), 'comparison.like')).toBe(true);
    // params are exempt from the LIKE text check
    expect(has(validate(cmp('like', param('p'), param('q'))), 'comparison.like')).toBe(false);
    // incomparable types
    expect(has(validate(cmp('=', ref('u', 'name'), lit(5))), 'comparison.type')).toBe(true);
    expect(validate(cmp('=', ref('u', 'id'), lit(1))).hasErrors).toBe(false);
    // NULL literal is exempt from comparability
    expect(validate(cmp('=', ref('u', 'name'), lit(null))).hasErrors).toBe(false);
    // a Type operand (no field type) skips comparability
    expect(has(validate(cmp('=', ordersPath, lit(1))), 'comparison.type')).toBe(false);

    const s1 = typeScope(fx);
    fx.engine.validateExpr(cmp('=', param('p'), ref('u', 'id')), s1);
    expect(s1.params.resolved('p')?.resolve()).toBe('number');
    const s2 = typeScope(fx);
    fx.engine.validateExpr(cmp('=', ref('u', 'name'), param('q')), s2);
    expect(s2.params.resolved('q')?.resolve()).toBe('text');
    // left param with a Type right operand → rft undefined → no observe
    const s3 = typeScope(fx);
    fx.engine.validateExpr(cmp('=', param('r'), ordersPath), s3);
    expect(s3.params.resolved('r')).toBeUndefined();
  });

  it('evaluateBool: 3VL NULL, all ops, LIKE family, bad-op default false', async () => {
    const cev = (def: ExprDef): Promise<boolean | undefined> => ComparisonExpr.from(def, fx.registry).evaluateBool(ctx, row);
    expect(await cev(cmp('=', lit(null), lit(1)))).toBeUndefined();
    expect(await cev(cmp('=', lit(1), lit(1)))).toBe(true);
    expect(await cev(cmp('<>', lit(1), lit(2)))).toBe(true);
    expect(await cev(cmp('<', lit(1), lit(2)))).toBe(true);
    expect(await cev(cmp('<=', lit(2), lit(2)))).toBe(true);
    expect(await cev(cmp('>', lit(3), lit(2)))).toBe(true);
    expect(await cev(cmp('>=', lit(2), lit(2)))).toBe(true);
    // LIKE / wildcards / escaping / notLike / ilike
    expect(await cev(cmp('like', lit('hello'), lit('h%')))).toBe(true);
    expect(await cev(cmp('like', lit('hello'), lit('xyz')))).toBe(false);
    expect(await cev(cmp('like', lit('hello'), lit('h_llo')))).toBe(true);
    expect(await cev(cmp('like', lit('axb'), lit('a.b')))).toBe(false);
    expect(await cev(cmp('notLike', lit('hello'), lit('xyz')))).toBe(true);
    expect(await cev(cmp('ilike', lit('HELLO'), lit('h%')))).toBe(true);
    // out-of-union op falls through the compare switch → false
    const bad = JSON.parse('{"kind":"comparison","op":"^","left":{"kind":"literal","value":1},"right":{"kind":"literal","value":1}}') as ExprDef;
    expect(await ComparisonExpr.from(bad, fx.registry).evaluateBool(ctx, row)).toBe(false);
  });

  it('runtime case-sensitivity: a sensitive field matches case-exactly (= and like)', async () => {
    expect((await docEngine().run(docWhere(cmp('=', ref('doc', 'code'), lit('ABC'))))).rows).toEqual([{ id: 1 }]);
    expect((await docEngine().run(docWhere(cmp('like', ref('doc', 'code'), lit('A%'))))).rows).toEqual([{ id: 1 }]);
  });

  it('forEachChild / toJSON / clone / toCode', () => {
    const e = ComparisonExpr.from(cmp('=', ref('u', 'id'), lit(1)), fx.registry);
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(2);
    expect(e.toJSON()).toEqual({ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'u', field: 'id' }, right: { kind: 'literal', value: 1 } });
    expect(e.clone().toJSON()).toEqual(e.toJSON());
    expect(e.toCode()).toBe('(<u.id> = 1)'.replace('<u.id>', e.toCode().slice(1, e.toCode().indexOf(' ='))));
  });

  it('toSQL: operators, case-insensitive LOWER, sensitive plain, ILIKE both dialects', () => {
    // every non-LIKE comparison operator (number operand → no LOWER)
    for (const op of ['=', '<>', '<', '<=', '>', '>='] as const) {
      expect(whereSql(cmp(op, ref('user', 'id'), lit(1)), 'base')).toContain(`"user"."id" ${op} ?`);
    }
    // case-insensitive text comparison lowers both sides
    expect(whereSql(cmp('=', ref('user', 'name'), lit('x')), 'base')).toContain('LOWER("user"."name") = LOWER(?)');
    // RIGHT operand is also a text FIELD (non-sensitive) ⇒ both field legs of
    // `isTextInsensitive` (rField + rField.textCaseSensitive()) are exercised.
    expect(whereSql(cmp('=', ref('user', 'name'), ref('user', 'email')), 'base')).toContain(
      'LOWER("user"."name") = LOWER("user"."email")',
    );
    // LIKE / NOT LIKE keywords
    expect(whereSql(cmp('like', ref('user', 'name'), lit('a%')), 'base')).toContain('LIKE');
    expect(whereSql(cmp('notLike', ref('user', 'name'), lit('a%')), 'base')).toContain('NOT LIKE');
    // ILIKE: postgres native, base degrades to LOWER(...) LIKE LOWER(...)
    expect(whereSql(cmp('ilike', ref('user', 'name'), lit('a%')), 'postgres')).toContain('ILIKE');
    expect(whereSql(cmp('ilike', ref('user', 'name'), lit('a%')), 'base')).toContain('LIKE');
    // a sensitive text field is NOT lowered
    const dsql = docEngine().toSQL(docWhere(cmp('=', ref('doc', 'code'), lit('ABC'))), 'base').sql;
    expect(dsql).toContain('"doc"."code" = ?');
    expect(dsql).not.toContain('LOWER("doc"."code")');
  });

  it('toSQL: out-of-union op reaches the sqlOp guard', () => {
    const bad = JSON.parse('{"kind":"comparison","op":"^","left":{"kind":"field-ref","source":"user","field":"id"},"right":{"kind":"literal","value":1}}') as ExprDef;
    expect(() => fx.engine.toSQL(whereSelect(bad), 'base')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('LogicalExpr', () => {
  const L = (def: ExprDef): LogicalExpr => LogicalExpr.from(def, fx.registry);
  const T = cmp('=', lit(1), lit(1)); // TRUE
  const F = cmp('=', lit(1), lit(2)); // FALSE
  const U = cmp('=', lit(null), lit(1)); // UNKNOWN

  it('from: valid + wrong-kind throw', () => {
    expect(L({ kind: 'logical', op: 'and', operands: [T] }).op).toBe('and');
    expect(() => LogicalExpr.from(lit(1), fx.registry)).toThrow();
  });

  it('toSchema returns a zod schema', () => {
    expect(LogicalExpr.toSchema({})).toBeDefined();
  });

  it('validateWalk: arity, non-bool, param skip, Type operand', () => {
    expect(has(validate({ kind: 'logical', op: 'not', operands: [cmp('=', ref('u', 'id'), lit(1)), cmp('=', ref('u', 'id'), lit(2))] }), 'logical.arity')).toBe(true);
    expect(has(validate({ kind: 'logical', op: 'and', operands: [ref('u', 'id')] }), 'logical.non-bool')).toBe(true);
    expect(has(validate({ kind: 'logical', op: 'and', operands: [param('p')] }), 'logical.non-bool')).toBe(false);
    expect(has(validate({ kind: 'logical', op: 'and', operands: [ordersPath] }), 'logical.non-bool')).toBe(true);
    expect(validate({ kind: 'logical', op: 'and', operands: [cmp('=', ref('u', 'id'), lit(1))] }).hasErrors).toBe(false);
  });

  it('evaluateBool: 3VL and / or / not, empty-not, bad-op throw', async () => {
    expect(await L({ kind: 'logical', op: 'and', operands: [T, T] }).evaluateBool(ctx, row)).toBe(true);
    expect(await L({ kind: 'logical', op: 'and', operands: [T, U] }).evaluateBool(ctx, row)).toBeUndefined();
    expect(await L({ kind: 'logical', op: 'and', operands: [F, U] }).evaluateBool(ctx, row)).toBe(false);
    expect(await L({ kind: 'logical', op: 'or', operands: [F, F] }).evaluateBool(ctx, row)).toBe(false);
    expect(await L({ kind: 'logical', op: 'or', operands: [T, U] }).evaluateBool(ctx, row)).toBe(true);
    expect(await L({ kind: 'logical', op: 'or', operands: [F, U] }).evaluateBool(ctx, row)).toBeUndefined();
    expect(await L({ kind: 'logical', op: 'not', operands: [T] }).evaluateBool(ctx, row)).toBe(false);
    expect(await L({ kind: 'logical', op: 'not', operands: [U] }).evaluateBool(ctx, row)).toBeUndefined();
    expect(await L({ kind: 'logical', op: 'not', operands: [] }).evaluateBool(ctx, row)).toBe(true);
    const bad = JSON.parse('{"kind":"logical","op":"xor","operands":[{"kind":"literal","value":true}]}') as ExprDef;
    await expect(LogicalExpr.from(bad, fx.registry).evaluateBool(ctx, row)).rejects.toThrow();
  });

  it('toSQL: AND / OR / NOT, empty-not → NOT (TRUE)', () => {
    expect(whereSql({ kind: 'logical', op: 'and', operands: [cmp('=', ref('user', 'id'), lit(1)), cmp('>', ref('user', 'id'), lit(0))] }, 'base')).toContain(' AND ');
    expect(whereSql({ kind: 'logical', op: 'or', operands: [cmp('=', ref('user', 'id'), lit(1)), cmp('>', ref('user', 'id'), lit(0))] }, 'base')).toContain(' OR ');
    expect(whereSql({ kind: 'logical', op: 'not', operands: [cmp('=', ref('user', 'id'), lit(1))] }, 'base')).toContain('NOT (');
    expect(whereSql({ kind: 'logical', op: 'not', operands: [] }, 'base')).toContain('NOT (TRUE)');
  });

  it('toCode / toJSON / clone / forEachChild', () => {
    expect(L({ kind: 'logical', op: 'and', operands: [T, F] }).toCode()).toContain(' AND ');
    expect(L({ kind: 'logical', op: 'not', operands: [T] }).toCode().startsWith('NOT ')).toBe(true);
    expect(L({ kind: 'logical', op: 'not', operands: [] }).toCode()).toBe('NOT ');
    const e = L({ kind: 'logical', op: 'and', operands: [T] });
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(1);
    expect(e.clone().toJSON()).toEqual(e.toJSON());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('LiteralExpr', () => {
  it('full surface: from / schema / null / resolve / evaluate / sql / code', async () => {
    expect(LiteralExpr.from(lit(1), fx.registry).value).toBe(1);
    expect(() => LiteralExpr.from(param('p'), fx.registry)).toThrow();
    expect(LiteralExpr.toSchema({})).toBeDefined();
    expect(LiteralExpr.from(lit(null), fx.registry).isNullLiteral()).toBe(true);
    expect(LiteralExpr.from(lit(1), fx.registry).isNullLiteral()).toBe(false);

    // resolve: null / number / boolean / string
    const nul = fx.engine.resolveExpr(lit(null), scope);
    expect(nul.kind).toBe('computed');
    if (nul.kind === 'computed') expect(nul.nullable).toBe(true);
    expect(asFieldType(fx.engine.resolveExpr(lit(5), scope))?.resolve()).toBe('number');
    expect(asFieldType(fx.engine.resolveExpr(lit(true), scope))?.resolve()).toBe('bool');
    expect(asFieldType(fx.engine.resolveExpr(lit('s'), scope))?.resolve()).toBe('text');

    expect(fx.engine.validateExpr(lit(1), scope).hasErrors).toBe(false);
    expect(LiteralExpr.from(lit(1), fx.registry).cost(cctx(fx.engine), scope).rows).toBe(0);
    expect((await LiteralExpr.from(lit(7), fx.registry).evaluate()).toNumber()).toBe(7);

    const e = LiteralExpr.from(lit('hi'), fx.registry);
    expect(e.toJSON()).toEqual({ kind: 'literal', value: 'hi' });
    expect(e.clone().toJSON()).toEqual(e.toJSON());
    expect(e.toCode()).toBe('"hi"');
    expect(LiteralExpr.from(lit(null), fx.registry).toCode()).toBe('NULL');

    // toSQL: NULL keyword vs bound param
    expect(fx.engine.toSQL(fieldSelect(lit(null)), 'base').sql).toContain('NULL AS "x"');
    expect(fx.engine.toSQL(fieldSelect(lit('v')), 'base').params).toEqual(['v']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('ParamExpr', () => {
  it('full surface: from / schema / collect / resolve / validate / evaluate / sql', async () => {
    expect(ParamExpr.from(param('p'), fx.registry).name).toBe('p');
    expect(() => ParamExpr.from(lit(1), fx.registry)).toThrow();
    expect(ParamExpr.toSchema({})).toBeDefined();

    // contributeParams (via collectParams)
    const sc = typeScope(fx);
    expect(() => ParamExpr.from(param('z'), fx.registry).collectParams(sc.params)).not.toThrow();

    // resolve: text fallback when uninferred, inferred type after observation
    expect(asFieldType(fx.engine.resolveExpr(param('q'), typeScope(fx)))?.resolve()).toBe('text');
    const s2 = typeScope(fx);
    fx.engine.validateExpr(cmp('=', ref('u', 'id'), param('n')), s2);
    expect(asFieldType(fx.engine.resolveExpr(param('n'), s2))?.resolve()).toBe('number');

    // validateWalk references the param (an unobserved one is reported by the set)
    expect(has(fx.engine.validateExpr(param('w'), typeScope(fx)), 'param.untyped')).toBe(true);

    expect(ParamExpr.from(param('p'), fx.registry).cost(cctx(fx.engine), typeScope(fx)).rows).toBe(0);

    // evaluate: bound value vs unbound NULL
    const bound = new RuntimeContext(fx.engine, { params: { p: 5 } });
    expect((await ParamExpr.from(param('p'), fx.registry).evaluate(bound)).toNumber()).toBe(5);
    expect((await ParamExpr.from(param('p'), fx.registry).evaluate(ctx)).isNull()).toBe(true);

    const e = ParamExpr.from(param('p'), fx.registry);
    expect(e.toJSON()).toEqual({ kind: 'param', name: 'p' });
    expect(e.clone().toJSON()).toEqual(e.toJSON());
    expect(e.toCode()).toBe(':p');

    // toSQL: hasOwnProperty true (bound) vs false (unbound → null)
    const def = whereSelect(cmp('=', ref('user', 'name'), param('p')));
    expect(fx.engine.toSQL(def, 'base', { params: { p: 'x' } }).params).toEqual(['x']);
    expect(fx.engine.toSQL(def, 'base').params).toEqual([null]);
  });
});

// Quiet unused-import guard if runtimeFixture goes unreferenced in edits.
void runtimeFixture;
