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
import { buildQueryTool, buildSchemas } from '../src/index';
import { LENIENT, SchemaParseError } from '@aeye/schema';
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

  // `tool.parse` decodes, validates + builds the runnable Query (throwing a
  // SchemaParseError whose message is what the model is told); `tool.run` executes it.
  let errors = 0;
  try {
    const query = await tool.parse(ctx, JSON.stringify({ query: goodQuery }));
    const result = await tool.run(query, ctx);
    output.push('build problems: 0 (errors: 0)');
    output.push('tool ran the query, top products by price:');
    for (const row of result.rows) output.push(`  ${JSON.stringify(row)}`);
  } catch (err) {
    if (err instanceof SchemaParseError) {
      errors = err.issues.length;
      output.push(`build problems: ${errors} (errors: ${errors})`);
    } else {
      throw err;
    }
  }

  // ── Strict schema ─────────────────────────────────────────────────────────
  const schemas = buildSchemas(engine, { strict: true });

  const accepts = (bound: { render(p: typeof LENIENT): { parse(v: unknown): { ok: boolean } } }, v: unknown) =>
    bound.render(LENIENT).parse(structuredClone(v)).ok;
  output.push(`strict schema accepts valid select: ${accepts(schemas.Select, goodQuery)}`);

  const badQuery = { ...goodQuery, from: { kind: 'type', type: 'nope' } };
  output.push(`strict schema rejects unknown Type 'nope': ${!accepts(schemas.Select, badQuery)}`);

  // A `filters` placeholder is locked to a known source + its field-name allowlist.
  output.push(`strict filters accept a known source + fields: ${accepts(schemas.Expr, { kind: 'filters', source: 'product', fields: ['price', 'category'] })}`);
  output.push(`strict filters reject an unknown field: ${!accepts(schemas.Expr, { kind: 'filters', source: 'product', fields: ['nope'] })}`);

  return { title: 'LLM query tool + strict schema', output, errors };
}
