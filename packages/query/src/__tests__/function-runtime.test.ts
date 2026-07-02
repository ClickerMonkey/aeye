/**
 * End-to-end runtime for all FOUR function shapes. Each custom function is
 * declared via `registerFunction` (a `FunctionDef`) PLUS `registerFunctionRun`
 * (its shape-tagged `FunctionRun`), then exercised over the in-memory dataset:
 *  - scalar    — `exclaim(value)` appends '!' per row.
 *  - aggregate — `product(value)` multiplies a group's values.
 *  - window    — `cume(value)` running sum across the ordered frame.
 *  - tabular   — `rangeRows(count)` produces `count` rows.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, ref, orderRows } from './_utils';
import type { SelectDef, ExprDef } from '../schema';
import { RuntimeContext } from '../runtime/context';
import { Value } from '../runtime/value';
import type { NamedArgs } from '../runtime/functions';

/** Read a named arg, NULL when absent. */
const get = (a: NamedArgs, k: string): Value => a[k] ?? Value.null();

function customFixture() {
  const fx = runtimeFixture();
  const r = fx.registry;

  // SCALAR — exclaim(value: text): text
  r.registerFunction({ name: 'exclaim', shape: 'scalar', params: [{ name: 'value', type: { kind: 'text' } }], output: { kind: 'text' } });
  r.registerFunctionRun('exclaim', { shape: 'scalar', run: (a) => Value.of(`${get(a, 'value').toText()}!`) });

  // AGGREGATE — product(value: number): number
  r.registerFunction({ name: 'product', shape: 'aggregate', params: [{ name: 'value', type: { kind: 'number' } }], output: { kind: 'number' } });
  r.registerFunctionRun('product', {
    shape: 'aggregate',
    run: (rows) => {
      const nums = rows.map((row) => get(row, 'value')).filter((v) => !v.isNull());
      if (nums.length === 0) return Value.null();
      return Value.of(nums.reduce((acc, v) => acc * v.toNumber(), 1));
    },
  });

  // WINDOW — cume(value: number): number  (running sum across the ordered frame)
  r.registerFunction({ name: 'cume', shape: 'window', params: [{ name: 'value', type: { kind: 'number' } }], output: { kind: 'number' } });
  r.registerFunctionRun('cume', {
    shape: 'window',
    run: (partition, index) => {
      let sum = 0;
      for (let i = 0; i <= index; i++) {
        const v = partition[i]?.['value'];
        if (v && !v.isNull()) sum += v.toNumber();
      }
      return Value.of(sum);
    },
  });

  // TABULAR — rangeRows(count: number): rows of { id }
  r.registerFunction({ name: 'rangeRows', shape: 'tabular', params: [{ name: 'count', type: { kind: 'number' } }], output: { type: 'user' } });
  r.registerFunctionRun('rangeRows', {
    shape: 'tabular',
    run: (a) => {
      const n = get(a, 'count').isNull() ? 0 : Math.trunc(get(a, 'count').toNumber());
      const rows: { id: number }[] = [];
      for (let i = 0; i < n; i++) rows.push({ id: i });
      return Value.of(rows);
    },
  });

  return fx;
}

describe('custom function runtime — all four shapes', () => {
  it('SCALAR exclaim runs per row', async () => {
    const fx = customFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('user', 'name'), as: 'name' },
        { expr: { kind: 'function-call', function: 'exclaim', args: { value: ref('user', 'name') } }, as: 'shout' },
      ],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: ref('user', 'id'), dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([
      { name: 'Ada', shout: 'Ada!' },
      { name: 'Bob', shout: 'Bob!' },
      { name: 'Cleo', shout: 'Cleo!' },
    ]);
  });

  it('AGGREGATE product multiplies a group', async () => {
    const fx = customFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'userId' },
        { expr: { kind: 'aggregate', function: 'product', args: { value: ref('order', 'id') } }, as: 'prod' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [ref('order', 'userId')],
      order: [{ expr: ref('order', 'userId'), dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    // user 1: ids 10*11 = 110; user 2: ids 12*13 = 156.
    expect(result.rows).toEqual([
      { userId: 1, prod: 110 },
      { userId: 2, prod: 156 },
    ]);
  });

  it('WINDOW cume is a running sum across the ordered frame', async () => {
    const fx = customFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'id'), as: 'id' },
        {
          expr: {
            kind: 'window',
            function: 'cume',
            args: { value: ref('order', 'total') },
            orderBy: [{ expr: ref('order', 'id'), dir: 'asc' }],
          },
          as: 'running',
        },
      ],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: ref('order', 'id'), dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    // totals by id asc: 100, 50, 200, 25 → running 100, 150, 350, 375.
    expect(result.rows).toEqual([
      { id: 10, running: 100 },
      { id: 11, running: 150 },
      { id: 12, running: 350 },
      { id: 13, running: 375 },
    ]);
  });

  it('TABULAR rangeRows produces N rows', async () => {
    const fx = customFixture();
    const ctx = new RuntimeContext(fx.engine);
    const expr: ExprDef = { kind: 'tabular-function-call', function: 'rangeRows', args: { count: { kind: 'literal', value: 3 } } };
    const value = await fx.registry.parseExpr(expr).evaluate(ctx, null);
    expect(value.raw).toEqual([{ id: 0 }, { id: 1 }, { id: 2 }]);
  });

  it('the four custom functions are discoverable + validate cleanly', () => {
    const fx = customFixture();
    const names = fx.registry.functionList().map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['exclaim', 'product', 'cume', 'rangeRows']));
    // A windowed builtin (row_number) is registered by the default library too.
    expect(names).toEqual(expect.arrayContaining(['row_number', 'sum', 'concat']));
    void orderRows; // dataset import kept for parity with other runtime tests.
  });
});
