/**
 * C3 coverage for the owned, zod-free STRUCTURAL PARSER extended to the WHOLE
 * query tree: the `queryRef` / `queryDefRef` / `sourceRef` combinators, the
 * `Registry.parseCheckedQuery` / `parseCheckedSource` dispatches, every migrated
 * QUERY kind + SOURCE kind `static SHAPE`, and the 6 exprs C2 deferred
 * (`subquery` / `exists` / `in`-subquery / `semantic` / `tabular-function-call`
 * / `filters`).
 *
 * For each: equivalence (`SHAPE.check(def).toJSON()` == the throwing parser's
 * `.toJSON()`), malformations localized at their path, and accumulation
 * (multiple problems in ONE pass). Plus an END-TO-END parse of a complex SELECT
 * and a multi-clause accumulated-problems SELECT.
 */
import { describe, it, expect } from 'vitest';
import { Problems } from '../problem';
import { createRegistry } from '../registry';
import type { ExprDef, QueryDef, SourceDef } from '../schema';
import { INVALID, type CheckCtx } from '../shape';
import { SelectQuery } from '../queries/select';
import { InsertQuery } from '../queries/insert';
import { UpdateQuery } from '../queries/update';
import { DeleteQuery } from '../queries/delete';
import { SetOperationQuery } from '../queries/set-operation';
import { CTEStatementQuery } from '../queries/cte';
import { ExprQuery } from '../queries/expr-query';
import { QuerySource } from '../queries/source';
import { QueryOrder } from '../queries/order';
import { QueryJoin } from '../queries/join';
import { SubqueryExpr } from '../exprs/subquery';
import { ExistsExpr } from '../exprs/exists';
import { InExpr } from '../exprs/in';
import { SemanticExpr } from '../exprs/semantic';
import { TabularFunctionCallExpr } from '../exprs/tabular-function-call';
import { FiltersExpr } from '../exprs/filters';

const registry = createRegistry();
function mk(): { ctx: CheckCtx; problems: Problems } {
  const problems = new Problems();
  return { ctx: { problems, registry }, problems };
}

const fieldRef = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
const lit1 = (value: string | number | boolean | null): ExprDef => ({ kind: 'literal', value });
const typeSource = (type: string): SourceDef => ({ kind: 'type', type });

/** A minimal, already-canonical select def (round-trips through toJSON unchanged). */
const canonicalSelect = (source: string, field: string, type: string): QueryDef => ({
  kind: 'select',
  fields: [{ expr: fieldRef(source, field) }],
  from: typeSource(type),
});

// ─────────────────────────────────────────────────────────────────────────────
// New combinators + dispatches
// ─────────────────────────────────────────────────────────────────────────────

describe('registry.parseCheckedQuery — defensive dispatch', () => {
  it('rejects a non-object (with and without a got-tail)', () => {
    const p1 = new Problems();
    expect(registry.parseCheckedQuery(5, p1)).toBeUndefined();
    expect(p1.list[0]?.code).toBe('shape.not-object');
    expect(p1.list[0]?.message).toContain('got a number');
    const p2 = new Problems();
    expect(registry.parseCheckedQuery(undefined, p2)).toBeUndefined();
    expect(p2.list[0]?.message).toBe('expected a query');
  });

  it('rejects a missing / non-string kind', () => {
    const p = new Problems();
    expect(registry.parseCheckedQuery({ fields: [] }, p)).toBeUndefined();
    expect(p.list[0]?.code).toBe('shape.missing-kind');
  });

  it('rejects an unknown kind with a didYouMean over real query kinds', () => {
    const near = new Problems();
    expect(registry.parseCheckedQuery({ kind: 'selct' }, near)).toBeUndefined();
    expect(near.list[0]?.code).toBe('shape.unknown-kind');
    expect(near.list[0]?.message).toContain('did you mean `select`?');
    expect(near.list[0]?.message).toContain('available:');
    const far = new Problems();
    registry.parseCheckedQuery({ kind: 'zzzzzzzz' }, far);
    expect(far.list[0]?.message).not.toContain('did you mean');
  });

  it('dispatches a valid def to its owned SHAPE', () => {
    const p = new Problems();
    const built = registry.parseCheckedQuery(canonicalSelect('u', 'id', 'user'), p);
    expect(built).toBeInstanceOf(SelectQuery);
    expect(p.list).toHaveLength(0);
  });

  it('returns undefined when the SHAPE reports a problem', () => {
    const p = new Problems();
    expect(registry.parseCheckedQuery({ kind: 'select', fields: 'nope', from: typeSource('user') }, p)).toBeUndefined();
    expect(p.hasErrors).toBe(true);
  });
});

