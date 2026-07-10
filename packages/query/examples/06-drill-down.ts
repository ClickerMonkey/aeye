/**
 * Example 06 — drill down into an aggregate.
 *
 * Start with "revenue per user" (GROUP BY userId, SUM(total)). `drillDown`
 * rebuilds a PARAMETERIZED SELECT that returns the UNDERLYING orders behind a
 * single aggregated row — each group key becomes a `key = param(name)` bind,
 * so the drilled query is reusable. `drillDownInto` is the convenience that
 * pulls those param values out of ONE chosen aggregated row, so we can run the
 * drilled query for that user with `engine.run(query, { params })`.
 */
import { e } from '../src/index';
import type { SelectDef } from '../src/index';
import { drillDown, drillDownInto } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  const revenuePerUser: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('buyer', 'id').toJSON(), as: 'userId' },
      { expr: e.sum(e.ref('order', 'total')).toJSON(), as: 'revenue' },
    ],
    from: { kind: 'type', type: 'order' },
    // `order.userId` is a belongs-to relation, so join it and group by the
    // buyer's key (a plain field-ref can't read a relation directly).
    joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'buyer' } }],
    groupBy: [e.ref('buyer', 'id').toJSON()],
    order: [{ expr: e.ref('buyer', 'id').toJSON(), dir: 'asc' }],
  };

  const errors = engine.validateQuery(revenuePerUser).list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  const aggregated = await engine.run(revenuePerUser);
  output.push('revenue per user:');
  for (const row of aggregated.rows) output.push(`  ${JSON.stringify(row)}`);

  const groupRow = aggregated.rows[0];
  if (!groupRow) return { title: 'Drill down into an aggregate', output, errors };

  // The PARAMETERIZED drilled query: each group key is pinned to a bind param.
  const parameterized = drillDown(revenuePerUser, engine);
  if ('query' in parameterized) {
    output.push(`drill params: ${parameterized.params.map((p) => `${p.field}→:${p.name}`).join(', ')}`);
  }

  // The convenience: extract this row's key values + run for that user.
  const drilled = drillDownInto(revenuePerUser, groupRow, engine);
  if ('query' in drilled) {
    output.push(
      `drilling into group ${JSON.stringify(groupRow)} with params ${JSON.stringify(drilled.params)} → underlying orders:`,
    );
    const underlying = await engine.run(drilled.query, { params: drilled.params });
    for (const row of underlying.rows) output.push(`  ${JSON.stringify(row)}`);
  } else {
    output.push(`drill-down failed: ${drilled.error.list.map((p) => p.code).join(', ')}`);
  }

  return { title: 'Drill down into an aggregate', output, errors };
}
