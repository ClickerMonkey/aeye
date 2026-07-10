/**
 * Ergonomic expression builder (`e.*`) — asserts each builder returns the exact
 * `Expr` subclass with the expected `.toJSON()`, that a built expr is directly
 * usable via `engine.exprToSQL` / `engine.evaluateExpr`, and that
 * `registry.parseExpr` is a pass-through for an already-built `Expr`.
 */
import { describe, it, expect } from 'vitest';
import {
  createRegistry,
  QueryEngine,
  PostgresDialect,
  Expr,
  e,
  // named exports (also usable directly)
  value,
  lit,
  param,
  ref,
  relJoin,
  output,
  excluded,
  filters,
  add,
  sub,
  mul,
  div,
  mod,
  neg,
  pos,
  eq,
  neq,
  lt,
  lte,
  gt,
  gte,
  like,
  notLike,
  ilike,
  and,
  or,
  not,
  isNull,
  notNull,
  between,
  notBetween,
  inList,
  notInList,
  inSubquery,
  notInSubquery,
  exists,
  notExists,
  contains,
  containsAny,
  containsAll,
  isEmpty,
  notEmpty,
  when,
  caseExpr,
  fn,
  agg,
  count,
  countStar,
  sum,
  avg,
  min,
  max,
  window,
  tableFn,
  subquery,
  textSearch,
  semantic,
  // Expr subclasses (for instanceof assertions)
  LiteralExpr,
  ParamExpr,
  FieldRefExpr,
  OutputRefExpr,
  ExcludedExpr,
  FiltersExpr,
  BinaryExpr,
  UnaryExpr,
  ComparisonExpr,
  LogicalExpr,
  IsNullExpr,
  BetweenExpr,
  InExpr,
  ExistsExpr,
  ArrayOpExpr,
  CaseExpr,
  AggregateExpr,
  WindowExpr,
  FunctionCallExpr,
  TabularFunctionCallExpr,
  SubqueryExpr,
  TextSearchExpr,
  SemanticExpr,
} from '../index';
import type { QueryDef } from '../schema';

/** A trivial single-field select used by the subquery / exists / in builders. */
const sub1: QueryDef = {
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
  from: { kind: 'type', type: 'user' },
};

describe('builder: leaves', () => {
  it('value / lit build LiteralExpr', () => {
    expect(value(true)).toBeInstanceOf(LiteralExpr);
    expect(value(true).toJSON()).toEqual({ kind: 'literal', value: true });
    expect(lit(3)).toBeInstanceOf(LiteralExpr);
    expect(lit(3).toJSON()).toEqual({ kind: 'literal', value: 3 });
  });

  it('param builds ParamExpr', () => {
    expect(param('p')).toBeInstanceOf(ParamExpr);
    expect(param('p').toJSON()).toEqual({ kind: 'param', name: 'p' });
  });

  it('ref builds FieldRefExpr', () => {
    expect(ref('task', 'done')).toBeInstanceOf(FieldRefExpr);
    expect(ref('task', 'done').toJSON()).toEqual({ kind: 'field-ref', source: 'task', field: 'done' });
  });

  it('relJoin builds a relation JoinDef (with and/joinType options)', () => {
    expect(relJoin('order', 'user', 'u')).toEqual({
      on: { kind: 'relation', source: 'order', field: 'user', as: 'u' },
    });
    expect(relJoin('order', 'user', 'u', { joinType: 'inner', and: eq(ref('u', 'id'), lit(1)) })).toEqual({
      on: { kind: 'relation', source: 'order', field: 'user', as: 'u' },
      and: { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'u', field: 'id' }, right: { kind: 'literal', value: 1 } },
      joinType: 'inner',
    });
  });

  it('output builds OutputRefExpr', () => {
    expect(output('col1')).toBeInstanceOf(OutputRefExpr);
    expect(output('col1').toJSON()).toEqual({ kind: 'output', name: 'col1' });
  });

  it('excluded builds ExcludedExpr', () => {
    expect(excluded('email')).toBeInstanceOf(ExcludedExpr);
    expect(excluded('email').toJSON()).toEqual({ kind: 'excluded', field: 'email' });
  });

  it('filters builds FiltersExpr with and without a field allowlist', () => {
    expect(filters('user')).toBeInstanceOf(FiltersExpr);
    expect(filters('user').toJSON()).toEqual({ kind: 'filters', source: 'user' });
    expect(filters('user', ['age']).toJSON()).toEqual({ kind: 'filters', source: 'user', fields: ['age'] });
  });
});

