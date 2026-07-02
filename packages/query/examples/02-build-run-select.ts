/**
 * Example 02 — build, validate, and RUN a SELECT in-memory.
 *
 * Selects every user older than 30, ordered by age, and runs it against the
 * bundled data. Shows the returned rows plus the result metadata (resolved
 * output fields + their types).
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
      { expr: { kind: 'field-ref', source: 'user', field: 'age' } },
      { expr: { kind: 'field-ref', source: 'user', field: 'city' } },
    ],
    from: { kind: 'type', type: 'user' },
    where: [
      {
        kind: 'comparison',
        op: '>',
        left: { kind: 'field-ref', source: 'user', field: 'age' },
        right: { kind: 'literal', value: 30 },
      },
    ],
    order: [{ expr: { kind: 'field-ref', source: 'user', field: 'age' }, dir: 'asc' }],
  };

  const problems = engine.validateQuery(select);
  const errors = problems.list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  const result = await engine.run(select);
  output.push(`rows (${result.rows.length}):`);
  for (const row of result.rows) output.push(`  ${JSON.stringify(row)}`);
  output.push(`fields: ${result.fields.map((c) => `${c.name}:${c.type.kind}`).join(', ')}`);
  output.push(`output type: ${result.outputType.name}`);

  return { title: 'Build → validate → run a SELECT', output, errors };
}
