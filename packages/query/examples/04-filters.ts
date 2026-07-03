/**
 * Example 04 — structured filters (execution-time bool Expr).
 *
 * A `filters` expression is a PLACEHOLDER bound to a source (with an optional
 * `fields` allowlist). The LLM never authors the predicate — the developer
 * supplies a BOOLEAN `Expr` / `ExprDef` at EXECUTION time, keyed by source.
 * `query.filters(engine)` introspects which sources a query exposes and the
 * fields each offers, so a UI can render controls. Here: products in the
 * `hardware` category priced at least 30.
 */
import { e } from '../src/index';
import type { ExprDef, SelectDef } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  const select: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('product', 'name').toJSON() },
      { expr: e.ref('product', 'price').toJSON() },
      { expr: e.ref('product', 'category').toJSON() },
    ],
    from: { kind: 'type', type: 'product' },
    // Just a placeholder + an allowlist; the predicate is supplied at run time.
    where: [e.filters('product', ['category', 'price']).toJSON()],
  };

  const errors = engine.validateQuery(select).list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  // Introspect the filterable sources + fields this query exposes.
  const exposed = engine.registry.parseQuery(select).filters(engine);
  for (const [source, info] of Object.entries(exposed)) {
    output.push(`filterable source '${source}': ${info.fields.map((f) => `${f.name}:${f.fieldType}`).join(', ')}`);
  }

  // Supply the bool ExprDef at execution time (what a UI's controls produce):
  // category = 'hardware' AND price >= 30.
  const productFilter: ExprDef = e
    .and(
      e.eq(e.ref('product', 'category'), e.value('hardware')),
      e.gte(e.ref('product', 'price'), e.value(30)),
    )
    .toJSON();
  const result = await engine.run(select, { filters: { product: productFilter } });
  output.push(`matching products (${result.rows.length}):`);
  for (const row of result.rows) output.push(`  ${JSON.stringify(row)}`);

  return { title: 'Structured filters', output, errors };
}
