/**
 * DML runtime: INSERT / UPDATE / DELETE via the transactional TypeState,
 * including RETURNING and ON CONFLICT. Each `run` uses a fresh RuntimeContext,
 * so to observe a mutation's effect we chain statements through a CTE or read
 * within the same run via RETURNING / a follow-up SELECT on the same context.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import type { InsertDef, UpdateDef, DeleteDef, SelectDef } from '../schema';
import { RuntimeContext } from '../runtime/context';

describe('insert / update / delete runtime', () => {
  it('INSERT VALUES with RETURNING assigns an id and returns it', async () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['name', 'age', 'email'],
      values: [
        [
          { kind: 'literal', value: 'Dee' },
          { kind: 'literal', value: 50 },
          { kind: 'literal', value: 'dee@example.com' },
        ],
      ],
      returning: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
      ],
    };
    const result = await fx.engine.run(def);
    expect(result.affected).toBe(1);
    // id auto-assigned as max(1,2,3)+1 = 4.
    expect(result.rows).toEqual([{ id: 4, name: 'Dee' }]);
  });

  it('INSERT then SELECT within the same RuntimeContext sees the new row', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const ins: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name', 'age', 'email'],
      values: [
        [
          { kind: 'literal', value: 99 },
          { kind: 'literal', value: 'Zed' },
          { kind: 'literal', value: 21 },
          { kind: 'literal', value: 'zed@example.com' },
        ],
      ],
    };
    await fx.engine.parseQuery(ins).execute(ctx);
    const sel: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 99 } }],
    };
    const result = await fx.engine.parseQuery(sel).execute(ctx);
    expect(result.rows).toEqual([{ name: 'Zed' }]);
  });

  it('INSERT ON CONFLICT DO NOTHING skips an existing key', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name', 'age', 'email'],
      values: [[
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 'NotAda' },
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 'x@example.com' },
      ]],
      onConflict: { fields: ['id'], doNothing: true },
    };
    const result = await fx.engine.parseQuery(def).execute(ctx);
    expect(result.affected).toBe(0);
  });

  it('INSERT ON CONFLICT UPDATE applies the assignment', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name', 'age', 'email'],
      values: [[
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 'Ada2' },
        { kind: 'literal', value: 37 },
        { kind: 'literal', value: 'ada@example.com' },
      ]],
      onConflict: {
        fields: ['id'],
        update: [{ field: 'name', value: { kind: 'literal', value: 'Ada Updated' } }],
      },
      returning: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
    };
    const result = await fx.engine.parseQuery(def).execute(ctx);
    expect(result.rows).toEqual([{ name: 'Ada Updated' }]);
  });

  it('INSERT ON CONFLICT UPDATE can reference the proposed EXCLUDED row', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name', 'age', 'email'],
      values: [[
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 'Ada Proposed' },
        { kind: 'literal', value: 77 },
        { kind: 'literal', value: 'ada@example.com' },
      ]],
      onConflict: {
        fields: ['id'],
        // name ← the proposed (excluded) name; age ← the proposed age.
        update: [
          { field: 'name', value: { kind: 'excluded', field: 'name' } },
          { field: 'age', value: { kind: 'excluded', field: 'age' } },
        ],
      },
      returning: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        { expr: { kind: 'field-ref', source: 'user', field: 'age' }, as: 'age' },
      ],
    };
    const result = await fx.engine.parseQuery(def).execute(ctx);
    expect(result.rows).toEqual([{ name: 'Ada Proposed', age: 77 }]);
  });

  it('an EXCLUDED reference outside ON CONFLICT is rejected by validation', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'excluded', field: 'name' }, as: 'x' }],
      from: { kind: 'type', type: 'user' },
    };
    const problems = fx.engine.validateQuery(def);
    expect(problems.list.some((p) => p.code === 'excluded.outside-conflict')).toBe(true);
  });

  it('UPDATE … WHERE with RETURNING', async () => {
    const fx = runtimeFixture();
    const def: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: [{ field: 'age', value: { kind: 'literal', value: 100 } }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 2 } }],
      returning: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'user', field: 'age' }, as: 'age' },
      ],
    };
    const result = await fx.engine.run(def);
    expect(result.affected).toBe(1);
    expect(result.rows).toEqual([{ id: 2, age: 100 }]);
  });

  it('DELETE … WHERE with RETURNING removes rows', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const del: DeleteDef = {
      kind: 'delete',
      from: 'order',
      where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 60 } }],
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
    };
    const result = await fx.engine.parseQuery(del).execute(ctx);
    // orders with total < 60: id 11 (50) and id 13 (25).
    expect(result.affected).toBe(2);
    expect(result.rows.map((r) => r['id']).sort()).toEqual([11, 13]);

    // The remaining orders no longer include the deleted ones.
    const sel: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, dir: 'asc' }],
    };
    const after = await fx.engine.parseQuery(sel).execute(ctx);
    expect(after.rows).toEqual([{ id: 10 }, { id: 12 }]);
  });
});