describe('builder: arithmetic', () => {
  const l = value(6);
  const r = value(2);
  it('add / sub / mul / div / mod build BinaryExpr', () => {
    for (const [b, op] of [
      [add(l, r), '+'],
      [sub(l, r), '-'],
      [mul(l, r), '*'],
      [div(l, r), '/'],
      [mod(l, r), '%'],
    ] as const) {
      expect(b).toBeInstanceOf(BinaryExpr);
      expect(b.toJSON()).toEqual({ kind: 'binary', op, left: l.toJSON(), right: r.toJSON() });
    }
  });

  it('neg / pos build UnaryExpr', () => {
    expect(neg(l)).toBeInstanceOf(UnaryExpr);
    expect(neg(l).toJSON()).toEqual({ kind: 'unary', op: '-', operand: l.toJSON() });
    expect(pos(l)).toBeInstanceOf(UnaryExpr);
    expect(pos(l).toJSON()).toEqual({ kind: 'unary', op: '+', operand: l.toJSON() });
  });
});

describe('builder: comparison', () => {
  const l = ref('t', 'a');
  const r = value(1);
  it('all comparison ops build ComparisonExpr with the right op', () => {
    for (const [b, op] of [
      [eq(l, r), '='],
      [neq(l, r), '<>'],
      [lt(l, r), '<'],
      [lte(l, r), '<='],
      [gt(l, r), '>'],
      [gte(l, r), '>='],
      [like(l, r), 'like'],
      [notLike(l, r), 'notLike'],
      [ilike(l, r), 'ilike'],
    ] as const) {
      expect(b).toBeInstanceOf(ComparisonExpr);
      expect(b.toJSON()).toEqual({ kind: 'comparison', op, left: l.toJSON(), right: r.toJSON() });
    }
  });
});

describe('builder: logical', () => {
  const a = eq(ref('t', 'a'), value(1));
  const b = gt(ref('t', 'b'), value(0));
  it('and / or are variadic → operands array', () => {
    expect(and(a, b)).toBeInstanceOf(LogicalExpr);
    expect(and(a, b).toJSON()).toEqual({ kind: 'logical', op: 'and', operands: [a.toJSON(), b.toJSON()] });
    expect(or(a, b).toJSON()).toEqual({ kind: 'logical', op: 'or', operands: [a.toJSON(), b.toJSON()] });
  });

  it('not wraps a single operand', () => {
    expect(not(a)).toBeInstanceOf(LogicalExpr);
    expect(not(a).toJSON()).toEqual({ kind: 'logical', op: 'not', operands: [a.toJSON()] });
  });
});

