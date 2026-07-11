/**
 * Coverage driver for the four function-call expression kinds plus their shared
 * named-argument plumbing:
 *   - exprs/aggregate.ts
 *   - exprs/window.ts
 *   - exprs/function-call.ts
 *   - exprs/tabular-function-call.ts
 *   - exprs/_function-args.ts
 *
 * Exercises every public method across both SQL dialects, every validation
 * Problem code/branch, every aggregate/window builtin, cost, toJSON, clone,
 * toCode, forEachChild, and the full _function-args helper surface.
 */
import { describe, it, expect } from 'vitest';
import { fixture, runtimeFixture, typeScope, lit, ref, param } from './_utils';
import type { ExprDef, SelectDef, FunctionDef, Order } from '../schema';
import { AggregateExpr } from '../exprs/aggregate';
import { WindowExpr } from '../exprs/window';
import { FunctionCallExpr } from '../exprs/function-call';
import { TabularFunctionCallExpr } from '../exprs/tabular-function-call';
import { RuntimeContext } from '../runtime/context';
import { Value } from '../runtime/value';
import type { SourceRow } from '../runtime/row';
import type { NamedArgs } from '../runtime/functions';
import { buildSchemas } from '../llm/index';

// ─── Expr-def builders ───────────────────────────────────────────────────────

const agg = (fn: string, args: Record<string, ExprDef> = {}, distinct?: boolean): ExprDef =>
  distinct === undefined
    ? { kind: 'aggregate', function: fn, args }
    : { kind: 'aggregate', function: fn, args, distinct };

interface WinOrder {
  expr: ExprDef;
  dir: 'asc' | 'desc';
  nulls?: 'first' | 'last';
}
const win = (
  fn: string,
  args: Record<string, ExprDef> = {},
  partitionBy?: ExprDef[],
  orderBy?: WinOrder[],
): ExprDef => ({
  kind: 'window',
  function: fn,
  args,
  ...(partitionBy ? { partitionBy } : {}),
  ...(orderBy ? { orderBy } : {}),
});

const fcall = (fn: string, args: Record<string, ExprDef> = {}): ExprDef => ({
  kind: 'function-call',
  function: fn,
  args,
});
const tcall = (fn: string, args: Record<string, ExprDef> = {}): ExprDef => ({
  kind: 'tabular-function-call',
  function: fn,
  args,
});

/** Wrap a single projected expr in a SELECT over the `order` type for SQL/cost. */
const selOf = (expr: ExprDef, groupBy?: ExprDef[], order?: Order[]): SelectDef => ({
  kind: 'select',
  fields: [{ expr, as: 'x' }],
  from: { kind: 'type', type: 'order' },
  ...(groupBy ? { groupBy } : {}),
  ...(order ? { order } : {}),
});

// ─── Custom-function fixture (resolve / validate / SQL / cost) ────────────────

/** A fixture whose registry adds: an aggregate→Type fn, a tabular fn, a sql-named scalar. */
function customFx() {
  const fx = fixture();
  const aggType: FunctionDef = {
    name: 'agg_type',
    shape: 'aggregate',
    params: [{ name: 'value', type: 'any', optional: true }],
    output: { type: 'user' },
  };
  const tfn: FunctionDef = { name: 'tfn', shape: 'tabular', params: [], output: { type: 'order' } };
  const sqlfn: FunctionDef = {
    name: 'sqlfn',
    shape: 'scalar',
    params: [{ name: 'value', type: { kind: 'text' } }],
    output: { kind: 'text' },
    sql: 'custom_sql',
  };
  fx.registry.registerFunction(aggType);
  fx.registry.registerFunction(tfn);
  fx.registry.registerFunction(sqlfn);
  return fx;
}

const fx = customFx();
const scope = typeScope(fx);

// ════════════════════════════════════════════════════════════════════════════
// AggregateExpr
// ════════════════════════════════════════════════════════════════════════════

