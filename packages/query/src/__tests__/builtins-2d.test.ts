/**
 * Coverage: group 2d aggregate + window builtins — runtime (via the uniform
 * aggregate / window dispatch) AND both-dialect SQL emission, including the
 * AggregateExpr `emitBuiltinCall` routing (countIf → sum(CASE…), the base
 * boolAnd/boolOr/arrayAgg degrades vs the pg-native forms).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { RuntimeContext } from '../runtime/context';
import {
  runAggregateFunction,
  runWindowFunction,
  WINDOW_ORDER_ARG,
} from '../runtime/functions';
import type { NamedArgs } from '../runtime/functions';
import { Value } from '../runtime/value';
import type { JsonValue } from '../schema';
import { e } from '../builder';
import type { Expr } from '../expr';

const fx = runtimeFixture();
const ctx = new RuntimeContext(fx.engine);

const V = (x: JsonValue): Value => Value.of(x);
const agg = async (name: string, rows: readonly NamedArgs[]): Promise<JsonValue> =>
  (await runAggregateFunction(fx.engine, name, rows, ctx)).raw;
const win = async (name: string, partition: readonly NamedArgs[], index: number): Promise<JsonValue> =>
  (await runWindowFunction(fx.engine, name, partition, index, ctx)).raw;
const baseSql = (expr: Expr): string => fx.engine.exprToSQL(expr, 'base').sql;
const pgSql = (expr: Expr): string => fx.engine.exprToSQL(expr, 'postgres').sql;

/** Rows carrying a single `value` arg. */
const valRows = (vals: readonly JsonValue[]): NamedArgs[] => vals.map((v) => ({ value: V(v) }));
/** A window partition row with an ORDER-BY signature `k` plus extra args. */
const orderRow = (k: JsonValue, extra: NamedArgs = {}): NamedArgs => ({
  [WINDOW_ORDER_ARG]: Value.of([k]),
  ...extra,
});

describe('2d aggregates — runtime', () => {
  it('variance / stddev (sample; NULL for n < 2)', async () => {
    expect(await agg('variance', valRows([2, 4]))).toBe(2); // ((−1)²+1²)/1
    expect(await agg('stddev', valRows([2, 4]))).toBe(Math.sqrt(2));
    expect(await agg('variance', valRows([5]))).toBe(null); // n < 2
    expect(await agg('stddev', valRows([5]))).toBe(null);
  });

  it('stringAgg joins non-null values by the per-group sep', async () => {
    const rows: NamedArgs[] = [
      { value: V('a'), sep: V('-') },
      { value: Value.null(), sep: V('-') },
      { value: V('b'), sep: V('-') },
    ];
    expect(await agg('stringAgg', rows)).toBe('a-b');
    expect(await agg('stringAgg', [])).toBe(null); // empty group → null
  });

  it('arrayAgg collects values (nulls kept; absent arg → null; NULL over empty)', async () => {
    expect(await agg('arrayAgg', valRows([1, 2, 3]))).toEqual([1, 2, 3]);
    // A present NULL value → null; a row with NO value arg → null too.
    expect(await agg('arrayAgg', [{ value: V(1) }, {}, { value: Value.null() }])).toEqual([1, null, null]);
    expect(await agg('arrayAgg', [])).toBe(null);
  });

  it('boolAnd / boolOr over non-null bools (NULL over empty)', async () => {
    expect(await agg('boolAnd', valRows([true, true]))).toBe(true);
    expect(await agg('boolAnd', valRows([true, false]))).toBe(false);
    expect(await agg('boolOr', valRows([false, true]))).toBe(true);
    expect(await agg('boolOr', valRows([false, false]))).toBe(false);
    expect(await agg('boolAnd', [])).toBe(null);
    expect(await agg('boolOr', [])).toBe(null);
  });

  it('countIf counts truthy, non-null conditions', async () => {
    const rows: NamedArgs[] = [
      { cond: V(true) },
      { cond: V(false) },
      { cond: V(true) },
      { cond: Value.null() },
    ];
    expect(await agg('countIf', rows)).toBe(2);
  });
});

