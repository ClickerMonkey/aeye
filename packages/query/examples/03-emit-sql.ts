/**
 * Example 03 — convert a query to SQL for multiple dialects.
 *
 * The same query emits different SQL per dialect: the base dialect uses `?`
 * placeholders, Postgres uses `$1`, `$2`, … . A relation JOIN (`user.orders`)
 * shows the planner synthesizing the join key from the relation — the author
 * never writes an ON clause.
 */
import type { SelectDef } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  const select: SelectDef = {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'user', field: 'name' } },
      { expr: { kind: 'field-ref', source: 'order', field: 'total' } },
    ],
    from: { kind: 'type', type: 'user' },
    joins: [{ on: { source: 'user', field: 'orders' }, joinType: 'inner' }],
    where: [
      {
        kind: 'comparison',
        op: '>',
        left: { kind: 'field-ref', source: 'order', field: 'total' },
        right: { kind: 'param', name: 'minTotal' },
      },
    ],
    order: [{ expr: { kind: 'field-ref', source: 'order', field: 'total' }, dir: 'desc' }],
    limit: 5,
  };

  const errors = engine.validateQuery(select).list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  const params = { minTotal: 50 };
  for (const dialect of ['base', 'postgres']) {
    const emitted = engine.toSQL(select, dialect, { params });
    output.push(`[${dialect}] ${emitted.sql}`);
    output.push(`[${dialect}] params: ${JSON.stringify(emitted.params)}`);
  }

  return { title: 'Emit SQL (base + postgres)', output, errors };
}