describe('builder: predicates', () => {
  const v = ref('t', 'a');
  it('isNull / notNull build IsNullExpr', () => {
    expect(isNull(v)).toBeInstanceOf(IsNullExpr);
    expect(isNull(v).toJSON()).toEqual({ kind: 'is-null', value: v.toJSON() });
    expect(notNull(v).toJSON()).toEqual({ kind: 'is-null', value: v.toJSON(), not: true });
  });

  it('between / notBetween build BetweenExpr', () => {
    const lo = value(1);
    const hi = value(9);
    expect(between(v, lo, hi)).toBeInstanceOf(BetweenExpr);
    expect(between(v, lo, hi).toJSON()).toEqual({
      kind: 'between',
      value: v.toJSON(),
      lower: lo.toJSON(),
      upper: hi.toJSON(),
    });
    expect(notBetween(v, lo, hi).toJSON()).toMatchObject({ kind: 'between', not: true });
  });

  it('inList / notInList accept Exprs and raw scalars', () => {
    expect(inList(v, [value(1), 2, 'x'])).toBeInstanceOf(InExpr);
    expect(inList(v, [value(1), 2, 'x']).toJSON()).toEqual({
      kind: 'in',
      value: v.toJSON(),
      in: [
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 2 },
        { kind: 'literal', value: 'x' },
      ],
    });
    expect(notInList(v, [1]).toJSON()).toMatchObject({ kind: 'in', not: true });
  });

  it('inSubquery / notInSubquery build InExpr over a QueryDef', () => {
    expect(inSubquery(v, sub1)).toBeInstanceOf(InExpr);
    expect(inSubquery(v, sub1).toJSON()).toEqual({ kind: 'in', value: v.toJSON(), in: sub1 });
    expect(notInSubquery(v, sub1).toJSON()).toMatchObject({ kind: 'in', not: true });
  });

  it('exists / notExists build ExistsExpr', () => {
    expect(exists(sub1)).toBeInstanceOf(ExistsExpr);
    expect(exists(sub1).toJSON()).toEqual({ kind: 'exists', query: sub1 });
    expect(notExists(sub1).toJSON()).toEqual({ kind: 'exists', query: sub1, not: true });
  });
});

describe('builder: array predicates', () => {
  const target = ref('t', 'tags');
  it('contains builds a single-value ArrayOpExpr', () => {
    expect(contains(target, value('x'))).toBeInstanceOf(ArrayOpExpr);
    expect(contains(target, value('x')).toJSON()).toEqual({
      kind: 'array-op',
      op: 'contains',
      target: target.toJSON(),
      value: { kind: 'literal', value: 'x' },
    });
  });

  it('containsAny / containsAll build a list ArrayOpExpr', () => {
    expect(containsAny(target, [value('a'), value('b')]).toJSON()).toMatchObject({ op: 'containsAny' });
    expect(containsAll(target, [value('a')]).toJSON()).toMatchObject({ op: 'containsAll' });
  });

  it('isEmpty / notEmpty omit the value', () => {
    expect(isEmpty(target).toJSON()).toEqual({ kind: 'array-op', op: 'isEmpty', target: target.toJSON() });
    expect(notEmpty(target).toJSON()).toEqual({ kind: 'array-op', op: 'notEmpty', target: target.toJSON() });
  });
});

describe('builder: case', () => {
  it('when builds a branch spec; case builds CaseExpr with / without else', () => {
    const branch = when(eq(ref('t', 'a'), value(1)), value('one'));
    expect(branch).toEqual({ when: eq(ref('t', 'a'), value(1)), then: value('one') });
    const withElse = caseExpr([branch], value('other'));
    expect(withElse).toBeInstanceOf(CaseExpr);
    expect(withElse.toJSON()).toEqual({
      kind: 'case',
      branches: [{ when: branch.when.toJSON(), then: branch.then.toJSON() }],
      else: { kind: 'literal', value: 'other' },
    });
    const noElse = caseExpr([branch]);
    expect(noElse.toJSON()).toEqual({
      kind: 'case',
      branches: [{ when: branch.when.toJSON(), then: branch.then.toJSON() }],
    });
    // `e.case` is the same builder.
    expect(e.case([branch]).toJSON()).toEqual(noElse.toJSON());
  });
});

