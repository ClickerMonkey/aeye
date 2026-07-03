/**
 * Example 02 — build, validate, and RUN a SELECT in-memory.
 *
 * Selects every user older than 30, ordered by age, and runs it against the
 * bundled data. Shows the returned rows plus the result metadata (resolved
 * output fields + their types).
 */
import { e } from '../src/index';
import type { SelectDef } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  const select: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('user', 'name').toJSON() },
      { expr: e.ref('user', 'age').toJSON() },
      { expr: e.ref('user', 'city').toJSON() },
    ],
    from: { kind: 'type', type: 'user' },
    where: [e.gt(e.ref('user', 'age'), e.value(30)).toJSON()],
    order: [{ expr: e.ref('user', 'age').toJSON(), dir: 'asc' }],
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