describe('registry.parseCheckedSource — defensive dispatch', () => {
  it('rejects a non-object (with and without a got-tail)', () => {
    const p1 = new Problems();
    expect(registry.parseCheckedSource('x', p1)).toBeUndefined();
    expect(p1.list[0]?.code).toBe('shape.not-object');
    expect(p1.list[0]?.message).toContain('got a string');
    const p2 = new Problems();
    expect(registry.parseCheckedSource(undefined, p2)).toBeUndefined();
    expect(p2.list[0]?.message).toBe('expected a query source');
  });

  it('rejects a missing / non-string kind', () => {
    const p = new Problems();
    expect(registry.parseCheckedSource({ type: 'user' }, p)).toBeUndefined();
    expect(p.list[0]?.code).toBe('shape.missing-kind');
  });

  it('rejects an unknown kind with a didYouMean over source kinds', () => {
    const near = new Problems();
    expect(registry.parseCheckedSource({ kind: 'subquerry' }, near)).toBeUndefined();
    expect(near.list[0]?.code).toBe('shape.unknown-kind');
    expect(near.list[0]?.message).toContain('did you mean `subquery`?');
    const far = new Problems();
    registry.parseCheckedSource({ kind: 'zzzzzzzz' }, far);
    expect(far.list[0]?.message).not.toContain('did you mean');
  });

  it('dispatches a valid def to its owned SHAPE and returns undefined on a problem', () => {
    const ok = new Problems();
    expect(registry.parseCheckedSource(typeSource('user'), ok)).toBeInstanceOf(QuerySource);
    const bad = new Problems();
    expect(registry.parseCheckedSource({ kind: 'type' }, bad)).toBeUndefined();
    expect(bad.list[0]?.code).toBe('shape.required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source kinds
// ─────────────────────────────────────────────────────────────────────────────

/** Assert a source SHAPE builds a QuerySource whose toJSON equals `from`'s. */
function equivSource(def: SourceDef): void {
  const p = new Problems();
  const built = registry.parseCheckedSource(def, p);
  expect(built).not.toBeUndefined();
  expect(p.hasErrors).toBe(false);
  expect(built?.toJSON()).toEqual(QuerySource.from(def, registry).toJSON());
}

describe('source kinds — equivalence + malformation', () => {
  it('type source', () => equivSource(typeSource('user')));
  it('aliased source', () => equivSource({ kind: 'aliased', type: 'user', as: 'u2' }));
  it('subquery source', () =>
    equivSource({ kind: 'subquery', as: 'sub', query: canonicalSelect('u', 'id', 'user') }));
  it('function source', () =>
    equivSource({ kind: 'function', function: 'unnest', args: { value: lit1(1) }, as: 'r' }));

  it('subquery source with a bad inner query localizes under `query`', () => {
    const p = new Problems();
    expect(
      registry.parseCheckedSource({ kind: 'subquery', as: 's', query: { kind: 'select', fields: 5, from: typeSource('user') } }, p),
    ).toBeUndefined();
    expect(p.list.some((pr) => pr.path.join('.') === 'query.fields')).toBe(true);
  });

  it('function source with a bad arg localizes under `args`', () => {
    const p = new Problems();
    expect(
      registry.parseCheckedSource({ kind: 'function', function: 'f', args: { value: 5 }, as: 'r' }, p),
    ).toBeUndefined();
    expect(p.list.some((pr) => pr.path.join('.') === 'args.value')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Order + Join building blocks
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryOrder.SHAPE', () => {
  it('equivalent to from (with and without nulls)', () => {
    for (const def of [
      { expr: fieldRef('u', 'x'), dir: 'asc' as const, nulls: 'last' as const },
      { expr: fieldRef('u', 'y'), dir: 'desc' as const },
    ]) {
      const p = new Problems();
      const built = QueryOrder.SHAPE.check(def, { problems: p, registry });
      expect(built === INVALID ? null : built.toJSON()).toEqual(QueryOrder.from(def, registry).toJSON());
    }
  });

  it('a bad dir is a shape.enum at `dir`', () => {
    const { ctx, problems } = mk();
    expect(QueryOrder.SHAPE.check({ expr: fieldRef('u', 'x'), dir: 'up' }, ctx)).toBe(INVALID);
    expect(problems.list[0]?.code).toBe('shape.enum');
    expect(problems.list[0]?.path).toEqual(['dir']);
  });
});

describe('QueryJoin.SHAPE', () => {
  it('equivalent to from (bare relation `on`, and with and/joinType)', () => {
    for (const def of [
      { on: { kind: 'relation' as const, source: 'user', field: 'orders', as: 'o' } },
      {
        on: { kind: 'relation' as const, source: 'user', field: 'orders', as: 'o2' },
        and: { kind: 'comparison' as const, op: '>' as const, left: fieldRef('o2', 'total'), right: lit1(0) },
        joinType: 'inner' as const,
      },
    ]) {
      const p = new Problems();
      const built = QueryJoin.SHAPE.check(def, { problems: p, registry });
      expect(built === INVALID ? null : built.toJSON()).toEqual(QueryJoin.from(def, registry).toJSON());
    }
  });

  it('a non-string on.source localizes under on.source', () => {
    const { ctx, problems } = mk();
    expect(QueryJoin.SHAPE.check({ on: { kind: 'relation', source: 5, field: 'orders', as: 'x' } }, ctx)).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'on.source')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Query kinds — equivalence + malformation + accumulation
// ─────────────────────────────────────────────────────────────────────────────

/** Assert a query SHAPE builds a Query whose toJSON equals the throwing parser's. */
function equivQuery(def: QueryDef): void {
  const p = new Problems();
  const built = registry.parseCheckedQuery(def, p);
  expect(built).not.toBeUndefined();
  expect(p.hasErrors).toBe(false);
  expect(built?.toJSON()).toEqual(registry.parseQuery(def).toJSON());
}

describe('query kinds — equivalence with the throwing parser', () => {
  it('select (complex: joins + where + groupBy + having + order + limit + subquery + aggregate)', () =>
    equivQuery({
      kind: 'select',
      distinct: true,
      fields: [
        { expr: fieldRef('user', 'id') },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: typeSource('user'),
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
      where: [
        { kind: 'comparison', op: '>', left: fieldRef('order', 'total'), right: lit1(0) },
        { kind: 'in', value: fieldRef('user', 'id'), in: canonicalSelect('o', 'userId', 'order') },
      ],
      groupBy: [fieldRef('user', 'id')],
      having: [{ kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'count', args: {} }, right: lit1(1) }],
      order: [{ expr: fieldRef('user', 'id'), dir: 'asc' }],
      limit: 10,
      offset: { kind: 'param', name: 'skip' },
    }));

  it('insert (rows + onConflict update + returning)', () =>
    equivQuery({
      kind: 'insert',
      into: 'user',
      rows: [{ id: lit1(1), name: lit1('a') }, { id: lit1(2), name: lit1('b') }],
      onConflict: { fields: ['id'], update: { name: { kind: 'excluded', field: 'name' } } },
      returning: [{ expr: fieldRef('user', 'id') }],
    }));

  it('insert (select form, doNothing)', () =>
    equivQuery({
      kind: 'insert',
      into: 'user',
      select: canonicalSelect('u', 'id', 'user'),
      onConflict: { fields: ['id'], doNothing: true },
    }));

  it('update (set + joins + where + returning)', () =>
    equivQuery({
      kind: 'update',
      type: 'user',
      set: { name: lit1('x') },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
      where: [{ kind: 'comparison', op: '=', left: fieldRef('user', 'id'), right: lit1(1) }],
      returning: [{ expr: fieldRef('user', 'id') }],
    }));

  it('update (bare — set only, no joins/where/returning)', () =>
    equivQuery({ kind: 'update', type: 'user', set: { name: lit1('x') } }));

  it('set-operation (bare — no all/order/limit/offset)', () =>
    equivQuery({ kind: 'union', left: canonicalSelect('u', 'id', 'user'), right: canonicalSelect('o', 'userId', 'order') }));

  it('delete (where + returning)', () =>
    equivQuery({
      kind: 'delete',
      from: 'user',
      where: [{ kind: 'comparison', op: '=', left: fieldRef('user', 'id'), right: lit1(1) }],
      returning: [{ expr: fieldRef('user', 'id') }],
    }));

  it('set-operation (union / intersect / except, all + order + limit)', () => {
    for (const kind of ['union', 'intersect', 'except'] as const) {
      equivQuery({
        kind,
        left: canonicalSelect('u', 'id', 'user'),
        right: canonicalSelect('o', 'userId', 'order'),
        all: true,
        order: [{ expr: fieldRef('x', 'id'), dir: 'asc' }],
        limit: 5,
      });
    }
  });

  it('cte (plain + recursive entries + final)', () =>
    equivQuery({
      kind: 'cte',
      ctes: [
        { name: 'a', query: canonicalSelect('u', 'id', 'user') },
        { name: 'b', base: canonicalSelect('u', 'id', 'user'), recursive: canonicalSelect('o', 'userId', 'order') },
      ],
      final: canonicalSelect('a', 'id', 'a'),
    }));

  it('expr query', () => equivQuery({ kind: 'expr', expr: { kind: 'binary', op: '+', left: lit1(1), right: lit1(2) } }));
});

describe('query kinds — malformation + accumulation', () => {
  it('select: a bad `from` source is localized under `from`', () => {
    const { ctx, problems } = mk();
    expect(SelectQuery.SHAPE.check({ kind: 'select', fields: [], from: 5 }, ctx)).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'from' && pr.code === 'shape.not-object')).toBe(true);
  });

  it('insert: onConflict update value is localized', () => {
    const { ctx, problems } = mk();
    // A raw scalar is a valid write value, so a BAD value must be a malformed
    // expr (unknown kind) — localized at its field key under `onConflict.update`.
    InsertQuery.SHAPE.check(
      { kind: 'insert', into: 'user', rows: [{ id: lit1(1) }], onConflict: { fields: ['id'], update: { name: { kind: 'bogus' } } } },
      ctx,
    );
    expect(problems.list.some((pr) => pr.path.join('.') === 'onConflict.update.name')).toBe(true);
  });

  it('update: a missing `set` and a bad `type` accumulate in one pass', () => {
    const { ctx, problems } = mk();
    expect(UpdateQuery.SHAPE.check({ kind: 'update', type: 5 }, ctx)).toBe(INVALID);
    const byPath = problems.list.map((pr) => ({ path: pr.path.join('.'), code: pr.code }));
    expect(byPath).toContainEqual({ path: 'type', code: 'shape.type' });
    expect(byPath).toContainEqual({ path: 'set', code: 'shape.required' });
  });

  it('delete: a bad WHERE element is localized at its index', () => {
    const { ctx, problems } = mk();
    DeleteQuery.SHAPE.check({ kind: 'delete', from: 'user', where: [fieldRef('u', 'x'), 5] }, ctx);
    expect(problems.list.some((pr) => pr.path.join('.') === 'where.1' && pr.code === 'shape.not-object')).toBe(true);
  });

  it('set-operation: a bad arm is localized under `left`', () => {
    const { ctx, problems } = mk();
    expect(
      SetOperationQuery.SHAPE_UNION.check({ kind: 'union', left: 5, right: canonicalSelect('o', 'userId', 'order') }, ctx),
    ).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'left' && pr.code === 'shape.not-object')).toBe(true);
  });

  it('cte: a recursive-entry bad arm is localized', () => {
    const { ctx, problems } = mk();
    CTEStatementQuery.SHAPE.check(
      { kind: 'cte', ctes: [{ name: 'r', base: 5, recursive: canonicalSelect('u', 'id', 'user') }], final: canonicalSelect('u', 'id', 'user') },
      ctx,
    );
    expect(problems.list.some((pr) => pr.path.join('.') === 'ctes.0.base')).toBe(true);
  });

  it('expr query: a bad expr is localized under `expr`', () => {
    const { ctx, problems } = mk();
    expect(ExprQuery.SHAPE.check({ kind: 'expr', expr: 5 }, ctx)).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'expr')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boundShape (limit / offset)
// ─────────────────────────────────────────────────────────────────────────────

describe('boundShape (limit / offset)', () => {
  it('accepts a literal number and a param def', () => {
    equivQuery({ kind: 'select', fields: [{ expr: fieldRef('u', 'id') }], from: typeSource('user'), limit: 7 });
    equivQuery({
      kind: 'select',
      fields: [{ expr: fieldRef('u', 'id') }],
      from: typeSource('user'),
      offset: { kind: 'param', name: 'skip' },
    });
  });

  it('records a non-number / non-param bound (directed Limit message)', () => {
    // `limit` is OPTIONAL, so `obj` records the problem yet still builds (the
    // slot is treated as absent) — matching the C1 `obj` design.
    const { ctx, problems } = mk();
    SelectQuery.SHAPE.check({ kind: 'select', fields: [], from: typeSource('user'), limit: 'x' }, ctx);
    expect(problems.list.some((pr) => pr.path.join('.') === 'limit' && pr.message.includes('a number or a param'))).toBe(true);
  });

  it('records a malformed param bound (missing name)', () => {
    const { ctx, problems } = mk();
    SelectQuery.SHAPE.check({ kind: 'select', fields: [], from: typeSource('user'), limit: { kind: 'param' } }, ctx);
    expect(problems.list.some((pr) => pr.path.join('.') === 'limit.name')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The 6 deferred exprs
// ─────────────────────────────────────────────────────────────────────────────

/** Assert an expr SHAPE builds an Expr whose toJSON equals `from`'s (canonical defs). */
function equivExpr(def: ExprDef): void {
  const p = new Problems();
  const built = registry.parseCheckedExpr(def, p);
  expect(built).not.toBeUndefined();
  expect(p.hasErrors).toBe(false);
  expect(built?.toJSON()).toEqual(registry.parseExpr(def).toJSON());
}

describe('deferred exprs — equivalence with `from`', () => {
  it('subquery', () => equivExpr({ kind: 'subquery', query: canonicalSelect('u', 'id', 'user') }));

  it('exists (with and without not)', () => {
    equivExpr({ kind: 'exists', query: canonicalSelect('u', 'id', 'user') });
    equivExpr({ kind: 'exists', query: canonicalSelect('u', 'id', 'user'), not: true });
  });

  it('in — subquery form (with and without not)', () => {
    equivExpr({ kind: 'in', value: fieldRef('u', 'id'), in: canonicalSelect('o', 'userId', 'order') });
    equivExpr({ kind: 'in', value: fieldRef('u', 'id'), in: canonicalSelect('o', 'userId', 'order'), not: true });
  });

  it('semantic — text / param / sourceField / typeField queries', () => {
    equivExpr({ kind: 'semantic', source: 'doc', query: 'hello world' });
    equivExpr({ kind: 'semantic', source: 'doc', field: 'body', query: { kind: 'param', name: 'q' } });
    equivExpr({ kind: 'semantic', source: 'a', field: 'body', query: { source: 'b', field: 'body' } });
    equivExpr({ kind: 'semantic', source: 'a', field: 'body', query: { type: 'doc', field: 'body' } });
  });

  it('tabular-function-call', () =>
    equivExpr({ kind: 'tabular-function-call', function: 'unnest', args: { value: lit1(1) } }));

  it('filters (with and without fields)', () => {
    equivExpr({ kind: 'filters', source: 'user' });
    equivExpr({ kind: 'filters', source: 'user', fields: ['id', 'name'] });
  });
});

describe('deferred exprs — malformation', () => {
  it('subquery: a bad inner query surfaces its problem and returns undefined', () => {
    const p = new Problems();
    expect(registry.parseCheckedExpr({ kind: 'subquery', query: { kind: 'select', from: typeSource('user') } }, p)).toBeUndefined();
    // missing required `fields` on the inner select
    expect(p.list.some((pr) => pr.path.join('.') === 'query.fields' && pr.code === 'shape.required')).toBe(true);
  });

  it('exists: a non-object query is localized under `query`', () => {
    const { ctx, problems } = mk();
    expect(ExistsExpr.SHAPE.check({ kind: 'exists', query: 5 }, ctx)).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'query' && pr.code === 'shape.not-object')).toBe(true);
  });

  it('in-subquery: a bad subquery is localized under `in`', () => {
    const { ctx, problems } = mk();
    InExpr.SHAPE.check({ kind: 'in', value: fieldRef('u', 'id'), in: { kind: 'select', from: typeSource('user') } }, ctx);
    expect(problems.list.some((pr) => pr.path.join('.') === 'in.fields')).toBe(true);
  });

  it('semantic: an invalid param query returns INVALID', () => {
    const { ctx, problems } = mk();
    expect(SemanticExpr.SHAPE.check({ kind: 'semantic', source: 'doc', query: { kind: 'param' } }, ctx)).toBe(INVALID);
    expect(problems.hasErrors).toBe(true);
  });

  it('semantic: a numeric query is a directed shape.type at `query`', () => {
    const { ctx, problems } = mk();
    expect(SemanticExpr.SHAPE.check({ kind: 'semantic', source: 'doc', query: 5 }, ctx)).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'query' && pr.message.includes('a semantic query'))).toBe(true);
  });

  it('tabular-function-call: a bad arg accumulates', () => {
    const { ctx, problems } = mk();
    expect(TabularFunctionCallExpr.SHAPE.check({ kind: 'tabular-function-call', function: 'f', args: { value: 5 } }, ctx)).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'args.value')).toBe(true);
  });

  it('filters: a non-string source is a directed shape.type at `source`', () => {
    const { ctx, problems } = mk();
    expect(FiltersExpr.SHAPE.check({ kind: 'filters', source: 5 }, ctx)).toBe(INVALID);
    expect(problems.list.some((pr) => pr.path.join('.') === 'source')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: the whole tree parses through the owned parser
// ─────────────────────────────────────────────────────────────────────────────

describe('end-to-end — whole-query parse', () => {
  it('a valid complex SELECT builds == the throwing parser and reports no problems', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [
        { expr: fieldRef('user', 'id') },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'orderCount' },
      ],
      from: typeSource('user'),
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' }, joinType: 'left' }],
      where: [
        { kind: 'comparison', op: '>', left: fieldRef('order', 'total'), right: lit1(100) },
        { kind: 'exists', query: canonicalSelect('o', 'userId', 'order') },
      ],
      groupBy: [fieldRef('user', 'id')],
      having: [{ kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'count', args: {} }, right: lit1(2) }],
      order: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, dir: 'desc', nulls: 'last' }],
      limit: 25,
    };
    const p = new Problems();
    const built = registry.parseCheckedQuery(def, p);
    expect(built).toBeInstanceOf(SelectQuery);
    expect(p.hasErrors).toBe(false);
    expect(built?.toJSON()).toEqual(registry.parseQuery(def).toJSON());
  });

  it('a SELECT with errors across ≥2 clauses surfaces ALL in ONE pass', () => {
    const def = {
      kind: 'select',
      fields: [{ expr: { kind: 'comparison', op: 'NOPE', left: lit1(1), right: lit1(2) } }],
      from: typeSource('user'),
      where: [5],
      groupBy: [7],
      order: [{ expr: fieldRef('u', 'x'), dir: 'upward' }],
    };
    const p = new Problems();
    expect(registry.parseCheckedQuery(def, p)).toBeUndefined();
    const byPath = p.list.map((pr) => ({ path: pr.path.join('.'), code: pr.code }));
    expect(byPath).toContainEqual({ path: 'fields.0.expr.op', code: 'shape.enum' });
    expect(byPath).toContainEqual({ path: 'where.0', code: 'shape.not-object' });
    expect(byPath).toContainEqual({ path: 'groupBy.0', code: 'shape.not-object' });
    expect(byPath).toContainEqual({ path: 'order.0.dir', code: 'shape.enum' });
    expect(p.list.length).toBeGreaterThanOrEqual(4);
  });
});
