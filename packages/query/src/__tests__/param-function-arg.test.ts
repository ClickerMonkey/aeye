/**
 * A bare bind PARAM as a function ARGUMENT is typed BY the call, not judged
 * against it — for all four call-shaped expr kinds (`function-call`,
 * `aggregate`, `window`, tabular `from: {kind:'function'}`).
 *
 * Through 0.6.6 the four kinds ran `validateCall` BEFORE observing their param
 * args, so an unobserved param still resolved to the `text` placeholder
 * (`ParamExpr.resolve`) and a perfectly good call was refused with
 * `function.arg-type` — unless an EARLIER clause happened to type the param
 * first, which made the answer depend on clause ORDER. These tests pin both
 * halves of the fix: the call is accepted, and the declared parameter type is
 * the road by which the param GETS its type (`engine.parameters`).
 */
import { describe, it, expect } from 'vitest';
import { fixture, runtimeFixture, typeScope, lit, ref, cmp, param } from './_utils';
import type { ExprDef, SelectDef } from '../schema';
import type { Problem } from '../problem';

const fx = fixture();

/** `abs(value: <arg>)`. */
const absOf = (arg: ExprDef): ExprDef => ({ kind: 'function-call', function: 'abs', args: { value: arg } });

/** The problem CODES reported for `def`, in order (the order-independence subject). */
const codes = (problems: { list: readonly Problem[] }): string[] => problems.list.map((x) => x.code);

describe('a bind param as a function argument', () => {
  it('accepts a param that is the ONLY argument use, and types it from the parameter', () => {
    const scope = typeScope(fx);
    const problems = fx.engine.validateExpr(absOf(param('p')), scope);
    expect(codes(problems)).toEqual([]);
    // The whole point: the function ARGUMENT is a typing road, not just a
    // position that stops complaining.
    expect(scope.params.resolved('p')?.resolve()).toBe('number');
    expect(scope.params.toJSON()).toEqual([{ name: 'p', type: { kind: 'number' } }]);
  });

  it('reports the argument-typed param through the public query surfaces', () => {
    // `params()` (what a caller BINDS with), `parameters()` (what a caller
    // EXPLAINS with) and `checkParams` (the pre-execution value gate) all read
    // the same merged type, so the fix has to reach all three.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
      from: { kind: 'type', type: 'user' },
      where: [cmp('>', absOf(param('p')), lit(1))],
    };
    expect(codes(fx.engine.validateQuery(def))).toEqual([]);
    expect(fx.registry.parseQuery(def).params(fx.engine)).toEqual([{ name: 'p', type: { kind: 'number' } }]);

    const info = fx.engine.parameters(def).find((x) => x.name === 'p');
    expect(info?.category).toBe('number');
    // The use names the declared parameter, not a column: a function argument's
    // requirement is structural, so `field` is absent by design.
    expect(info?.uses.map((u) => u.at.join('.'))).toEqual(['where.0.left.args.value']);
    expect(info?.uses[0]?.field).toBeUndefined();

    // And a supplied value is now checked against it.
    expect(fx.engine.checkParams(def, { p: 'nope' }).list.map((x) => x.code)).toEqual(['param.value']);
    expect(fx.engine.checkParams(def, { p: 4 }).list).toEqual([]);
  });

  it('reports the SAME problems whichever clause order the param is used in', () => {
    const first: ExprDef = {
      kind: 'logical',
      op: 'and',
      operands: [cmp('=', ref('u', 'id'), param('p')), cmp('>', absOf(param('p')), lit(1))],
    };
    const second: ExprDef = {
      kind: 'logical',
      op: 'and',
      operands: [cmp('>', absOf(param('p')), lit(1)), cmp('=', ref('u', 'id'), param('p'))],
    };
    expect(codes(fx.engine.validateExpr(first, typeScope(fx)))).toEqual([]);
    expect(codes(fx.engine.validateExpr(second, typeScope(fx)))).toEqual([]);
  });

  it('still reports a param whose uses genuinely conflict — once, as param.conflict', () => {
    // `:p` is a number here (the abs argument) and text there (the name
    // comparison). That is a param.conflict and NOTHING else, in either order:
    // the argument does not ALSO get to call the param the wrong type.
    const withFnFirst: ExprDef = {
      kind: 'logical',
      op: 'and',
      operands: [cmp('>', absOf(param('p')), lit(1)), cmp('=', ref('u', 'name'), param('p'))],
    };
    const withFnLast: ExprDef = {
      kind: 'logical',
      op: 'and',
      operands: [cmp('=', ref('u', 'name'), param('p')), cmp('>', absOf(param('p')), lit(1))],
    };
    expect(codes(fx.engine.validateExpr(withFnFirst, typeScope(fx)))).toEqual(['param.conflict']);
    expect(codes(fx.engine.validateExpr(withFnLast, typeScope(fx)))).toEqual(['param.conflict']);
  });

  it('types an `inferred`-output call from the parameter, not from the placeholder', () => {
    // `coalesce`'s output is `'inferred'` — the first argument with a
    // discernible field type. A param arg that still read as `text` would make
    // the CALL text; observed first, it is the declared `number`.
    const scope = typeScope(fx);
    const def: ExprDef = { kind: 'function-call', function: 'round', args: { value: param('p') } };
    expect(codes(fx.engine.validateExpr(def, scope))).toEqual([]);
    expect(fx.engine.resolveExpr(def, scope).kind).toBe('computed');
    expect(scope.params.resolved('p')?.resolve()).toBe('number');
  });

  it('rejects a MIS-typed non-param argument exactly as before', () => {
    // The exemption is for a bare param only: a text FIELD in a number
    // parameter is still `function.arg-type`.
    const problems = fx.engine.validateExpr(absOf(ref('u', 'name')), typeScope(fx));
    expect(codes(problems)).toEqual(['function.arg-type']);
  });
});

