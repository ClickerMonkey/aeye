/**
 * Execution-time `filters` on `engine.run` / `engine.toSQL`.
 *
 * A query carries a `{ kind:'filters', source, fields? }` PLACEHOLDER; the
 * caller supplies a BOOLEAN `Expr` (or `ExprDef`) at execution time, keyed by
 * source (`run(query, { filters: { <source>: <boolExpr> } })`). The placeholder
 * emits/evaluates it — the query is never mutated. `null` / absent ⇒ a vacuous
 * TRUE. A filter-builder UI builds the bool expr from clauses with
 * `compileFilters`.
 */
import { describe, it, expect } from 'vitest';
import type { ExprDef, SelectDef } from '../schema';
import { compileFilters } from '../filters';
import type { Registry } from '../registry';
import { runtimeFixture } from './_utils';

/** All orders (id + total) with a `filters` placeholder over `order`. */
function allOrders(fields?: string[]): SelectDef {
  return {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' },
      { expr: { kind: 'field-ref', source: 'order', field: 'total' }, as: 'total' },
    ],
    from: { kind: 'type', type: 'order' },
    where: [fields ? { kind: 'filters', source: 'order', fields } : { kind: 'filters', source: 'order' }],
  };
}

/** A `total >= n` bool ExprDef on the `order` source (built from a clause). */
function totalAtLeast(registry: Registry, n: number): Record<string, ExprDef> {
  return { order: compileFilters('order', [{ field: 'total', op: 'gte', value: n }], registry).toJSON() };
}

describe('engine.run — execution filters', () => {
  it('applies the filter and returns the filtered rows', async () => {
    const fx = runtimeFixture();

    // No clauses ⇒ a vacuous TRUE ⇒ all four orders.
    const all = await fx.engine.run(allOrders());
    expect(all.rows.length).toBe(4);

    // Filtered: only totals >= 100 (the 100 and 200 orders).
    const filtered = await fx.engine.run(allOrders(), { filters: totalAtLeast(fx.registry, 100) });
    expect(filtered.rows.length).toBe(2);
    expect(filtered.rows.every((r) => Number(r['total']) >= 100)).toBe(true);
    // `fields` carry over unchanged.
    expect(filtered.fields.map((f) => f.name)).toEqual(['id', 'total']);
  });

  it('a `null` filter for a source is a no-op (all rows)', async () => {
    const fx = runtimeFixture();
    const result = await fx.engine.run(allOrders(), { filters: { order: null } });
    expect(result.rows.length).toBe(4);
  });

  it('accepts an Expr instance (not just an ExprDef)', async () => {
    const fx = runtimeFixture();
    const expr = compileFilters('order', [{ field: 'total', op: 'gte', value: 100 }], fx.registry);
    const result = await fx.engine.run(allOrders(), { filters: { order: expr } });
    expect(result.rows.length).toBe(2);
  });

  it('does not mutate the caller query', async () => {
    const fx = runtimeFixture();
    const def = allOrders();
    await fx.engine.run(def, { filters: totalAtLeast(fx.registry, 100) });
    // The placeholder is the only WHERE entry, untouched by the run.
    expect(def.where).toEqual([{ kind: 'filters', source: 'order' }]);
  });
});

describe('engine.toSQL — execution filters', () => {
  it('emits the supplied filter into WHERE (golden)', () => {
    const fx = runtimeFixture();
    const { sql, params } = fx.engine.toSQL(allOrders(), 'base', { filters: totalAtLeast(fx.registry, 100) });
    expect(sql).toContain('WHERE');
    // The compiled `order.total >= ?` predicate emits a `>=` against a bind param.
    expect(sql).toContain('>=');
    expect(sql).toContain('?');
    expect(params).toEqual([100]);
  });

  it('emits a vacuous TRUE for the placeholder when no filter is supplied', () => {
    const fx = runtimeFixture();
    const { sql } = fx.engine.toSQL(allOrders(), 'base');
    expect(sql).toContain('WHERE TRUE');
  });
});