describe('builder: calls', () => {
  it('fn builds FunctionCallExpr (with and without args)', () => {
    expect(fn('lower', { value: ref('t', 'name') })).toBeInstanceOf(FunctionCallExpr);
    expect(fn('lower', { value: ref('t', 'name') }).toJSON()).toEqual({
      kind: 'function-call',
      function: 'lower',
      args: { value: { kind: 'field-ref', source: 't', field: 'name' } },
    });
    expect(fn('now').toJSON()).toEqual({ kind: 'function-call', function: 'now', args: {} });
  });

  it('agg builds AggregateExpr, honoring distinct', () => {
    expect(agg('sum', { value: ref('t', 'x') })).toBeInstanceOf(AggregateExpr);
    expect(agg('sum', { value: ref('t', 'x') }).toJSON()).toEqual({
      kind: 'aggregate',
      function: 'sum',
      args: { value: { kind: 'field-ref', source: 't', field: 'x' } },
    });
    expect(agg('count', {}, true).toJSON()).toMatchObject({ kind: 'aggregate', distinct: true });
  });

  it('count / countStar build AggregateExpr', () => {
    expect(count(ref('t', 'x')).toJSON()).toEqual({
      kind: 'aggregate',
      function: 'count',
      args: { value: { kind: 'field-ref', source: 't', field: 'x' } },
    });
    expect(count().toJSON()).toEqual({ kind: 'aggregate', function: 'count', args: {} });
    expect(countStar().toJSON()).toEqual({ kind: 'aggregate', function: 'count', args: {} });
  });

  it('sum / avg / min / max build AggregateExpr', () => {
    const x = ref('t', 'x');
    for (const [b, name] of [
      [sum(x), 'sum'],
      [avg(x), 'avg'],
      [min(x), 'min'],
      [max(x), 'max'],
    ] as const) {
      expect(b).toBeInstanceOf(AggregateExpr);
      expect(b.toJSON()).toEqual({ kind: 'aggregate', function: name, args: { value: x.toJSON() } });
    }
  });

  it('window builds WindowExpr (with and without opts)', () => {
    const w = window('rank');
    expect(w).toBeInstanceOf(WindowExpr);
    expect(w.toJSON()).toEqual({ kind: 'window', function: 'rank', args: {} });
    const w2 = window('sum', {
      args: { value: ref('t', 'x') },
      partitionBy: [ref('t', 'g')],
      orderBy: [{ expr: ref('t', 'k'), dir: 'asc' }],
    });
    expect(w2.toJSON()).toEqual({
      kind: 'window',
      function: 'sum',
      args: { value: { kind: 'field-ref', source: 't', field: 'x' } },
      partitionBy: [{ kind: 'field-ref', source: 't', field: 'g' }],
      orderBy: [{ expr: { kind: 'field-ref', source: 't', field: 'k' }, dir: 'asc' }],
    });
  });

  it('tableFn builds TabularFunctionCallExpr', () => {
    expect(tableFn('generate_series', { start: value(1), stop: value(9) })).toBeInstanceOf(
      TabularFunctionCallExpr,
    );
    expect(tableFn('unnest').toJSON()).toEqual({ kind: 'tabular-function-call', function: 'unnest', args: {} });
  });
});

describe('builder: query-embedding & search', () => {
  it('subquery builds SubqueryExpr', () => {
    expect(subquery(sub1)).toBeInstanceOf(SubqueryExpr);
    expect(subquery(sub1).toJSON()).toEqual({ kind: 'subquery', query: sub1 });
  });

  it('textSearch builds TextSearchExpr from a literal or a param', () => {
    expect(textSearch('user', 'ada')).toBeInstanceOf(TextSearchExpr);
    expect(textSearch('user', 'ada').toJSON()).toEqual({ kind: 'text-search', source: 'user', query: 'ada' });
    expect(textSearch('user', param('q'), 'email').toJSON()).toEqual({
      kind: 'text-search',
      source: 'user',
      field: 'email',
      query: { kind: 'param', name: 'q' },
    });
  });

  it('semantic builds SemanticExpr from a string, a param, or a TypeFieldRef', () => {
    expect(semantic('user', 'sci-fi')).toBeInstanceOf(SemanticExpr);
    expect(semantic('user', 'sci-fi').toJSON()).toEqual({ kind: 'semantic', source: 'user', query: 'sci-fi' });
    expect(semantic('user', param('q'), 'bio').toJSON()).toEqual({
      kind: 'semantic',
      source: 'user',
      field: 'bio',
      query: { kind: 'param', name: 'q' },
    });
    expect(semantic('user', { type: 'book', field: 'blurb' }).toJSON()).toEqual({
      kind: 'semantic',
      source: 'user',
      query: { type: 'book', field: 'blurb' },
    });
  });
});