describe('a bind param as an argument of the other call-shaped exprs', () => {
  /** A select over `user` whose one field is `expr`. */
  const selectOf = (expr: ExprDef): SelectDef => ({
    kind: 'select',
    fields: [{ expr, as: 'v' }],
    from: { kind: 'type', type: 'user' },
  });

  it('aggregate: sum(:p) is accepted and types :p as number', () => {
    const def = selectOf({ kind: 'aggregate', function: 'sum', args: { value: param('p') } });
    expect(codes(fx.engine.validateQuery(def))).toEqual([]);
    const info = fx.engine.parameters(def).find((x) => x.name === 'p');
    expect(info?.category).toBe('number');
  });

  it('window: ntile(n: :p) is accepted and types :p as number', () => {
    const def = selectOf({
      kind: 'window',
      function: 'ntile',
      args: { n: param('p') },
      orderBy: [{ expr: ref('user', 'id'), dir: 'asc' }],
    });
    expect(codes(fx.engine.validateQuery(def))).toEqual([]);
    const info = fx.engine.parameters(def).find((x) => x.name === 'p');
    expect(info?.category).toBe('number');
  });

  it('tabular: a registered function called in FROM types its param arg', () => {
    const rfx = runtimeFixture();
    rfx.registry.registerFunction({
      name: 'rangeRows',
      shape: 'tabular',
      params: [{ name: 'count', type: { kind: 'number', whole: true } }],
      output: { type: 'user' },
    });
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('r', 'id'), as: 'id' }],
      from: { kind: 'function', function: 'rangeRows', args: { count: param('n') }, as: 'r' },
    };
    expect(codes(rfx.engine.validateQuery(def))).toEqual([]);
    const info = rfx.engine.parameters(def).find((x) => x.name === 'n');
    expect(info?.category).toBe('number');
    expect(info?.type?.toJSON()).toEqual({ kind: 'number', whole: true });
  });

  it('tabular-function-call expr: a param arg is typed by the declared parameter', () => {
    const rfx = runtimeFixture();
    rfx.registry.registerFunction({
      name: 'rangeRows',
      shape: 'tabular',
      params: [{ name: 'count', type: { kind: 'number', whole: true } }],
      output: { type: 'user' },
    });
    const scope = rfx.engine.globalScope();
    const def: ExprDef = {
      kind: 'tabular-function-call',
      function: 'rangeRows',
      args: { count: param('n') },
    };
    expect(codes(rfx.engine.validateExpr(def, scope))).toEqual([]);
    expect(scope.params.resolved('n')?.resolve()).toBe('number');
  });
});
