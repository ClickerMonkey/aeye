/**
 * Unit coverage for the owned, zod-free STRUCTURAL PARSER (`src/shape/`) plus
 * the defensive `Registry.parseCheckedExpr` dispatch and the 5 exemplar
 * `static SHAPE`s.
 *
 * Every combinator branch is exercised: the scalar type guards (`str` / `num` /
 * `int` / `bool` / `scalar` / `lit`) assert their AID-DIRECTED messages;
 * `enumOf` covers hit / near-miss (`didYouMean`) / non-string; `obj` covers
 * not-object / missing-required / **accumulation** (multiple problems in ONE
 * pass, no early return); `list` covers non-array / min / max / per-element;
 * `optional` covers absent-ok; `exprRef` covers recursion + nested-child
 * localization. Equivalence tests prove each exemplar `SHAPE.check` builds an
 * Expr whose `.toJSON()` equals the current `from(def).toJSON()`.
 */
import { describe, it, expect } from 'vitest';
import { Problems } from '../problem';
import { createRegistry } from '../registry';
import type { ExprClass } from '../expr';
import type { ExprDef } from '../schema';
import {
  INVALID,
  isRecord,
  expected,
  lit,
  str,
  num,
  int,
  bool,
  scalar,
  enumOf,
  optional,
  list,
  record,
  exprRef,
  obj,
  type CheckCtx,
} from '../shape';
import { ComparisonExpr } from '../exprs/comparison';
import { FieldRefExpr } from '../exprs/field-ref';
import { LiteralExpr } from '../exprs/literal';
import { ParamExpr } from '../exprs/param';
import { LogicalExpr } from '../exprs/logical';
import { BinaryExpr } from '../exprs/binary';
import { UnaryExpr } from '../exprs/unary';
import { IsNullExpr } from '../exprs/is-null';
import { BetweenExpr } from '../exprs/between';
import { InExpr } from '../exprs/in';
import { CaseExpr } from '../exprs/case';
import { AggregateExpr } from '../exprs/aggregate';
import { WindowExpr } from '../exprs/window';
import { FunctionCallExpr } from '../exprs/function-call';
import { ArrayOpExpr } from '../exprs/array-op';
import { OutputRefExpr } from '../exprs/output-ref';
import { ExcludedExpr } from '../exprs/excluded';
import { TextSearchExpr } from '../exprs/text-search';
import { TextScoreExpr } from '../exprs/text-score';

// One shared registry (child dispatch for `exprRef`); fresh problems per check.
const registry = createRegistry();
function mk(): { ctx: CheckCtx; problems: Problems } {
  const problems = new Problems();
  return { ctx: { problems, registry }, problems };
}

describe('shape — isRecord / expected helpers', () => {
  it('isRecord accepts plain objects, rejects null / arrays / primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('expected renders an aid-directed message with and without a got-tail', () => {
    expect(expected('Expr', 'x')).toBe('expected an expression, got a string');
    // undefined input → no ", got …" tail.
    expect(expected('Expr', undefined)).toBe('expected an expression');
  });
});

describe('shape — lit', () => {
  it('matches an exact value', () => {
    const { ctx, problems } = mk();
    expect(lit('literal').check('literal', ctx)).toBe('literal');
    expect(problems.list).toHaveLength(0);
  });

  it('records shape.literal on a mismatch → INVALID', () => {
    const { ctx, problems } = mk();
    expect(lit('literal').check('comparison', ctx)).toBe(INVALID);
    expect(problems.list[0]?.code).toBe('shape.literal');
    expect(problems.list[0]?.message).toContain('"literal"');
    expect(problems.list[0]?.message).toContain('got a string');
  });
});

