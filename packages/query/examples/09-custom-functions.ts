/**
 * Example 09 — define + register + RUN all FOUR function shapes.
 *
 * Every function shape is uniform: declare a `FunctionDef` (named params +
 * output) with `registerFunction`, pair it with a shape-tagged `FunctionRun`
 * via `registerFunctionRun`, then reference it by name with NAMED arguments.
 *  - scalar    — `initials(value)` → upper-cased first letters.
 *  - aggregate — `span(value)`     → max − min of a group.
 *  - window    — `cume(value)`     → running sum across the ordered frame.
 *  - tabular   — `rangeRows(count)`→ produces `count` rows.
 */
import {
  e,
  Value,
  RuntimeContext,
  type SelectDef,
  type NamedArgs,
} from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

/** Read a named arg, NULL when absent. */
const get = (a: NamedArgs, k: string): Value => a[k] ?? Value.null();

export async function run(): Promise<ExampleReport> {
  const { registry, engine } = createExampleFixture();
  const output: string[] = [];
  let errors = 0;

  // ── SCALAR — initials(value: text): text ──────────────────────────────────
  registry.registerFunction({
    name: 'initials',
    shape: 'scalar',
    params: [{ name: 'value', type: { kind: 'text' } }],
    output: { kind: 'text' },
  });
  registry.registerFunctionRun('initials', {
    shape: 'scalar',
    run: (a) =>
      Value.of(
        get(a, 'value')
          .toText()
          .split(/\s+/)
          .map((w) => w.charAt(0).toUpperCase())
          .join(''),
      ),
  });

  // ── AGGREGATE — span(value: number): number  (max − min) ───────────────────
  registry.registerFunction({
    name: 'span',
    shape: 'aggregate',
    params: [{ name: 'value', type: { kind: 'number' } }],
    output: { kind: 'number' },
  });
  registry.registerFunctionRun('span', {
    shape: 'aggregate',
    run: (rows) => {
      const nums = rows.map((r) => get(r, 'value')).filter((v) => !v.isNull()).map((v) => v.toNumber());
      if (nums.length === 0) return Value.null();
      return Value.of(Math.max(...nums) - Math.min(...nums));
    },
  });

  // ── WINDOW — cume(value: number): number  (running sum) ────────────────────
  registry.registerFunction({
    name: 'cume',
    shape: 'window',
    params: [{ name: 'value', type: { kind: 'number' } }],
    output: { kind: 'number' },
  });
  registry.registerFunctionRun('cume', {
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

  // ── TABULAR — rangeRows(count: number): rows of { id } ─────────────────────
  registry.registerFunction({
    name: 'rangeRows',
    shape: 'tabular',
    params: [{ name: 'count', type: { kind: 'number' } }],
    output: { type: 'user' },
  });
  registry.registerFunctionRun('rangeRows', {
    shape: 'tabular',
    run: (a) => {
      const n = get(a, 'count').isNull() ? 0 : Math.trunc(get(a, 'count').toNumber());
      const rows: { id: number }[] = [];
      for (let i = 0; i < n; i++) rows.push({ id: i });
      return Value.of(rows);
    },
  });

  // ── Run SCALAR over users ─────────────────────────────────────────────────
  const scalarSelect: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('user', 'name').toJSON(), as: 'name' },
      { expr: e.fn('initials', { value: e.ref('user', 'name') }).toJSON(), as: 'initials' },
    ],
    from: { kind: 'type', type: 'user' },
    order: [{ expr: e.ref('user', 'id').toJSON(), dir: 'asc' }],
    limit: 3,
  };
  errors += engine.validateQuery(scalarSelect).list.filter((p) => p.severity === 'error').length;
  const scalarRows = (await engine.run(scalarSelect)).rows;
  output.push('scalar initials(name):');
  for (const r of scalarRows) output.push(`  ${JSON.stringify(r)}`);

  // ── Run AGGREGATE: span of order totals per user ──────────────────────────
  const aggSelect: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('order', 'userId').toJSON(), as: 'userId' },
      { expr: e.agg('span', { value: e.ref('order', 'total') }).toJSON(), as: 'span' },
    ],
    from: { kind: 'type', type: 'order' },
    groupBy: [e.ref('order', 'userId').toJSON()],
    order: [{ expr: e.ref('order', 'userId').toJSON(), dir: 'asc' }],
    limit: 3,
  };
  errors += engine.validateQuery(aggSelect).list.filter((p) => p.severity === 'error').length;
  const aggRows = (await engine.run(aggSelect)).rows;
  output.push('aggregate span(total) per user:');
  for (const r of aggRows) output.push(`  ${JSON.stringify(r)}`);

  // ── Run WINDOW: running total of order totals ─────────────────────────────
  const winSelect: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('order', 'id').toJSON(), as: 'id' },
      {
        expr: e
          .window('cume', {
            args: { value: e.ref('order', 'total') },
            orderBy: [{ expr: e.ref('order', 'id'), dir: 'asc' }],
          })
          .toJSON(),
        as: 'running',
      },
    ],
    from: { kind: 'type', type: 'order' },
    order: [{ expr: e.ref('order', 'id').toJSON(), dir: 'asc' }],
    limit: 4,
  };
  errors += engine.validateQuery(winSelect).list.filter((p) => p.severity === 'error').length;
  const winRows = (await engine.run(winSelect)).rows;
  output.push('window cume(total) running sum:');
  for (const r of winRows) output.push(`  ${JSON.stringify(r)}`);

  // ── Run TABULAR: evaluate the type-valued function directly ───────────────
  const tabExpr = e.tableFn('rangeRows', { count: e.value(3) });
  const ctx = new RuntimeContext(engine);
  const tabValue = await registry.parseExpr(tabExpr).evaluate(ctx, null);
  output.push(`tabular rangeRows(3): ${JSON.stringify(tabValue.raw)}`);

  return { title: 'Custom functions — all four shapes', output, errors };
}
