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
  exprRef,
  obj,
  type CheckCtx,
} from '../shape';
import { ComparisonExpr } from '../exprs/comparison';
import { FieldRefExpr } from '../exprs/field-ref';
import { LiteralExpr } from '../exprs/literal';
import { ParamExpr } from '../exprs/param';
import { LogicalExpr } from '../exprs/logical';

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