describe('shape — scalar type guards', () => {
  it('str: passes a string, rejects a number (aid-directed)', () => {
    const ok = mk();
    expect(str('FieldName').check('hi', ok.ctx)).toBe('hi');
    const bad = mk();
    expect(str('FieldName').check(5, bad.ctx)).toBe(INVALID);
    expect(bad.problems.list[0]?.code).toBe('shape.type');
    expect(bad.problems.list[0]?.message).toBe('expected a field name, got a number');
    // undefined input → no got-tail branch.
    const gone = mk();
    str('FieldName').check(undefined, gone.ctx);
    expect(gone.problems.list[0]?.message).toBe('expected a field name');
  });

  it('num: passes a number, rejects a string', () => {
    const ok = mk();
    expect(num('Limit').check(3, ok.ctx)).toBe(3);
    const bad = mk();
    expect(num('Limit').check('3', bad.ctx)).toBe(INVALID);
    expect(bad.problems.list[0]?.message).toBe('expected a number or a param, got a string');
  });

  it('int: passes an integer, rejects a non-integer number AND a non-number', () => {
    const ok = mk();
    expect(int('Limit').check(4, ok.ctx)).toBe(4);
    // typeof number true, Number.isInteger false → the second `&&` arm.
    const frac = mk();
    expect(int('Limit').check(1.5, frac.ctx)).toBe(INVALID);
    expect(frac.problems.list[0]?.code).toBe('shape.type');
    // typeof number false → short-circuit arm.
    const notnum = mk();
    expect(int('Limit').check('x', notnum.ctx)).toBe(INVALID);
  });

  it('bool: passes a boolean, rejects otherwise', () => {
    const ok = mk();
    expect(bool('Expr').check(true, ok.ctx)).toBe(true);
    const bad = mk();
    expect(bool('Expr').check(0, bad.ctx)).toBe(INVALID);
  });

  it('scalar: accepts string / number / boolean / null, rejects object', () => {
    for (const v of ['s', 7, false, null]) {
      const { ctx } = mk();
      expect(scalar('ScalarValue').check(v, ctx)).toBe(v);
    }
    const bad = mk();
    expect(scalar('ScalarValue').check({}, bad.ctx)).toBe(INVALID);
    expect(bad.problems.list[0]?.message).toContain('a literal value');
  });
});

describe('shape — enumOf', () => {
  const ops = ['and', 'or', 'not'] as const;

  it('accepts a member', () => {
    const { ctx } = mk();
    expect(enumOf(ops, 'LogicalOp').check('or', ctx)).toBe('or');
  });

  it('rejects a near-miss string with a didYouMean suggestion', () => {
    const { ctx, problems } = mk();
    expect(enumOf(ops, 'LogicalOp').check('nt', ctx)).toBe(INVALID);
    expect(problems.list[0]?.code).toBe('shape.enum');
    expect(problems.list[0]?.message).toContain('a logical connective: and, or, not');
    expect(problems.list[0]?.message).toContain('did you mean `not`?');
  });

  it('rejects a non-string with NO suggestion tail', () => {
    const { ctx, problems } = mk();
    expect(enumOf(ops, 'LogicalOp').check(3, ctx)).toBe(INVALID);
    expect(problems.list[0]?.message).not.toContain('did you mean');
  });
});

describe('shape — optional', () => {
  it('accepts an absent (undefined) value', () => {
    const { ctx } = mk();
    expect(optional(str('FieldName')).check(undefined, ctx)).toBeUndefined();
  });

  it('delegates to the inner shape when present', () => {
    const ok = mk();
    expect(optional(str('FieldName')).check('x', ok.ctx)).toBe('x');
    const bad = mk();
    expect(optional(str('FieldName')).check(5, bad.ctx)).toBe(INVALID);
  });
});

