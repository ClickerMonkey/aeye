/**
 * FEATURE — table-valued function in FROM: `FROM <fn>(args) AS <alias>`.
 * The source resolves to the tabular function's output Type, runs the
 * registered tabular implementation for rows, and emits `fn(args) AS alias`.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import type { SelectDef } from '../schema';
import { Value } from '../runtime/value';
import type { NamedArgs } from '../runtime/functions';
import { buildSchemas } from '../llm/index';

/** Read a named arg, NULL when absent. */
const get = (a: NamedArgs, k: string): Value => a[k] ?? Value.null();

/** A runtime fixture with a `rangeRows(count)` tabular function over `user`. */
function tabularFixture() {
  const fx = runtimeFixture();
  const r = fx.registry;
  // rangeRows(count: number): rows of the `user` Type ({ id, name }).
  r.registerFunction({ name: 'rangeRows', shape: 'tabular', params: [{ name: 'count', type: { kind: 'number' } }], output: { type: 'user' } });
  r.registerFunctionRun('rangeRows', {
    shape: 'tabular',
    run: (a) => {
      const n = get(a, 'count').isNull() ? 0 : Math.trunc(get(a, 'count').toNumber());
      const rows: { id: number; name: string }[] = [];
      for (let i = 0; i < n; i++) rows.push({ id: i, name: `row${i}` });
      return Value.of(rows);
    },
  });
  return fx;
}

const fromFnSelect: SelectDef = {
  kind: 'select',
  fields: [
    { expr: { kind: 'field-ref', source: 'r', field: 'id' }, as: 'id' },
    { expr: { kind: 'field-ref', source: 'r', field: 'name' }, as: 'name' },
  ],
  from: { kind: 'function', function: 'rangeRows', args: { count: { kind: 'literal', value: 3 } }, as: 'r' },
  order: [{ expr: { kind: 'field-ref', source: 'r', field: 'id' }, dir: 'asc' }],
};

describe('table-valued function source (FROM fn(args) AS alias)', () => {
  it('resolves to the tabular function output Type (alias-sourced fields)', () => {
    const fx = tabularFixture();
    const resolved = fx.engine.resolveQuery(fromFnSelect);
    // Two output fields (id, name) over the function's `user` output type.
    expect(resolved.kind).toBe('type');
    const problems = fx.engine.validateQuery(fromFnSelect);
    expect(problems.hasErrors).toBe(false);
  });

  it('runs the registered tabular function for its rows', async () => {
    const fx = tabularFixture();
    const result = await fx.engine.run(fromFnSelect);
    expect(result.rows).toEqual([
      { id: 0, name: 'row0' },
      { id: 1, name: 'row1' },
      { id: 2, name: 'row2' },
    ]);
  });

  it('emits FROM fn(args) AS alias (base + postgres)', () => {
    const fx = tabularFixture();
    const base = fx.engine.toSQL(fromFnSelect, 'base');
    expect(base.sql).toBe(
      'SELECT "r"."id" AS "id", "r"."name" AS "name" FROM rangeRows(?) AS "r" ORDER BY "r"."id" ASC',
    );
    expect(base.params).toEqual([3]);
    const pg = fx.engine.toSQL(fromFnSelect, 'postgres');
    expect(pg.sql).toContain('FROM rangeRows($1) AS "r"');
  });

  it('round-trips through toJSON', () => {
    const fx = tabularFixture();
    const back = fx.engine.parseQuery(fromFnSelect).toJSON();
    expect(back).toEqual(fromFnSelect);
  });

  it('the LLM Source schema offers a function source only when a tabular fn exists', () => {
    const withFn = tabularFixture();
    const offered = buildSchemas(withFn.engine).Source.safeParse({
      kind: 'function',
      function: 'rangeRows',
      args: { count: { kind: 'literal', value: 2 } },
      as: 'r',
    });
    expect(offered.success).toBe(true);

    // No tabular function registered ⇒ the function-source branch is gated out.
    const noFn = runtimeFixture();
    const gated = buildSchemas(noFn.engine).Source.safeParse({
      kind: 'function',
      function: 'nope',
      args: {},
      as: 'r',
    });
    expect(gated.success).toBe(false);
  });
});