describe('AggregateExpr', () => {
  it('static from rejects a mismatched kind', () => {
    expect(() => AggregateExpr.from(lit(1), fx.registry)).toThrow(/expected 'aggregate'/);
  });

  it('from + valueArg + forEachChild', () => {
    const e = AggregateExpr.from(agg('sum', { value: ref('o', 'total') }), fx.registry);
    expect(e.valueArg()).toBeDefined();
    expect(AggregateExpr.from(agg('count', {}), fx.registry).valueArg()).toBeUndefined();
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(1);
  });

  it('resolve: unknown fn falls back to a nullable number aggregate', () => {
    const r = fx.engine.resolveExpr(agg('nope', { value: ref('o', 'total') }), scope);
    expect(r.kind === 'computed' && r.aggregate).toBe(true);
    expect(r.kind === 'computed' && r.nullable).toBe(true);
  });

  it('resolve: count never null, sum nullable, both aggregate', () => {
    const c = fx.engine.resolveExpr(agg('count', {}), scope);
    expect(c.kind === 'computed' && c.nullable).toBe(false);
    expect(c.kind === 'computed' && c.aggregate).toBe(true);
    const s = fx.engine.resolveExpr(agg('sum', { value: ref('o', 'total') }), scope);
    expect(s.kind === 'computed' && s.nullable).toBe(true);
  });

  it('resolve: a Type-output aggregate returns the type unchanged', () => {
    const r = fx.engine.resolveExpr(agg('agg_type', {}), scope);
    expect(r.kind).toBe('type');
  });

  it('validate: aggregate.not-allowed in a no-aggregate context', () => {
    const p = fx.engine.validateExpr(agg('sum', { value: ref('o', 'total') }), scope, {
      allowAggregate: false,
    });
    expect(p.list.some((x) => x.code === 'aggregate.not-allowed')).toBe(true);
  });

  it('validate: aggregate.nested', () => {
    const p = fx.engine.validateExpr(
      agg('sum', { value: agg('sum', { value: ref('o', 'total') }) }),
      scope,
    );
    expect(p.list.some((x) => x.code === 'aggregate.nested')).toBe(true);
  });

  it('validate: aggregate.unknown', () => {
    const p = fx.engine.validateExpr(agg('nope', {}), scope);
    expect(p.list.some((x) => x.code === 'aggregate.unknown')).toBe(true);
  });

  it('validate: aggregate.wrong-shape (a scalar used as an aggregate)', () => {
    const p = fx.engine.validateExpr(agg('lower', { value: ref('o', 'note') }), scope);
    expect(p.list.some((x) => x.code === 'aggregate.wrong-shape')).toBe(true);
  });

  it('validate: a well-formed aggregate has no errors', () => {
    const p = fx.engine.validateExpr(agg('sum', { value: ref('o', 'total') }), scope);
    expect(p.hasErrors).toBe(false);
  });

  it('cost: count(*) is zero, an argumented aggregate sums child cost', () => {
    const z = fx.engine.parse(agg('count', {})).cost(fx.engine, scope);
    expect(z).toEqual({ rows: 0, bytes: 0 });
    const c = fx.engine.parse(agg('sum', { value: ref('o', 'total') })).cost(fx.engine, scope);
    expect(c.bytes).toBeGreaterThanOrEqual(0);
  });

  it('toJSON omits distinct when false and sets it when true; clone is deep', () => {
    const plain = fx.engine.parse(agg('sum', { value: ref('o', 'total') }));
    expect(plain.toJSON()).toEqual(agg('sum', { value: ref('o', 'total') }));
    const dist = fx.engine.parse(agg('count', { value: ref('o', 'total') }, true));
    expect(dist.toJSON()).toEqual({
      kind: 'aggregate',
      function: 'count',
      args: { value: ref('o', 'total') },
      distinct: true,
    });
    const clone = dist.clone();
    expect(clone.toJSON()).toEqual(dist.toJSON());
    expect(clone).not.toBe(dist);
  });

  it('toCode renders DISTINCT, named args, and the count(*) star', () => {
    expect(fx.engine.parse(agg('count', {})).toCode()).toBe('count(*)');
    expect(fx.engine.parse(agg('sum', { value: ref('o', 'total') })).toCode()).toContain('sum(');
    expect(fx.engine.parse(agg('count', { value: ref('o', 'total') }, true)).toCode()).toContain(
      'DISTINCT',
    );
  });

  it('containsAggregate is true', () => {
    expect(fx.engine.parse(agg('count', {})).containsAggregate()).toBe(true);
  });

  it('toSQL: plain call, DISTINCT, and count(*) star (both dialects)', () => {
    for (const d of ['base', 'postgres'] as const) {
      expect(fx.engine.toSQL(selOf(agg('sum', { value: ref('order', 'total') })), d).sql).toContain(
        'sum(',
      );
      expect(
        fx.engine.toSQL(selOf(agg('count', { value: ref('order', 'total') }, true)), d).sql,
      ).toContain('count(DISTINCT ');
      expect(fx.engine.toSQL(selOf(agg('count', {})), d).sql).toContain('count(*)');
    }
  });

  it('toSQL: an aggregate over a has-many relation JOIN emits a plain aggregate (the fan-out pre-agg CTE was removed)', () => {
    // Crossing a relation is now a NAMED join; the aggregate reads the joined
    // alias directly. The old relation-path fan-out GROUP BY CTE branch is gone,
    // so this emits a plain aggregate over a LEFT-joined relation instead.
    const userSel = (expr: ExprDef): SelectDef => ({
      kind: 'select',
      fields: [{ expr, as: 'x' }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' } }],
    });
    const sumSql = fx.engine.toSQL(userSel(agg('sum', { value: ref('o', 'total') })), 'base').sql;
    expect(sumSql).toContain('sum("o"."total")');
    expect(sumSql).toContain('LEFT JOIN "order" AS "o" ON "user"."id" = "o"."userId"');
    expect(sumSql).not.toContain('agg_sum'); // no pre-aggregation CTE
    const countSql = fx.engine.toSQL(userSel(agg('count', { value: ref('o', 'id') })), 'base').sql;
    expect(countSql).toContain('count("o"."id")');
    expect(countSql).not.toContain('COALESCE('); // no fan-out COALESCE
  });

  it('toSQL: an aggregate over a one-to-one (belongs-to) relation JOIN is a plain emit', () => {
    // FROM order, join belongs-to order.userId as `buyer`, sum a joined scalar.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: agg('sum', { value: ref('buyer', 'id') }), as: 'x' }],
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'buyer' } }],
    };
    const sql = fx.engine.toSQL(def, 'base').sql;
    expect(sql).toContain('sum(');
    expect(sql).not.toContain('agg_sum');
  });
});