describe('shape — list', () => {
  it('rejects a non-array (aid-directed shape.array)', () => {
    const { ctx, problems } = mk();
    expect(list(str('FieldName')).check('x', ctx)).toBe(INVALID);
    expect(problems.list[0]?.code).toBe('shape.array');
    expect(problems.list[0]?.message).toBe('expected a list, got a string');
  });

  it('checks each element and accepts a valid list', () => {
    const { ctx } = mk();
    expect(list(str('FieldName')).check(['a', 'b'], ctx)).toEqual(['a', 'b']);
  });

  it('localizes a bad element at its index', () => {
    const { ctx, problems } = mk();
    expect(list(str('FieldName')).check(['a', 5], ctx)).toBe(INVALID);
    expect(problems.list[0]?.path).toEqual([1]);
    expect(problems.list[0]?.code).toBe('shape.type');
  });

  it('reports min violations (singular + plural)', () => {
    const one = mk();
    list(str('FieldName'), { min: 1 }).check([], one.ctx);
    expect(one.problems.list[0]?.message).toBe('expected at least 1 item, got 0');
    const two = mk();
    list(str('FieldName'), { min: 2 }).check(['a'], two.ctx);
    expect(two.problems.list[0]?.message).toBe('expected at least 2 items, got 1');
  });

  it('reports max violations (singular + plural)', () => {
    const one = mk();
    list(str('FieldName'), { max: 1 }).check(['a', 'b'], one.ctx);
    expect(one.problems.list[0]?.message).toBe('expected at most 1 item, got 2');
    const two = mk();
    list(str('FieldName'), { max: 2 }).check(['a', 'b', 'c'], two.ctx);
    expect(two.problems.list[0]?.message).toBe('expected at most 2 items, got 3');
  });

  it('accepts a list within explicit bounds (no violation)', () => {
    const { ctx, problems } = mk();
    expect(list(str('FieldName'), { min: 1, max: 3 }).check(['a', 'b'], ctx)).toEqual(['a', 'b']);
    expect(problems.list).toHaveLength(0);
  });
});

describe('shape — obj', () => {
  const point = obj(
    { x: num('Limit'), y: num('Limit') },
    (v) => ({ sum: v.x + v.y }),
  );

  it('rejects a non-object with the default aid (Expr)', () => {
    const { ctx, problems } = mk();
    expect(point.check('x', ctx)).toBe(INVALID);
    expect(problems.list[0]?.code).toBe('shape.not-object');
    expect(problems.list[0]?.message).toContain('an expression');
  });

  it('reports a missing required field (shape.required at that key)', () => {
    const { ctx, problems } = mk();
    expect(point.check({ x: 1 }, ctx)).toBe(INVALID);
    expect(problems.list[0]?.path).toEqual(['y']);
    expect(problems.list[0]?.code).toBe('shape.required');
  });

  it('builds when all required fields parse', () => {
    const { ctx } = mk();
    expect(point.check({ x: 2, y: 3 }, ctx)).toEqual({ sum: 5 });
  });

  it('honors opts.optional (absent optional field is OK)', () => {
    const shape = obj(
      { a: str('FieldName'), b: str('FieldName') },
      (v) => `${v.a}:${v.b ?? '-'}`,
      { optional: ['b'] },
    );
    const { ctx, problems } = mk();
    expect(shape.check({ a: 'x' }, ctx)).toBe('x:-');
    expect(problems.list).toHaveLength(0);
  });

  it('ACCUMULATES: a comparison with a bad op AND a non-object left surfaces BOTH', () => {
    const { problems } = mk();
    const result = ComparisonExpr.SHAPE.check(
      { kind: 'comparison', op: 'notanop', left: 42, right: { kind: 'literal', value: 1 } },
      { problems, registry },
    );
    expect(result).toBe(INVALID);
    const byPath = problems.list.map((p) => ({ path: p.path.join('.'), code: p.code }));
    // op enum problem AND left not-object problem — both in ONE pass.
    expect(byPath).toContainEqual({ path: 'op', code: 'shape.enum' });
    expect(byPath).toContainEqual({ path: 'left', code: 'shape.not-object' });
    expect(problems.list.length).toBeGreaterThanOrEqual(2);
  });
});

describe('shape — exprRef recursion', () => {
  it('parses a nested valid child expr', () => {
    const { ctx } = mk();
    const built = exprRef().check({ kind: 'literal', value: 7 }, ctx);
    expect(built).toBeInstanceOf(LiteralExpr);
  });

  it('localizes a bad grandchild under its full path', () => {
    const { problems } = mk();
    // logical → operands[0] is a comparison whose left is a non-object.
    LogicalExpr.SHAPE.check(
      {
        kind: 'logical',
        op: 'and',
        operands: [{ kind: 'comparison', op: '=', left: 1, right: { kind: 'param', name: 'p' } }],
      },
      { problems, registry },
    );
    expect(problems.list.some((p) => p.path.join('.') === 'operands.0.left')).toBe(true);
  });
});

