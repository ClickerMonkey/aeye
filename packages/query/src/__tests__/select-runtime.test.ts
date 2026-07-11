/**
 * SELECT runtime: FROM / WHERE / relation-JOIN / GROUP BY + aggregate /
 * HAVING / ORDER / LIMIT / OFFSET / DISTINCT over the in-memory dataset.
 * Asserts both result rows AND result metadata (output type + fields).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import type { SelectDef } from '../schema';

describe('select runtime', () => {
  it('FROM + WHERE filters rows and reports output metadata', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
      ],
      from: { kind: 'type', type: 'user' },
      where: [
        { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 30 } },
      ],
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Bob' },
    ]);
    // Metadata
    expect(result.fields.map((c) => c.name)).toEqual(['id', 'name']);
    expect(result.outputType.field('id')?.fieldType.resolve()).toBe('number');
    expect(result.outputType.field('name')?.fieldType.resolve()).toBe('text');
  });

  it('relation JOIN (has-many default convention) expands matched rows', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        { expr: { kind: 'field-ref', source: 'o', field: 'total' }, as: 'total' },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' }, joinType: 'inner' }],
      order: [{ expr: { kind: 'field-ref', source: 'o', field: 'id' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([
      { name: 'Ada', total: 100 },
      { name: 'Ada', total: 50 },
      { name: 'Bob', total: 200 },
      { name: 'Bob', total: 25 },
    ]);
  });

  it('GROUP BY + aggregate + HAVING', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'userId' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'o', field: 'total' } } }, as: 'spent' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'orders' },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' }, joinType: 'inner' }],
      groupBy: [{ kind: 'field-ref', source: 'user', field: 'id' }],
      having: [
        { kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'o', field: 'total' } } }, right: { kind: 'literal', value: 200 } },
      ],
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([{ userId: 2, spent: 225, orders: 2 }]);
    expect(result.fields.map((c) => c.name)).toEqual(['userId', 'spent', 'orders']);
  });

  it('ORDER BY desc + LIMIT + OFFSET', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'age' }, dir: 'desc' }],
      limit: 1,
      offset: 1,
    };
    const result = await fx.engine.run(def);
    // ages: Bob 42, Ada 36, Cleo 29 → desc → [Bob, Ada, Cleo]; offset 1 limit 1 → Ada.
    expect(result.rows).toEqual([{ name: 'Ada' }]);
  });

  it('DISTINCT removes duplicate projected rows', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' }],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: { kind: 'field-ref', source: 'order', field: 'userId' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([{ userId: 1 }, { userId: 2 }]);
  });

  it('LIMIT via bound param', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
      limit: { kind: 'param', name: 'top' },
    };
    const result = await fx.engine.run(def, { params: { top: 2 } });
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('validateQuery is clean for a well-formed select', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
    };
    const problems = fx.engine.validateQuery(def);
    expect(problems.hasErrors).toBe(false);
  });
});