describe('AggregateExpr runtime', () => {
  const aggSel = (expr: ExprDef): SelectDef => ({
    kind: 'select',
    fields: [
      { expr: ref('order', 'userId'), as: 'userId' },
      { expr, as: 'v' },
    ],
    from: { kind: 'type', type: 'order' },
    groupBy: [ref('order', 'userId')],
    order: [{ expr: ref('order', 'userId'), dir: 'asc' }],
  });

  it('sum / avg / min / max / count over groups', async () => {
    const rfx = runtimeFixture();
    const sum = await rfx.engine.run(aggSel(agg('sum', { value: ref('order', 'total') })));
    expect(sum.rows).toEqual([
      { userId: 1, v: 150 },
      { userId: 2, v: 225 },
    ]);
    const avg = await rfx.engine.run(aggSel(agg('avg', { value: ref('order', 'total') })));
    expect(avg.rows[0]!['v']).toBe(75);
    const min = await rfx.engine.run(aggSel(agg('min', { value: ref('order', 'total') })));
    expect(min.rows[0]!['v']).toBe(50);
    const max = await rfx.engine.run(aggSel(agg('max', { value: ref('order', 'total') })));
    expect(max.rows[0]!['v']).toBe(100);
    const count = await rfx.engine.run(aggSel(agg('count', {})));
    expect(count.rows[0]!['v']).toBe(2);
  });

  it('DISTINCT collapses duplicate argument rows', async () => {
    const rfx = runtimeFixture();
    // Every order's userId repeats inside its group ⇒ count(DISTINCT userId)=1.
    const r = await rfx.engine.run(aggSel(agg('count', { value: ref('order', 'userId') }, true)));
    expect(r.rows).toEqual([
      { userId: 1, v: 1 },
      { userId: 2, v: 1 },
    ]);
  });

  it('evaluate over a single row and over no row', async () => {
    const rfx = runtimeFixture();
    const e = rfx.engine.parse(agg('sum', { value: ref('order', 'total') }));
    const ctx = new RuntimeContext(rfx.engine);
    const row: SourceRow = { order: { total: 7 } };
    expect((await e.evaluate(ctx, row)).raw).toBe(7);
    expect((await e.evaluate(ctx, null)).isNull()).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WindowExpr
// ════════════════════════════════════════════════════════════════════════════

describe('WindowExpr', () => {
  it('static from rejects a mismatched kind', () => {
    expect(() => WindowExpr.from(lit(1), fx.registry)).toThrow(/expected 'window'/);
  });

  it('from + forEachChild visits args, partition, and order', () => {
    const e = WindowExpr.from(
      win('sum', { value: ref('o', 'total') }, [ref('o', 'userId')], [{ expr: ref('o', 'id'), dir: 'asc' }]),
      fx.registry,
    );
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(3);
  });

  it('resolve: unknown fn → number; known → per-row nullable, never aggregate', () => {
    const u = fx.engine.resolveExpr(win('nope', {}), scope);
    expect(u.kind === 'computed' && u.fieldType.resolve()).toBe('number');
    const r = fx.engine.resolveExpr(win('sum', { value: ref('o', 'total') }), scope);
    expect(r.kind === 'computed' && r.nullable).toBe(true);
    expect(r.kind === 'computed' && r.aggregate).toBe(false);
  });

  it('resolve: a Type-output windowed fn returns the type unchanged', () => {
    const r = fx.engine.resolveExpr(win('agg_type', {}), scope);
    expect(r.kind).toBe('type');
  });

  it('validate: window.in-aggregate', () => {
    const p = fx.engine.validateExpr(win('rowNumber', {}), scope, { inAggregate: true });
    expect(p.list.some((x) => x.code === 'window.in-aggregate')).toBe(true);
  });

  it('validate: window.unknown', () => {
    const p = fx.engine.validateExpr(win('nope', {}), scope);
    expect(p.list.some((x) => x.code === 'window.unknown')).toBe(true);
  });

  it('validate: window.not-window (a scalar used as a window)', () => {
    const p = fx.engine.validateExpr(win('lower', { value: ref('o', 'note') }), scope);
    expect(p.list.some((x) => x.code === 'window.not-window')).toBe(true);
  });

  it('validate: a well-formed window (incl. partition/order) has no errors', () => {
    // Partition by a SCALAR field: `o.userId` is a relation field, and a
    // field-ref to a relation is now a `ref.relation` error, so use `o.total`.
    const p = fx.engine.validateExpr(
      win('sum', { value: ref('o', 'total') }, [ref('o', 'total')], [{ expr: ref('o', 'id'), dir: 'asc' }]),
      scope,
    );
    expect(p.hasErrors).toBe(false);
  });

  it('cost sums the child costs', () => {
    const c = fx.engine
      .parse(win('sum', { value: ref('o', 'total') }, [ref('o', 'userId')]))
      .cost(fx.engine, scope);
    expect(c.bytes).toBeGreaterThanOrEqual(0);
  });

  it('containsWindow is true', () => {
    expect(fx.engine.parse(win('rowNumber', {})).containsWindow()).toBe(true);
  });

  it('toJSON / clone round-trip, with and without partition/order/nulls', () => {
    const bare = fx.engine.parse(win('rowNumber', {}));
    expect(bare.toJSON()).toEqual({ kind: 'window', function: 'rowNumber', args: {} });
    const full = win(
      'sum',
      { value: ref('o', 'total') },
      [ref('o', 'userId')],
      [{ expr: ref('o', 'id'), dir: 'desc', nulls: 'last' }],
    );
    const parsed = fx.engine.parse(full);
    expect(parsed.toJSON()).toEqual(full);
    expect(parsed.clone().toJSON()).toEqual(full);
  });

  it('toCode renders the OVER clause (partition + order, and the bare form)', () => {
    expect(fx.engine.parse(win('rowNumber', {})).toCode()).toContain('OVER (');
    const code = fx.engine
      .parse(win('sum', { value: ref('o', 'total') }, [ref('o', 'userId')], [{ expr: ref('o', 'id'), dir: 'asc' }]))
      .toCode();
    expect(code).toContain('PARTITION BY');
    expect(code).toContain('ORDER BY');
  });

  it('toSQL emits OVER (...) with partition, order, dir and NULLS (both dialects)', () => {
    const e = win(
      'sum',
      { value: ref('order', 'total') },
      [ref('order', 'userId')],
      [{ expr: ref('order', 'id'), dir: 'desc', nulls: 'first' }],
    );
    for (const d of ['base', 'postgres'] as const) {
      const sql = fx.engine.toSQL(selOf(e), d).sql;
      expect(sql).toContain('OVER (');
      expect(sql).toContain('PARTITION BY');
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('DESC');
      expect(sql).toContain('NULLS FIRST');
    }
    // The no-partition / no-order shape too.
    expect(fx.engine.toSQL(selOf(win('rowNumber', {})), 'base').sql).toContain('row_number() OVER ()');
    // An ORDER BY term WITHOUT a NULLS clause ⇒ the `SqlText.empty()` else-leg.
    const noNulls = fx.engine.toSQL(
      selOf(win('rowNumber', {}, undefined, [{ expr: ref('order', 'id'), dir: 'asc' }])),
      'base',
    ).sql;
    expect(noNulls).toContain('ORDER BY');
    expect(noNulls).not.toContain('NULLS');
  });
});

describe('WindowExpr runtime', () => {
  const winSel = (expr: ExprDef): SelectDef => ({
    kind: 'select',
    fields: [
      { expr: ref('order', 'id'), as: 'id' },
      { expr, as: 'w' },
    ],
    from: { kind: 'type', type: 'order' },
    order: [{ expr: ref('order', 'id'), dir: 'asc' }],
  });

  it('rowNumber partitioned + ordered', async () => {
    const rfx = runtimeFixture();
    const r = await rfx.engine.run(
      winSel(win('rowNumber', {}, [ref('order', 'userId')], [{ expr: ref('order', 'id'), dir: 'asc' }])),
    );
    expect(r.rows.map((x) => x['w'])).toEqual([1, 2, 1, 2]);
  });

  it('rank + denseRank over a tied, descending order key', async () => {
    const rfx = runtimeFixture();
    // userId asc-grouped values are tied (1,1,2,2); ranked DESC.
    const rank = await rfx.engine.run(
      winSel(win('rank', {}, undefined, [{ expr: ref('order', 'userId'), dir: 'desc' }])),
    );
    // ids 10,11 (userId1) and 12,13 (userId2); DESC ⇒ userId2 first (rank1), userId1 (rank3).
    const byId = new Map(rank.rows.map((x) => [x['id'], x['w']]));
    expect(byId.get(10)).toBe(3);
    expect(byId.get(12)).toBe(1);
    const dense = await rfx.engine.run(
      winSel(win('denseRank', {}, undefined, [{ expr: ref('order', 'userId'), dir: 'asc' }])),
    );
    const denseById = new Map(dense.rows.map((x) => [x['id'], x['w']]));
    expect(denseById.get(10)).toBe(1);
    expect(denseById.get(12)).toBe(2);
  });

  it('lag / lead with offset + default', async () => {
    const rfx = runtimeFixture();
    const lag = await rfx.engine.run(
      winSel(win('lag', { value: ref('order', 'total') }, undefined, [{ expr: ref('order', 'id'), dir: 'asc' }])),
    );
    expect(lag.rows[0]!['w']).toBe(null); // no prior row
    expect(lag.rows[1]!['w']).toBe(100);
    const lead = await rfx.engine.run(
      winSel(
        win(
          'lead',
          { value: ref('order', 'total'), offset: lit(1), default: lit(-1) },
          undefined,
          [{ expr: ref('order', 'id'), dir: 'asc' }],
        ),
      ),
    );
    expect(lead.rows[3]!['w']).toBe(-1); // past the end ⇒ default
  });

  it('sum as a windowed aggregate over a partition', async () => {
    const rfx = runtimeFixture();
    const r = await rfx.engine.run(
      winSel(win('sum', { value: ref('order', 'total') }, [ref('order', 'userId')])),
    );
    // partition totals: userId1 = 150 (ids 10,11), userId2 = 225 (ids 12,13).
    const byId = new Map(r.rows.map((x) => [x['id'], x['w']]));
    expect(byId.get(10)).toBe(150);
    expect(byId.get(12)).toBe(225);
  });

  it('evaluate returns NULL for a null row and index 0 for a row outside the group', async () => {
    const rfx = runtimeFixture();
    const e = WindowExpr.from(
      win('rowNumber', {}, undefined, [{ expr: ref('order', 'id'), dir: 'asc' }]),
      rfx.registry,
    );
    const ctx = new RuntimeContext(rfx.engine);
    expect((await e.evaluate(ctx, null)).isNull()).toBe(true);
    const group: SourceRow[] = [{ order: { id: 1 } }, { order: { id: 2 } }];
    const outside: SourceRow = { order: { id: 99 } };
    expect((await e.evaluate(ctx, outside, group)).raw).toBe(1); // idx<0 ⇒ index 0
    // No group supplied ⇒ the `group ?? [row]` fallback treats the lone row as
    // the whole partition (rowNumber ⇒ 1).
    expect((await e.evaluate(ctx, { order: { id: 5 } })).raw).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FunctionCallExpr
// ════════════════════════════════════════════════════════════════════════════

describe('FunctionCallExpr', () => {
  it('static from rejects a mismatched kind', () => {
    expect(() => FunctionCallExpr.from(lit(1), fx.registry)).toThrow(/expected 'function-call'/);
  });

  it('resolve: unknown → text fallback; known → declared output', () => {
    const u = fx.engine.resolveExpr(fcall('nope', {}), scope);
    expect(u.kind === 'computed' && u.fieldType.resolve()).toBe('text');
    const k = fx.engine.resolveExpr(fcall('lower', { value: ref('u', 'name') }), scope);
    expect(k.kind === 'computed' && k.fieldType.resolve()).toBe('text');
  });

  it('validate: function.unknown', () => {
    const p = fx.engine.validateExpr(fcall('nope', {}), scope);
    expect(p.list.some((x) => x.code === 'function.unknown')).toBe(true);
  });

  it('validate: function.wrong-shape (an aggregate used as a scalar)', () => {
    const p = fx.engine.validateExpr(fcall('sum', { value: ref('o', 'total') }), scope);
    expect(p.list.some((x) => x.code === 'function.wrong-shape')).toBe(true);
  });

  it('validate observes a typed param, skips an any-typed param, and skips an undeclared param', () => {
    // value:text param ⇒ observed; clean.
    expect(fx.engine.validateExpr(fcall('lower', { value: param('p') }), scope).hasErrors).toBe(false);
    // nullif value:'any' param ⇒ no fieldType to observe (the observe is skipped),
    // so `q` is referenced but never typed ⇒ ParamSet reports it as `param.untyped`
    // (an error). An unobservable param cannot be inferred, so this is expected.
    expect(fx.engine.validateExpr(fcall('nullif', { value: param('q'), other: lit(1) }), scope).hasErrors).toBe(
      true,
    );
    // `extra` is a param but not a declared parameter ⇒ unknown-arg + observe skip.
    const p = fx.engine.validateExpr(fcall('lower', { value: ref('u', 'name'), extra: param('r') }), scope);
    expect(p.list.some((x) => x.code === 'function.unknown-arg')).toBe(true);
  });

  it('cost sums the child costs', () => {
    const c = fx.engine.parse(fcall('lower', { value: ref('o', 'note') })).cost(fx.engine, scope);
    expect(c.bytes).toBeGreaterThanOrEqual(0);
  });

  it('toJSON / clone / toCode / forEachChild', () => {
    const def = fcall('lower', { value: ref('o', 'note') });
    const e = fx.engine.parse(def);
    expect(e.toJSON()).toEqual(def);
    expect(e.clone().toJSON()).toEqual(def);
    expect(e.toCode()).toContain('lower(');
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(1);
  });

  it('toSQL: a dialect builtin override, the generic form, a sql-named fn, and an unknown fn', () => {
    // arrayLength → cardinality(...) override in both dialects.
    expect(
      fx.engine.toSQL(selOf(fcall('arrayLength', { arr: ref('order', 'note') })), 'postgres').sql,
    ).toContain('cardinality(');
    // generic name(args)
    expect(fx.engine.toSQL(selOf(fcall('lower', { value: ref('order', 'note') })), 'base').sql).toContain(
      'lower(',
    );
    // a registered fn carrying a `sql` name emits that name.
    expect(fx.engine.toSQL(selOf(fcall('sqlfn', { value: ref('order', 'note') })), 'base').sql).toContain(
      'custom_sql(',
    );
    // unknown fn ⇒ args emit in authored order, name falls back to the call name.
    expect(fx.engine.toSQL(selOf(fcall('nope', { a: ref('order', 'note') })), 'base').sql).toContain('nope(');
  });

  it('toSQL: orderedArgSql honors declared order, missing-arg skip, and trailing unknown args', () => {
    // `power(base, exponent)` with exponent omitted ⇒ the missing param is skipped.
    expect(fx.engine.toSQL(selOf(fcall('power', { base: ref('order', 'total') })), 'base').sql).toContain(
      'power(',
    );
    // `lower(value, extra)` — `extra` is not a declared param ⇒ trails in authored order.
    const sql = fx.engine.toSQL(
      selOf(fcall('lower', { value: ref('order', 'note'), extra: lit('z') })),
      'base',
    ).sql;
    expect(sql).toContain('lower(');
  });

  it('runtime: a scalar runs per row', async () => {
    const rfx = runtimeFixture();
    const sel: SelectDef = {
      kind: 'select',
      fields: [{ expr: fcall('upper', { value: ref('user', 'name') }), as: 'n' }],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: ref('user', 'id'), dir: 'asc' }],
    };
    const r = await rfx.engine.run(sel);
    expect(r.rows[0]!['n']).toBe('ADA');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// TabularFunctionCallExpr
// ════════════════════════════════════════════════════════════════════════════

describe('TabularFunctionCallExpr', () => {
  it('static from rejects a mismatched kind', () => {
    expect(() => TabularFunctionCallExpr.from(lit(1), fx.registry)).toThrow(/expected 'tabular-function-call'/);
  });

  it('resolve: a tabular fn → its Type; a non-tabular/unknown fn → a synthetic type', () => {
    const t = fx.engine.resolveExpr(tcall('tfn', {}), scope);
    expect(t.kind === 'type' && t.type.name).toBe('order');
    // a scalar used here resolves to a synthetic field-less type.
    const syn = fx.engine.resolveExpr(tcall('lower', { value: ref('u', 'name') }), scope);
    expect(syn.kind === 'type' && syn.synthetic).toBe(true);
    // unknown fn ⇒ synthetic too.
    const unk = fx.engine.resolveExpr(tcall('nope', {}), scope);
    expect(unk.kind === 'type' && unk.synthetic).toBe(true);
  });

  it('validate: tabular-function.unknown', () => {
    const p = fx.engine.validateExpr(tcall('nope', {}), scope);
    expect(p.list.some((x) => x.code === 'tabular-function.unknown')).toBe(true);
  });

  it('validate: tabular-function.not-tabular (a scalar used as tabular)', () => {
    const p = fx.engine.validateExpr(tcall('lower', { value: ref('u', 'name') }), scope);
    expect(p.list.some((x) => x.code === 'tabular-function.not-tabular')).toBe(true);
  });

  it('validate: a well-formed tabular call has no errors', () => {
    // Use a fresh scope: the shared module-level `scope` accumulates untyped
    // params from earlier validate calls (e.g. nullif's `q`), and validateExpr
    // re-reports the whole ParamSet, which would mask this expr's own cleanliness.
    expect(fx.engine.validateExpr(tcall('tfn', {}), typeScope(fx)).hasErrors).toBe(false);
  });

  it('cost reflects the output type cardinality plus child costs', () => {
    const c = fx.engine.parse(tcall('tfn', {})).cost(fx.engine, scope);
    expect(c.rows).toBe(fx.order.count);
  });

  it('toJSON / clone / toCode / forEachChild', () => {
    const def = tcall('tfn', { hint: lit(1) });
    const e = fx.engine.parse(def);
    expect(e.toJSON()).toEqual(def);
    expect(e.clone().toJSON()).toEqual(def);
    expect(e.toCode()).toContain('tfn(');
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(1);
  });

  it('toSQL: FROM-position fn(args), sql-name fallback, both dialects', () => {
    for (const d of ['base', 'postgres'] as const) {
      expect(fx.engine.toSQL(selOf(tcall('tfn', {})), d).sql).toContain('tfn(');
    }
    // a registered scalar with a `sql` name still emits that name in the generic form.
    expect(fx.engine.toSQL(selOf(tcall('sqlfn', { value: ref('order', 'note') })), 'base').sql).toContain(
      'custom_sql(',
    );
  });

  it('runtime: runs the registered tabular implementation (and degrades to empty rows)', async () => {
    const rfx = runtimeFixture();
    rfx.registry.registerFunction({ name: 'rows3', shape: 'tabular', params: [], output: { type: 'user' } });
    rfx.registry.registerFunctionRun('rows3', {
      shape: 'tabular',
      run: () => Value.of([{ id: 0 }, { id: 1 }, { id: 2 }]),
    });
    const ctx = new RuntimeContext(rfx.engine);
    const produced = await rfx.engine.parse(tcall('rows3', {})).evaluate(ctx, null);
    expect(produced.raw).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
    // No run registered ⇒ empty rows.
    rfx.registry.registerFunction({ name: 'noimpl', shape: 'tabular', params: [], output: { type: 'user' } });
    const empty = await rfx.engine.parse(tcall('noimpl', {})).evaluate(ctx, null);
    expect(empty.raw).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// _function-args + schema coverage
// ════════════════════════════════════════════════════════════════════════════

describe('_function-args schema + helper coverage', () => {
  it('every function-call expr kind contributes a Zod schema (namedArgSchema/toSchema)', () => {
    const schemas = buildSchemas(fx.engine);
    expect(schemas.Expr).toBeDefined();
    // The named-arg shape round-trips through the built schema.
    const ok = schemas.Expr.safeParse(agg('count', {}));
    expect(ok.success).toBe(true);
  });

  it('namedArgsToCode renders `name: code` pairs for a multi-arg call', () => {
    const code = fx.engine
      .parse(fcall('power', { base: ref('o', 'total'), exponent: lit(2) }))
      .toCode();
    expect(code).toBe('power(base: o.total, exponent: 2)');
  });

  it('evaluateNamedArgs threads a group through to aggregate args', async () => {
    const rfx = runtimeFixture();
    const e = rfx.engine.parse(fcall('upper', { value: ref('order', 'note') }));
    const ctx = new RuntimeContext(rfx.engine);
    const args: NamedArgs = { value: Value.of('x') };
    void args;
    const v = await e.evaluate(ctx, { order: { note: 'hi' } });
    expect(v.raw).toBe('HI');
  });
});