describe('registry.parseCheckedExpr — defensive dispatch', () => {
  it('passes through an already-built Expr', () => {
    const problems = new Problems();
    const e = new LiteralExpr(1);
    expect(registry.parseCheckedExpr(e, problems)).toBe(e);
  });

  it('rejects a non-object (with and without a got-tail)', () => {
    const p1 = new Problems();
    expect(registry.parseCheckedExpr(5, p1)).toBeUndefined();
    expect(p1.list[0]?.code).toBe('shape.not-object');
    expect(p1.list[0]?.message).toContain('got a number');
    const p2 = new Problems();
    expect(registry.parseCheckedExpr(undefined, p2)).toBeUndefined();
    expect(p2.list[0]?.message).toBe('expected an expression');
  });

  it('rejects a missing / non-string kind', () => {
    const p = new Problems();
    expect(registry.parseCheckedExpr({ op: '=' }, p)).toBeUndefined();
    expect(p.list[0]?.code).toBe('shape.missing-kind');
  });

  it('rejects an unknown kind with a didYouMean over real expr kinds', () => {
    const near = new Problems();
    expect(registry.parseCheckedExpr({ kind: 'comparson' }, near)).toBeUndefined();
    expect(near.list[0]?.code).toBe('shape.unknown-kind');
    expect(near.list[0]?.message).toContain('did you mean `comparison`?');
    expect(near.list[0]?.message).toContain('available:');
    // A far-off kind lists the alternatives without a false suggestion.
    const far = new Problems();
    registry.parseCheckedExpr({ kind: 'zzzzzzzz' }, far);
    expect(far.list[0]?.message).not.toContain('did you mean');
  });

  it('dispatches a valid def to its owned SHAPE', () => {
    const p = new Problems();
    const built = registry.parseCheckedExpr({ kind: 'literal', value: 'hi' }, p);
    expect(built).toBeInstanceOf(LiteralExpr);
    expect(p.list).toHaveLength(0);
  });

  it('returns undefined when the SHAPE reports a problem', () => {
    const p = new Problems();
    expect(registry.parseCheckedExpr({ kind: 'literal', value: {} }, p)).toBeUndefined();
    expect(p.hasErrors).toBe(true);
  });
});

describe('shape — logical arity wrapper', () => {
  it('flags `not` with the wrong operand count as a structural problem', () => {
    const { problems } = mk();
    const built = LogicalExpr.SHAPE.check(
      { kind: 'logical', op: 'not', operands: [{ kind: 'param', name: 'a' }, { kind: 'param', name: 'b' }] },
      { problems, registry },
    );
    expect(built).toBeInstanceOf(LogicalExpr);
    const arity = problems.list.find((pr) => pr.code === 'shape.arity');
    expect(arity?.path).toEqual(['operands']);
    expect(arity?.message).toContain('got 2');
  });

  it('accepts `not` with exactly one operand (no arity problem)', () => {
    const { problems } = mk();
    LogicalExpr.SHAPE.check(
      { kind: 'logical', op: 'not', operands: [{ kind: 'param', name: 'a' }] },
      { problems, registry },
    );
    expect(problems.list.some((pr) => pr.code === 'shape.arity')).toBe(false);
  });

  it('does not apply the arity rule to and / or', () => {
    const { problems } = mk();
    LogicalExpr.SHAPE.check(
      { kind: 'logical', op: 'and', operands: [{ kind: 'param', name: 'a' }, { kind: 'param', name: 'b' }] },
      { problems, registry },
    );
    expect(problems.list.some((pr) => pr.code === 'shape.arity')).toBe(false);
  });

  it('propagates INVALID from the inner object shape', () => {
    const { problems } = mk();
    // operands is not an array → inner obj INVALID → wrapper INVALID.
    expect(
      LogicalExpr.SHAPE.check({ kind: 'logical', op: 'and', operands: 'nope' }, { problems, registry }),
    ).toBe(INVALID);
  });
});