describe('builder: e namespace mirrors named exports', () => {
  it('e.* references the same builder functions', () => {
    expect(e.eq).toBe(eq);
    expect(e.and).toBe(and);
    expect(e.value).toBe(value);
    expect(e.case).toBe(caseExpr);
    // the headline example composes cleanly
    const cond = e.and(e.eq(e.ref('task', 'done'), e.value(true)), e.gt(e.ref('task', 'hours'), e.value(0)));
    expect(cond).toBeInstanceOf(LogicalExpr);
  });
});

describe('registry.parseExpr pass-through', () => {
  it('returns an already-built Expr unchanged', () => {
    const registry = createRegistry();
    const built = eq(ref('t', 'a'), value(1));
    expect(registry.parseExpr(built)).toBe(built);
    expect(registry.parseExpr(built)).toBeInstanceOf(Expr);
  });

  it('still parses a raw ExprDef', () => {
    const registry = createRegistry();
    const parsed = registry.parseExpr({ kind: 'literal', value: 7 });
    expect(parsed).toBeInstanceOf(LiteralExpr);
    expect(parsed.toJSON()).toEqual({ kind: 'literal', value: 7 });
  });
});

describe('engine.exprToSQL', () => {
  const engine = new QueryEngine(createRegistry());

  it('emits a built expr for a named dialect with bound params', () => {
    const cond = and(eq(ref('task', 'done'), value(true)), gt(ref('task', 'hours'), value(0)));
    const pg = engine.exprToSQL(cond, 'postgres');
    expect(pg.sql).toBe('("task"."done" = $1 AND "task"."hours" > $2)');
    expect(pg.params).toEqual([true, 0]);
    const base = engine.exprToSQL(cond, 'base');
    expect(base.sql).toBe('("task"."done" = ? AND "task"."hours" > ?)');
  });

  it('accepts a Dialect instance and a raw ExprDef', () => {
    const rendered = engine.exprToSQL({ kind: 'literal', value: 5 }, new PostgresDialect());
    expect(rendered.sql).toBe('$1');
    expect(rendered.params).toEqual([5]);
  });

  it('binds a param value supplied via opts.params', () => {
    const rendered = engine.exprToSQL(eq(ref('t', 'a'), param('p')), 'postgres', { params: { p: 42 } });
    expect(rendered.params).toContain(42);
  });

  it('throws on an unknown dialect', () => {
    expect(() => engine.exprToSQL(value(1), 'nope')).toThrow(/unknown dialect/);
  });
});

describe('engine.evaluateExpr', () => {
  const engine = new QueryEngine(createRegistry());

  it('evaluates a constant predicate with the default empty row', async () => {
    expect((await engine.evaluateExpr(eq(value(1), value(1)))).raw).toBe(true);
    expect((await engine.evaluateExpr(add(value(2), value(3)))).raw).toBe(5);
  });

  it('evaluates a field reference against a supplied row', async () => {
    const v = await engine.evaluateExpr(gt(ref('task', 'hours'), value(0)), { task: { hours: 5 } });
    expect(v.raw).toBe(true);
  });

  it('parses a raw ExprDef and honors bound params', async () => {
    const v = await engine.evaluateExpr({ kind: 'param', name: 'n' }, {}, { params: { n: 9 } });
    expect(v.raw).toBe(9);
  });
});
