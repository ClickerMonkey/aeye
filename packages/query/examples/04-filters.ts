/**
 * Example 04 — structured filters (execution-time bool Expr).
 *
 * A `filters` expression is a PLACEHOLDER bound to a source (with an optional
 * `fields` allowlist). The LLM never authors the predicate — the developer
 * supplies a BOOLEAN `Expr` at EXECUTION time, keyed by source. A filter-builder
 * UI that collects `{ field, op, value }` clauses turns them into that bool Expr
 * with `compileFilters` (each field type exposes its own op catalog: numbers get
 * `gte`/`between`, text gets `contains`/`startsWith`, etc.). Here: products in
 * the `hardware` category priced at least 30.
 */
import type { SelectDef } from '../src/index';
import { compileFilters } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  const select: SelectDef = {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'product', field: 'name' } },
      { expr: { kind: 'field-ref', source: 'product', field: 'price' } },
      { expr: { kind: 'field-ref', source: 'product', field: 'category' } },
    ],
    from: { kind: 'type', type: 'product' },
    // Just a placeholder + an allowlist; the clauses are supplied at run time.
    where: [{ kind: 'filters', source: 'product', fields: ['category', 'price'] }],
  };

  const errors = engine.validateQuery(select).list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  // Build the bool Expr from clauses (what a filter-builder UI would do).
  const productFilter = compileFilters(
    'product',
    [
      { field: 'category', op: 'eq', value: 'hardware' },
      { field: 'price', op: 'gte', value: 30 },
    ],
    engine.registry,
  );
  const result = await engine.run(select, { filters: { product: productFilter } });
  output.push(`matching products (${result.rows.length}):`);
  for (const row of result.rows) output.push(`  ${JSON.stringify(row)}`);

  return { title: 'Structured filters', output, errors };
}