describe('shape — exemplar equivalence with `from`', () => {
  it('comparison: SHAPE.check(def).toJSON() equals from(def).toJSON()', () => {
    const def = {
      kind: 'comparison' as const,
      op: '>=' as const,
      left: { kind: 'field-ref' as const, source: 'u', field: 'age' },
      right: { kind: 'literal' as const, value: 18 },
    };
    const p = new Problems();
    const built = ComparisonExpr.SHAPE.check(def, { problems: p, registry });
    expect(built).not.toBe(INVALID);
    expect(built === INVALID ? null : built.toJSON()).toEqual(ComparisonExpr.from(def, registry).toJSON());
  });

  it('field-ref: equivalent to from', () => {
    const def = { kind: 'field-ref' as const, source: 'u', field: 'name' };
    const p = new Problems();
    const built = FieldRefExpr.SHAPE.check(def, { problems: p, registry });
    expect(built === INVALID ? null : built.toJSON()).toEqual(FieldRefExpr.from(def, registry).toJSON());
  });

  it('literal: equivalent to from (incl. null)', () => {
    for (const value of ['a', 3, true, null]) {
      const def = { kind: 'literal' as const, value };
      const p = new Problems();
      const built = LiteralExpr.SHAPE.check(def, { problems: p, registry });
      expect(built === INVALID ? null : built.toJSON()).toEqual(LiteralExpr.from(def, registry).toJSON());
    }
  });

  it('param: equivalent to from', () => {
    const def = { kind: 'param' as const, name: 'minAge' };
    const p = new Problems();
    const built = ParamExpr.SHAPE.check(def, { problems: p, registry });
    expect(built === INVALID ? null : built.toJSON()).toEqual(ParamExpr.from(def, registry).toJSON());
  });

  it('logical: equivalent to from', () => {
    const def = {
      kind: 'logical' as const,
      op: 'or' as const,
      operands: [
        { kind: 'param' as const, name: 'a' },
        { kind: 'param' as const, name: 'b' },
      ],
    };
    const p = new Problems();
    const built = LogicalExpr.SHAPE.check(def, { problems: p, registry });
    expect(built === INVALID ? null : built.toJSON()).toEqual(LogicalExpr.from(def, registry).toJSON());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 — the migrated exprs (operator / predicate / function / ref families).
// ─────────────────────────────────────────────────────────────────────────────

describe('shape — record combinator', () => {
  it('rejects a non-object (aid-directed shape.not-object)', () => {
    const { ctx, problems } = mk();
    expect(record(str('FieldName'), 'FunctionArgs').check('x', ctx)).toBe(INVALID);
    expect(problems.list[0]?.code).toBe('shape.not-object');
    expect(problems.list[0]?.message).toContain('named arguments');
  });

  it('checks each value and returns an insertion-ordered Map', () => {
    const { ctx } = mk();
    const out = record(str('FieldName'), 'FunctionArgs').check({ a: 'x', b: 'y' }, ctx);
    expect(out === INVALID ? null : [...out]).toEqual([
      ['a', 'x'],
      ['b', 'y'],
    ]);
  });

  it('localizes AND accumulates bad values at their keys (one pass)', () => {
    const { ctx, problems } = mk();
    expect(record(str('FieldName'), 'FunctionArgs').check({ a: 1, b: 2 }, ctx)).toBe(INVALID);
    const byPath = problems.list.map((p) => p.path.join('.'));
    expect(byPath).toContain('a');
    expect(byPath).toContain('b');
    expect(problems.list.length).toBeGreaterThanOrEqual(2);
  });
});

/** Assert a migrated SHAPE builds an Expr whose `.toJSON()` equals `from`'s. */
function equiv(cls: ExprClass, def: ExprDef): void {
  const shape = cls.SHAPE;
  expect(shape).toBeDefined();
  const p = new Problems();
  const built = shape!.check(def, { problems: p, registry });
  expect(built).not.toBe(INVALID);
  expect(built === INVALID ? null : built.toJSON()).toEqual(cls.from(def, registry).toJSON());
  expect(p.hasErrors).toBe(false);
}

const fieldRef = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
const lit1 = (value: string | number | boolean | null): ExprDef => ({ kind: 'literal', value });

describe('shape — C2 equivalence with `from`', () => {
  it('binary', () => equiv(BinaryExpr, { kind: 'binary', op: '+', left: lit1(1), right: lit1(2) }));

  it('unary', () => equiv(UnaryExpr, { kind: 'unary', op: '-', operand: lit1(5) }));

  it('is-null (with and without `not`)', () => {
    equiv(IsNullExpr, { kind: 'is-null', value: fieldRef('u', 'x') });
    equiv(IsNullExpr, { kind: 'is-null', value: fieldRef('u', 'x'), not: true });
  });

  it('between (with and without `not`)', () => {
    equiv(BetweenExpr, {
      kind: 'between',
      value: fieldRef('u', 'age'),
      lower: lit1(1),
      upper: lit1(9),
      not: true,
    });
    equiv(BetweenExpr, { kind: 'between', value: fieldRef('u', 'age'), lower: lit1(1), upper: lit1(9) });
  });

  it('in (list form, with and without `not`)', () => {
    equiv(InExpr, { kind: 'in', value: fieldRef('u', 'x'), in: [lit1(1), lit1(2)], not: true });
    equiv(InExpr, { kind: 'in', value: fieldRef('u', 'x'), in: [lit1(1), lit1(2)] });
  });

  it('case (with else)', () =>
    equiv(CaseExpr, {
      kind: 'case',
      branches: [{ when: lit1(true), then: lit1(1) }],
      else: lit1(0),
    }));

  it('aggregate (count(*) and sum with distinct)', () => {
    equiv(AggregateExpr, { kind: 'aggregate', function: 'count', args: {} });
    equiv(AggregateExpr, {
      kind: 'aggregate',
      function: 'sum',
      args: { value: fieldRef('u', 'total') },
      distinct: true,
    });
  });

  it('window (partitionBy + orderBy, one term with nulls one without)', () =>
    equiv(WindowExpr, {
      kind: 'window',
      function: 'rowNumber',
      args: {},
      partitionBy: [fieldRef('u', 'x')],
      orderBy: [
        { expr: fieldRef('u', 'y'), dir: 'asc', nulls: 'last' },
        { expr: fieldRef('u', 'z'), dir: 'desc' },
      ],
    }));

  it('window (bare — no partitionBy / orderBy)', () =>
    equiv(WindowExpr, { kind: 'window', function: 'rowNumber', args: {} }));

  it('function-call', () =>
    equiv(FunctionCallExpr, {
      kind: 'function-call',
      function: 'lower',
      args: { value: lit1('A') },
    }));

  it('array-op (single, list, and empty value forms)', () => {
    equiv(ArrayOpExpr, { kind: 'array-op', op: 'contains', target: fieldRef('u', 'tags'), value: lit1('x') });
    equiv(ArrayOpExpr, {
      kind: 'array-op',
      op: 'containsAny',
      target: fieldRef('u', 'tags'),
      value: [lit1('a'), lit1('b')],
    });
    equiv(ArrayOpExpr, { kind: 'array-op', op: 'isEmpty', target: fieldRef('u', 'tags') });
  });

  it('output', () => equiv(OutputRefExpr, { kind: 'output', name: 'total' }));

  it('excluded', () => equiv(ExcludedExpr, { kind: 'excluded', field: 'email' }));

  it('text-search (string query, param query, and whole-source)', () => {
    equiv(TextSearchExpr, { kind: 'text-search', source: 'u', field: 'bio', query: 'hello world' });
    equiv(TextSearchExpr, { kind: 'text-search', source: 'u', field: 'bio', query: { kind: 'param', name: 'q' } });
    equiv(TextSearchExpr, { kind: 'text-search', source: 'u', query: 'hi' });
  });

  it('text-score', () => {
    equiv(TextScoreExpr, { kind: 'text-score', source: 'u', field: 'bio', query: 'x' });
    equiv(TextScoreExpr, { kind: 'text-score', source: 'u', query: { kind: 'param', name: 'q' } });
  });
});

describe('shape — C2 malformations + accumulation', () => {
  it('binary: a bad op is a shape.enum at `op`', () => {
    const { problems } = mk();
    expect(
      BinaryExpr.SHAPE.check({ kind: 'binary', op: '^', left: lit1(1), right: lit1(2) }, { problems, registry }),
    ).toBe(INVALID);
    expect(problems.list[0]?.code).toBe('shape.enum');
    expect(problems.list[0]?.path).toEqual(['op']);
    expect(problems.list[0]?.message).toContain('an arithmetic operator');
  });

  it('in: the SUBQUERY form now dispatches through queryDefRef (C3)', () => {
    const { problems } = mk();
    const built = InExpr.SHAPE.check(
      {
        kind: 'in',
        value: fieldRef('u', 'id'),
        in: { kind: 'select', fields: [{ expr: fieldRef('o', 'userId') }], from: { kind: 'type', type: 'order' } },
      },
      { problems, registry },
    );
    expect(built).not.toBe(INVALID);
    expect(problems.hasErrors).toBe(false);
    // The built expr is the subquery form (no list; carries a query def).
    expect(built === INVALID ? null : built.subquery).toBeDefined();
    expect(built === INVALID ? null : built.list).toBeUndefined();
  });

  it('in: a bad list element is localized at its index', () => {
    const { problems } = mk();
    expect(
      InExpr.SHAPE.check({ kind: 'in', value: fieldRef('u', 'x'), in: [lit1(1), 5] }, { problems, registry }),
    ).toBe(INVALID);
    expect(problems.list.some((p) => p.path.join('.') === 'in.1' && p.code === 'shape.not-object')).toBe(true);
  });

  it('array-op: an invalid single `value` records a not-object at `value`', () => {
    // `value` is OPTIONAL, so `obj` records the problem yet still builds (the
    // slot is treated as absent → empty values) — matching the C1 `obj` design.
    const { problems } = mk();
    ArrayOpExpr.SHAPE.check(
      { kind: 'array-op', op: 'contains', target: fieldRef('u', 'tags'), value: 5 },
      { problems, registry },
    );
    expect(problems.list.some((p) => p.path.join('.') === 'value' && p.code === 'shape.not-object')).toBe(true);
  });

  it('text-search: a non-string / non-param query is rejected at `query`', () => {
    const { problems } = mk();
    expect(
      TextSearchExpr.SHAPE.check({ kind: 'text-search', source: 'u', query: 5 }, { problems, registry }),
    ).toBe(INVALID);
    expect(problems.list.some((p) => p.path.join('.') === 'query')).toBe(true);
  });

  it('case: ACCUMULATES two bad branches in one pass', () => {
    const { problems } = mk();
    const result = CaseExpr.SHAPE.check(
      {
        kind: 'case',
        branches: [
          { when: 1, then: { kind: 'param', name: 'a' } },
          { when: { kind: 'param', name: 'b' }, then: 2 },
        ],
      },
      { problems, registry },
    );
    expect(result).toBe(INVALID);
    const byPath = problems.list.map((p) => p.path.join('.'));
    expect(byPath).toContain('branches.0.when');
    expect(byPath).toContain('branches.1.then');
    expect(problems.list.length).toBeGreaterThanOrEqual(2);
  });

  it('aggregate: ACCUMULATES a bad function name AND a bad nested arg in one pass', () => {
    const { problems } = mk();
    const result = AggregateExpr.SHAPE.check(
      { kind: 'aggregate', function: 42, args: { value: 99 } },
      { problems, registry },
    );
    expect(result).toBe(INVALID);
    const byPath = problems.list.map((p) => ({ path: p.path.join('.'), code: p.code }));
    expect(byPath).toContainEqual({ path: 'function', code: 'shape.type' });
    expect(byPath).toContainEqual({ path: 'args.value', code: 'shape.not-object' });
    expect(problems.list.length).toBeGreaterThanOrEqual(2);
  });
});
