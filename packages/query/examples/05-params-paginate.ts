/**
 * Example 05 — bind parameters + `autoPaginate`.
 *
 * Parameters (`{ kind: 'param', name }`) make a query a reusable template:
 * their type is inferred from how they're used and their value is supplied at
 * run time. `autoPaginate` rewrites a SELECT to bind `limit` / `offset` to
 * named params (when absent), and is IDEMPOTENT — applying it twice changes
 * nothing further.
 */
import { e } from '../src/index';
import type { SelectDef } from '../src/index';
import { autoPaginate } from '../src/index';
import { createExampleFixture } from './schema';
import type { ExampleReport } from './_util';

/** Describe a `limit` / `offset` slot for printing. */
function bound(value: SelectDef['limit']): string {
  if (value === undefined) return 'none';
  if (typeof value === 'number') return `literal(${value})`;
  return `param(${value.name})`;
}

export async function run(): Promise<ExampleReport> {
  const { engine } = createExampleFixture();
  const output: string[] = [];

  const base: SelectDef = {
    kind: 'select',
    fields: [
      { expr: e.ref('order', 'id').toJSON() },
      { expr: e.ref('order', 'total').toJSON() },
    ],
    from: { kind: 'type', type: 'order' },
    where: [e.gte(e.ref('order', 'total'), e.param('minTotal')).toJSON()],
    order: [{ expr: e.ref('order', 'id').toJSON(), dir: 'asc' }],
  };

  const paged = autoPaginate(base);
  output.push(`before: limit=${bound(base.limit)}, offset=${bound(base.offset)}`);
  output.push(`after:  limit=${bound(paged.limit)}, offset=${bound(paged.offset)}`);

  // Idempotent: a second pass leaves the params untouched.
  const pagedTwice = autoPaginate(paged);
  output.push(`twice:  limit=${bound(pagedTwice.limit)}, offset=${bound(pagedTwice.offset)}`);

  const errors = engine.validateQuery(paged).list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  const result = await engine.run(paged, { params: { minTotal: 25, limit: 2, offset: 1 } });
  output.push(`page (limit 2, offset 1) of orders ≥ 25:`);
  for (const row of result.rows) output.push(`  ${JSON.stringify(row)}`);

  return { title: 'Params + autoPaginate', output, errors };
}
