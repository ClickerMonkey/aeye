/**
 * Example 07 — cost estimation + a constraint rejection.
 *
 * Every query has a bottom-up `{ rows, bytes }` cost estimate driven by the
 * Type's `count` / `bytes` and any matching indexes. Passing `CostConstraints`
 * to validation rejects a query whose estimate blows past the cap, with a
 * `cost.rows-exceeded` / `cost.bytes-exceeded` problem.
 *
 * The `user` Type estimates 1000 rows. A scan filtered only on the
 * non-indexed `city` field still estimates in the hundreds, so a
 * `maxRows: 100` cap rejects it — exactly the intended outcome.
 */
import type { SelectDef } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  const scan: SelectDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
    from: { kind: 'type', type: 'user' },
    where: [
      {
        kind: 'comparison',
        op: '=',
        left: { kind: 'field-ref', source: 'user', field: 'city' },
        right: { kind: 'literal', value: 'London' },
      },
    ],
  };

  const cost = engine.cost(scan);
  output.push(`estimated cost: rows≈${cost.rows}, bytes≈${cost.bytes}`);

  // Validate with a strict row cap — expect a cost-rejection problem.
  const problems = engine.validateQuery(scan, undefined, { maxRows: 100 });
  const costProblems = problems.list.filter((p) => p.code.startsWith('cost.'));
  output.push(`cost constraint problems (${costProblems.length}):`);
  for (const p of costProblems) output.push(`  [${p.code}] ${p.message}`);

  // The example is "green" when the rejection fired as intended.
  const rejected = costProblems.length > 0;
  output.push(`rejected as expected: ${rejected}`);

  return { title: 'Cost estimation + constraint rejection', output, errors: rejected ? 0 : 1 };
}