describe('2d windows — runtime', () => {
  const dist = [orderRow(1), orderRow(2), orderRow(3), orderRow(4)];

  it('percentRank / cumeDist over distinct and tied orders', async () => {
    expect(await win('percentRank', dist, 0)).toBe(0);
    expect(await win('percentRank', dist, 1)).toBeCloseTo(1 / 3, 10);
    expect(await win('percentRank', [orderRow(5)], 0)).toBe(0); // single row
    // Tied orders: the peer group's first row sets the rank.
    const tiedPr = [orderRow(1), orderRow(1), orderRow(2), orderRow(2)];
    expect(await win('percentRank', tiedPr, 1)).toBe(0); // still in the first peer group
    expect(await win('percentRank', tiedPr, 3)).toBeCloseTo(2 / 3, 10);
    expect(await win('cumeDist', dist, 0)).toBe(0.25);
    expect(await win('cumeDist', dist, 3)).toBe(1);
    const tied = [orderRow(1), orderRow(1), orderRow(2), orderRow(2)];
    expect(await win('cumeDist', tied, 0)).toBe(0.5); // both order=1 rows counted
  });

  it('ntile distributes rows into buckets (remainder first)', async () => {
    const four = [0, 1, 2, 3].map(() => ({ n: V(2) }));
    expect(await Promise.all(four.map((_, i) => win('ntile', four, i)))).toEqual([1, 1, 2, 2]);
    const five = [0, 1, 2, 3, 4].map(() => ({ n: V(2) }));
    expect(await Promise.all(five.map((_, i) => win('ntile', five, i)))).toEqual([1, 1, 1, 2, 2]);
    const two = [0, 1].map(() => ({ n: V(4) })); // more buckets than rows
    expect(await Promise.all(two.map((_, i) => win('ntile', two, i)))).toEqual([1, 2]);
    expect(await win('ntile', [{ n: V(0) }], 0)).toBe(null); // n ≤ 0 → null
    expect(await win('ntile', [{}], 0)).toBe(1); // absent n → 1 bucket
  });

  it('firstValue / lastValue / nthValue', async () => {
    const rows: NamedArgs[] = [{ value: V('a') }, { value: V('b') }, { value: V('c') }];
    expect(await win('firstValue', rows, 2)).toBe('a');
    expect(await win('lastValue', rows, 0)).toBe('c');
    expect(await win('firstValue', [], 0)).toBe(null); // empty partition
    expect(await win('lastValue', [], 0)).toBe(null);
    const nth: NamedArgs[] = [
      { value: V('a'), n: V(2) },
      { value: V('b'), n: V(2) },
      { value: V('c'), n: V(2) },
    ];
    expect(await win('nthValue', nth, 0)).toBe('b'); // 2nd row
    expect(await win('nthValue', [{ value: V('a') }], 0)).toBe('a'); // absent n → 1st
    expect(await win('nthValue', [{ value: V('a'), n: V(99) }], 0)).toBe(null); // out of range
  });
});

describe('2d aggregates — SQL (both dialects + AggregateExpr routing)', () => {
  it('generic / sql-name aggregates emit name(args)', () => {
    for (const sql of [baseSql, pgSql]) {
      expect(sql(e.stddev(e.param('x')))).toContain('stddev(');
      expect(sql(e.variance(e.param('x')))).toContain('variance(');
      expect(sql(e.stringAgg(e.param('x'), e.value(',')))).toContain('string_agg(');
    }
  });

  it('countIf emits portable sum(CASE …) on both dialects', () => {
    expect(baseSql(e.countIf(e.param('c')))).toBe('sum(CASE WHEN ? THEN 1 ELSE 0 END)');
    expect(pgSql(e.countIf(e.param('c')))).toBe('sum(CASE WHEN $1 THEN 1 ELSE 0 END)');
  });

  it('boolAnd / boolOr / arrayAgg: base degrades vs pg native', () => {
    expect(baseSql(e.boolAnd(e.param('b')))).toBe('(MIN(CASE WHEN ? THEN 1 ELSE 0 END) = 1)');
    expect(baseSql(e.boolOr(e.param('b')))).toBe('(MAX(CASE WHEN ? THEN 1 ELSE 0 END) = 1)');
    expect(baseSql(e.arrayAgg(e.param('v')))).toBe('NULL');
    expect(pgSql(e.boolAnd(e.param('b')))).toBe('bool_and($1)');
    expect(pgSql(e.boolOr(e.param('b')))).toBe('bool_or($1)');
    expect(pgSql(e.arrayAgg(e.param('v')))).toBe('array_agg($1)');
  });
});

describe('2d windows — SQL (both dialects)', () => {
  const order = [{ expr: e.param('o'), dir: 'asc' as const }];
  it('emit the generic name(args) OVER (...) form', () => {
    for (const sql of [baseSql, pgSql]) {
      expect(sql(e.window('percentRank', { orderBy: order }))).toContain('percent_rank() OVER (');
      expect(sql(e.window('cumeDist', { orderBy: order }))).toContain('cume_dist() OVER (');
      expect(sql(e.window('ntile', { args: { n: e.value(4) }, orderBy: order }))).toContain('ntile(');
      expect(sql(e.window('firstValue', { args: { value: e.param('v') }, orderBy: order }))).toContain(
        'first_value(',
      );
      expect(sql(e.window('lastValue', { args: { value: e.param('v') }, orderBy: order }))).toContain(
        'last_value(',
      );
      expect(
        sql(e.window('nthValue', { args: { value: e.param('v'), n: e.value(2) }, orderBy: order })),
      ).toContain('nth_value(');
    }
  });
});
