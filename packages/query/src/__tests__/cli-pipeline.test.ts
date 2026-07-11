/**
 * Offline smoke test for the interactive CLI's non-LLM pipeline.
 *
 * It exercises the exact path a model response would take — but with
 * HAND-WRITTEN query defs instead of a real LLM call — so the data→type
 * inference and build→run loop stay covered without any API key:
 *
 *   1. `loadDataDir(examples/data)` infers the expected Types from the bundled
 *      JSON (`users.json`→User, `orders.json`→Order, `products.json`→Product).
 *   2. A SELECT-with-filter def, fed through `buildQueryTool().build` then
 *      `engine.run`, returns the correct rows.
 *   3. An aggregate group-by def returns the correct grouped rows.
 *   4. `selectTypes` is exercised with a deterministic STUB embedder.
 *
 * No real provider is ever contacted.
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { QueryDef } from '../index';
import { selectTypes, type Embedder } from '../index';
import {
  loadDataDir,
  runBuiltQuery,
  buildQuery,
  typeNameFromFile,
} from '../../examples/cli';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'data');

describe('cli pipeline (offline)', () => {
  it('infers the expected Types + field counts from examples/data', () => {
    const { engine, types, warnings } = loadDataDir(DATA_DIR);
    expect(warnings).toEqual([]);

    const names = types.map((t) => t.name).sort();
    // `examples/data` also holds the Phase-H3 backing demo's datasets
    // (`projects.json` / `tasks.json`), so the inferred set includes them.
    expect(names).toEqual(['Order', 'Product', 'Project', 'Task', 'User']);

    const user = engine.registry.type('User')!;
    expect(user.fields.map((f) => f.name)).toEqual([
      'id',
      'name',
      'age',
      'email',
      'city',
    ]);

    const product = engine.registry.type('Product')!;
    expect(product.fields.map((f) => f.name).sort()).toEqual([
      'category',
      'id',
      'name',
      'price',
    ]);
  });

  it('derives Type names from filenames (singularize + capitalize)', () => {
    expect(typeNameFromFile('users.json')).toBe('User');
    expect(typeNameFromFile('orders.json')).toBe('Order');
    expect(typeNameFromFile('categories.json')).toBe('Category');
    expect(typeNameFromFile('boxes.json')).toBe('Box');
  });

  it('builds + runs a SELECT with a filter (rows the model would have produced)', async () => {
    const { engine } = loadDataDir(DATA_DIR);

    // Simulates a structured query an LLM would emit: users in London.
    const def: QueryDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'User', field: 'name' } },
        { expr: { kind: 'field-ref', source: 'User', field: 'city' } },
      ],
      from: { kind: 'type', type: 'User' },
      where: [
        {
          kind: 'comparison',
          op: '=',
          left: { kind: 'field-ref', source: 'User', field: 'city' },
          right: { kind: 'literal', value: 'London' },
        },
      ],
      order: [{ expr: { kind: 'field-ref', source: 'User', field: 'name' }, dir: 'asc' }],
    };

    const result = await runBuiltQuery(engine, def);
    expect(result.rows.map((r) => r.name)).toEqual(['Ada Lovelace', 'Cleo Nguyen']);
    expect(result.rows.every((r) => r.city === 'London')).toBe(true);
    expect(result.fields.map((f) => f.name)).toEqual(['name', 'city']);
  });

  it('builds + runs an aggregate group-by (revenue per user)', async () => {
    const { engine } = loadDataDir(DATA_DIR);

    const def: QueryDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'Order', field: 'userId' }, as: 'userId' },
        {
          expr: {
            kind: 'aggregate',
            function: 'sum', args: { value: { kind: 'field-ref', source: 'Order', field: 'total' } },
          },
          as: 'revenue',
        },
      ],
      from: { kind: 'type', type: 'Order' },
      groupBy: [{ kind: 'field-ref', source: 'Order', field: 'userId' }],
      order: [{ expr: { kind: 'field-ref', source: 'Order', field: 'userId' }, dir: 'asc' }],
    };

    const result = await runBuiltQuery(engine, def);
    // userId 1: 25+80=105, userId 2: 200+10=210, userId 3: 25+80=105
    const byUser = new Map(result.rows.map((r) => [Number(r.userId), Number(r.revenue)]));
    expect(byUser.get(1)).toBe(105);
    expect(byUser.get(2)).toBe(210);
    expect(byUser.get(3)).toBe(105);
  });

  it('reports problems (not a throw) for an invalid query def', async () => {
    const { engine } = loadDataDir(DATA_DIR);
    const bad: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'User', field: 'nope' } }],
      from: { kind: 'type', type: 'User' },
    };
    const built = await buildQuery(engine, bad);
    expect(built.query).toBeNull();
    expect(built.hasErrors).toBe(true);
    expect(built.report.length).toBeGreaterThan(0);
  });

  it('selectTypes narrows via a stub embedder (no real provider)', async () => {
    const { engine } = loadDataDir(DATA_DIR);

    // Deterministic stub: "order" text and the request both map to the same
    // 1-hot vector, so Order ranks first.
    const stub: Embedder = {
      embed: async (text: string) => {
        const t = text.toLowerCase();
        if (t.includes('order') || t.includes('revenue')) return [1, 0, 0];
        if (t.includes('user')) return [0, 1, 0];
        if (t.includes('product')) return [0, 0, 1];
        return [0, 0, 0];
      },
    };

    const picked = await selectTypes(engine, 'total revenue per order', {
      embedder: stub,
      topN: 1,
    });
    expect(picked.map((t) => t.name)).toEqual(['Order']);
  });
});
