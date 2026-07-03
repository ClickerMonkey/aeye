/**
 * Example 08 — the LLM query tool + strict schema.
 *
 * `buildQueryTool` returns a framework-neutral tool an agent can call: it
 * validates the LLM's query, builds a runnable `Query`, and (with `run`)
 * executes it. `buildSchemas(engine, { strict: true })` produces Zod schemas
 * whose Type-name / field positions are enum-locked, so an LLM literally
 * cannot reference a Type or field that doesn't exist.
 */
import type { Context } from '@aeye/core';
import type { SelectDef } from '../src/index';
import { buildQueryTool, QueryToolError, buildSchemas } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];
  const ctx: Context<{}, {}> = {};

  // ── The tool ────────────────────────────────────────────────────────────
  const tool = buildQueryTool(engine);
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

  // `tool.parse` validates + builds the runnable Query (throwing a
  // QueryToolError with the formatted report on failure); `tool.run` executes it.
  let errors = 0;
  try {
    const query = await tool.parse(ctx, JSON.stringify({ query: goodQuery }));
    const result = await tool.run(query, ctx);
    output.push('build problems: 0 (errors: 0)');
    output.push('tool ran the query, top products by price:');
    for (const row of result.rows) output.push(`  ${JSON.stringify(row)}`);
  } catch (err) {
    if (err instanceof QueryToolError) {
      errors = err.problems.list.filter((p) => p.severity === 'error').length;
      output.push(`build problems: ${err.problems.list.length} (errors: ${errors})`);
    } else {
      throw err;
    }
  }

  // ── Strict schema ─────────────────────────────────────────────────────────
  const schemas = buildSchemas(engine, { strict: true });

  const validParse = schemas.Select.safeParse(goodQuery);
  output.push(`strict schema accepts valid select: ${validParse.success}`);

  const badQuery = { ...goodQuery, from: { kind: 'type', type: 'nope' } };
  const badParse = schemas.Select.safeParse(badQuery);
  output.push(`strict schema rejects unknown Type 'nope': ${!badParse.success}`);

  // A `filters` placeholder is locked to a known source + its field-name allowlist.
  const goodFilter = schemas.Expr.safeParse({ kind: 'filters', source: 'product', fields: ['price', 'category'] });
  const badFilter = schemas.Expr.safeParse({ kind: 'filters', source: 'product', fields: ['nope'] });
  output.push(`strict filters accept a known source + fields: ${goodFilter.success}`);
  output.push(`strict filters reject an unknown field: ${!badFilter.success}`);

  return { title: 'LLM query tool + strict schema', output, errors };
}
