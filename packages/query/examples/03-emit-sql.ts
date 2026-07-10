/**
 * Example 03 — convert a query to SQL for multiple dialects, built with the
 * ergonomic `e.*` expression builder.
 *
 * Every expression is composed with `e.*` (which returns real `Expr` instances)
 * instead of hand-written `ExprDef` JSON. Two usages are shown:
 *  1. STANDALONE — `engine.exprToSQL(e.and(…), 'postgres')` emits a lone
 *     predicate's SQL + params directly, no surrounding query.
 *  2. EMBEDDED — a built expr's `.toJSON()` drops into a `SelectDef` (whose
 *     `where` / `order` / field slots are `ExprDef`), then `engine.toSQL`
 *     emits it.
 *
 * The same query emits different SQL per dialect: the base dialect uses `?`
 * placeholders, Postgres uses `$1`, `$2`, … . A relation JOIN (`user.orders`)
 * shows the planner synthesizing the join key from the relation — the author
 * never writes an ON clause.
 */
import { e } from '../src/index';
import type { SelectDef } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  // 1. STANDALONE — emit a lone predicate built with `e.*`, no query around it.
  const predicate = e.and(
    e.gt(e.ref('order', 'total'), e.param('minTotal')),
    e.eq(e.ref('order', 'status'), e.value('paid')),
  );
  const standalone = engine.exprToSQL(predicate, 'postgres', { params: { minTotal: 50 } });
  output.push(`[standalone] ${standalone.sql}`);
  output.push(`[standalone] params: ${JSON.stringify(standalone.params)}`);

  // 2. EMBEDDED — the same builder feeds a full SELECT via `.toJSON()` (the
  //    `where` / `order` / field slots are all `ExprDef`).
  const select: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('user', 'name').toJSON() },
      { expr: e.ref('order', 'total').toJSON() },
    ],
    from: { kind: 'type', type: 'user' },
    joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' }, joinType: 'inner' }],
    where: [e.gt(e.ref('order', 'total'), e.param('minTotal')).toJSON()],
    order: [{ expr: e.ref('order', 'total').toJSON(), dir: 'desc' }],
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

  return { title: 'Emit SQL (e.* builder, base + postgres)', output, errors };
}
