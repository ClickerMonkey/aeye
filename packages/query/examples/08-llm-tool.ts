/**
 * Example 08 — the LLM query tool + strict schema.
 *
 * `buildQueryTool` returns a framework-neutral tool an agent can call: it
 * validates the LLM's query, builds a runnable `Query`, and (with `run`)
 * executes it. `buildSchemas(engine, { strict: true })` produces Zod schemas
 * whose Type-name / field positions are enum-locked, so an LLM literally
 * cannot reference a Type or field that doesn't exist.
 */
import type { SelectDef } from '../src/index';
import { buildQueryTool, buildSchemas } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  // ── The tool ────────────────────────────────────────────────────────────
  const tool = buildQueryTool(engine, { run: true });
  output.push(`tool: ${tool.name} — ${tool.description}`);

  const goodQuery: SelectDef = {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'product', field: 'name' } },
      { expr: { kind: 'field-ref', source: 'product', field: 'price' } },
    ],
    from: { kind: 'type', type: 'product' },
    order: [{ expr: { kind: 'field-ref', source: 'product', field: 'price' }, dir: 'desc' }],
    limit: 3,
  };

  const built = await tool.build({ query: goodQuery });
  const errors = built.problems.list.filter((p) => p.severity === 'error').length;
  output.push(`build problems: ${built.problems.list.length} (errors: ${errors})`);
  if (built.result) {
    output.push('tool ran the query, top products by price:');
    for (const row of built.result.rows) output.push(`  ${JSON.stringify(row)}`);
  }

  // ── Strict schema ─────────────────────────────────────────────────────────
  const schemas = buildSchemas(engine, { strict: true });

  const validParse = schemas.Select.safeParse(goodQuery);
  output.push(`strict schema accepts valid select: ${validParse.success}`);

  const badQuery = { ...goodQuery, from: { kind: 'type', type: 'nope' } };
  const badParse = schemas.Select.safeParse(badQuery);
  output.push(`strict schema rejects unknown Type 'nope': ${!badParse.success}`);

  const productFilters = schemas.filtersForType('product');
  const goodClause = productFilters.safeParse({ field: 'price', op: 'gte', value: 30 });
  const badClause = productFilters.safeParse({ field: 'price', op: 'contains', value: 'x' });
  output.push(`strict filters accept (price,gte): ${goodClause.success}`);
  output.push(`strict filters reject (price,contains): ${!badClause.success}`);

  return { title: 'LLM query tool + strict schema', output, errors };
}
