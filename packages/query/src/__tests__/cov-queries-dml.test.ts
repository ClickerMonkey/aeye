/**
 * Coverage: INSERT / UPDATE / DELETE query classes + the shared `_type`
 * transactional helpers + the `_sql` DML-degrade error. Exercises validation
 * Problem codes, cost, toJSON/clone round-trips, ON CONFLICT (DO UPDATE w/
 * EXCLUDED + DO NOTHING), INSERT…SELECT, joined DML SQL (FROM/USING + WITH agg
 * CTE + join `and`), and same-transaction insert→update / insert→delete.
 *
 * Builds small LOCAL fixtures (it does not edit `_utils`).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { RuntimeContext } from '../runtime/context';
import { arrayExecutor } from '../runtime/executor';
import { BaseDialect } from '../sql/index';
import { InsertQuery } from '../queries/insert';
import { UpdateQuery } from '../queries/update';
import { DeleteQuery } from '../queries/delete';
import { runtimeFixture, fixture } from './_utils';
import type { Registry } from '../registry';
import type { TypeDef, InsertDef, UpdateDef, DeleteDef, QueryDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

/** A dialect that declares it cannot express joined DML (degrade path). */
class NoDmlJoinDialect extends BaseDialect {
  override readonly name = 'no-dml-join';
  override get supportsDmlJoins(): boolean {
    return false;
  }
}

// ─── A local `widget` type with a TEXT id (drives `_type.nextId` string path) ─

const widgetDef: TypeDef = {
  name: 'widget',
  fields: [
    { name: 'id', type: { kind: 'text' } },
    { name: 'label', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'widget', field: 'id' }, count: 1 }] }],
  count: 10,
  bytes: 32,
};

function widgetEngine(rows: SourceRecord[]): { registry: Registry; engine: QueryEngine } {
  const registry = createRegistry();
  const widget = registry.parseType(widgetDef);
  registry.registerType(widget);
  registry.finalize();
  const engine = new QueryEngine(registry, { executors: { widget: arrayExecutor(rows) } });
  return { registry, engine };
}

describe('_type helpers — id generation + transactional inserted/updated/deleted', () => {
  it('nextId falls back to a string gen-id when no numeric id exists', async () => {
    const { engine } = widgetEngine([{ id: 'a', label: 'x' }]);
    const def: InsertDef = {
      kind: 'insert',
      into: 'widget',
      fields: ['label'],
      values: [[{ kind: 'literal', value: 'y' }]],
      returning: [{ expr: { kind: 'field-ref', source: 'widget', field: 'id' }, as: 'id' }],
    };
    const res = await engine.run(def);
    // current.length === 1 (>0), no numeric id ⇒ `gen-${1+1}`.
    expect(res.rows).toEqual([{ id: 'gen-2' }]);
  });

  it('nextId returns max+1 (=1) when inserting into an empty type', async () => {
    const { engine } = widgetEngine([]);
    const def: InsertDef = {
      kind: 'insert',
      into: 'widget',
      fields: ['label'],
      values: [[{ kind: 'literal', value: 'first' }]],
      returning: [{ expr: { kind: 'field-ref', source: 'widget', field: 'id' }, as: 'id' }],
    };
    const res = await engine.run(def);
    expect(res.rows).toEqual([{ id: 1 }]);
  });

  it('an INSERT then UPDATE of the SAME row in one tx mutates the inserted record', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const ins: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name', 'age', 'email'],
      values: [[
        { kind: 'literal', value: 50 },
        { kind: 'literal', value: 'New' },
        { kind: 'literal', value: 20 },
        { kind: 'literal', value: 'new@example.com' },
      ]],
    };
    await fx.engine.parseQuery(ins).execute(ctx);
    const upd: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: [{ field: 'age', value: { kind: 'literal', value: 21 } }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 50 } }],
      returning: [{ expr: { kind: 'field-ref', source: 'user', field: 'age' }, as: 'age' }],
    };
    const res = await fx.engine.parseQuery(upd).execute(ctx);
    expect(res.rows).toEqual([{ age: 21 }]);
  });

  it('an INSERT then DELETE of the SAME row in one tx removes the inserted record', async () => {
    const fx = runtimeFixture();
    const ctx = new RuntimeContext(fx.engine);
    const ins: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name', 'age', 'email'],
      values: [[
        { kind: 'literal', value: 60 },
        { kind: 'literal', value: 'Temp' },
        { kind: 'literal', value: 30 },
        { kind: 'literal', value: 'temp@example.com' },
      ]],
    };
    await fx.engine.parseQuery(ins).execute(ctx);
    const del: DeleteDef = {
      kind: 'delete',
      from: 'user',
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 60 } }],
    };
    const res = await fx.engine.parseQuery(del).execute(ctx);
    expect(res.affected).toBe(1);
    // The row is gone again.
    const sel: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 60 } }],
    };
    const after = await fx.engine.parseQuery(sel).execute(ctx);
    expect(after.rows).toEqual([]);
  });
});

describe('InsertQuery — validation / cost / SQL / serialization', () => {
  it('reports unknown target type, unknown field, arity mismatch, and ON CONFLICT unknown field', () => {
    const fx = runtimeFixture();
    const badType: InsertDef = { kind: 'insert', into: 'nope', fields: ['x'], values: [[{ kind: 'literal', value: 1 }]] };
    expect(fx.engine.validateQuery(badType).list.some((p) => p.code === 'insert.unknown-type')).toBe(true);

    const badField: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['nope', 'name'],
      values: [[{ kind: 'literal', value: 1 }, { kind: 'literal', value: 'a' }]],
    };
    expect(fx.engine.validateQuery(badField).list.some((p) => p.code === 'insert.unknown-field')).toBe(true);

    const badArity: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['name', 'age'],
      values: [[{ kind: 'literal', value: 'a' }]],
    };
    expect(fx.engine.validateQuery(badArity).list.some((p) => p.code === 'insert.arity')).toBe(true);

    const badConflictField: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id'],
      values: [[{ kind: 'literal', value: 1 }]],
      onConflict: { fields: ['id'], update: [{ field: 'nope', value: { kind: 'literal', value: 1 } }] },
    };
    expect(fx.engine.validateQuery(badConflictField).list.some((p) => p.code === 'insert.unknown-field')).toBe(true);
  });

  it('INSERT … SELECT runs, costs from the source query, and reports its referenced types', async () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['name', 'age', 'email'],
      select: {
        kind: 'select',
        fields: [
          { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
          { expr: { kind: 'field-ref', source: 'user', field: 'age' }, as: 'age' },
          { expr: { kind: 'field-ref', source: 'user', field: 'email' }, as: 'email' },
        ],
        from: { kind: 'type', type: 'user' },
        where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 1 } }],
      },
    };
    const q = fx.engine.parseQuery(def);
    expect(q.referencedTypes()).toContain('user');
    expect(fx.engine.cost(def).rows).toBeGreaterThanOrEqual(1);
    const res = await fx.engine.run(def);
    expect(res.affected).toBe(1);
    // SQL: INSERT … SELECT.
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql).toContain('INSERT INTO "user"');
    expect(sql).toContain('SELECT');
  });

  it('emits ON CONFLICT DO UPDATE SET with EXCLUDED + RETURNING (base + postgres)', () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name'],
      values: [[{ kind: 'literal', value: 1 }, { kind: 'literal', value: 'A' }]],
      onConflict: {
        fields: ['id'],
        update: [{ field: 'name', value: { kind: 'excluded', field: 'name' } }],
      },
      returning: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
    };
    const base = fx.engine.toSQL(def, 'base');
    expect(base.sql).toContain('ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"');
    expect(base.sql).toContain('RETURNING "user"."id" AS "id"');
    const pg = fx.engine.toSQL(def, 'postgres');
    expect(pg.sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
  });

  it('emits ON CONFLICT … DO NOTHING (explicit + empty update)', () => {
    const fx = runtimeFixture();
    const doNothing: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id'],
      values: [[{ kind: 'literal', value: 1 }]],
      onConflict: { fields: ['id'], doNothing: true },
    };
    expect(fx.engine.toSQL(doNothing, 'base').sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it('cost is the VALUES tuple count × per-row size, and 0 for an unknown type', () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['name'],
      values: [[{ kind: 'literal', value: 'a' }], [{ kind: 'literal', value: 'b' }]],
    };
    expect(fx.engine.cost(def).rows).toBe(2);
    const bad: InsertDef = { kind: 'insert', into: 'nope', fields: ['x'], values: [[{ kind: 'literal', value: 1 }]] };
    expect(fx.engine.cost(bad)).toEqual({ rows: 1, bytes: 0 });
  });

  it('round-trips through toJSON and clone (values / onConflict update + doNothing)', () => {
    const fx = runtimeFixture();
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name'],
      values: [[{ kind: 'literal', value: 1 }, { kind: 'literal', value: 'A' }]],
      onConflict: {
        fields: ['id'],
        doNothing: true,
        update: [{ field: 'name', value: { kind: 'literal', value: 'B' } }],
      },
      returning: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'k' }],
    };
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual(def);
    expect(q.clone().toJSON()).toEqual(def);
  });

  it('InsertQuery.from rejects a non-insert def', () => {
    const fx = runtimeFixture();
    expect(() => InsertQuery.from({ kind: 'select' } as unknown as QueryDef, fx.registry)).toThrow(/expected 'insert'/);
  });

  it('an unknown target type yields zero affected rows at runtime', async () => {
    const fx = runtimeFixture();
    const res = await fx.engine.run({ kind: 'insert', into: 'nope', fields: ['x'], values: [[{ kind: 'literal', value: 1 }]] } as InsertDef);
    expect(res.affected).toBe(0);
  });
});

describe('UpdateQuery — validation / cost / SQL / serialization', () => {
  it('reports unknown target type and unknown SET field', () => {
    const fx = runtimeFixture();
    const badType: UpdateDef = { kind: 'update', type: 'nope', set: [{ field: 'x', value: { kind: 'literal', value: 1 } }] };
    expect(fx.engine.validateQuery(badType).list.some((p) => p.code === 'update.unknown-type')).toBe(true);
    const badField: UpdateDef = { kind: 'update', type: 'user', set: [{ field: 'nope', value: { kind: 'literal', value: 1 } }] };
    expect(fx.engine.validateQuery(badField).list.some((p) => p.code === 'update.unknown-field')).toBe(true);
  });

  it('costs the target scan × join fan-out (and 0 for an unknown type)', () => {
    const fx = runtimeFixture();
    const def: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'x' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 18 } }],
    };
    expect(fx.engine.cost(def).rows).toBeGreaterThan(0);
    expect(fx.engine.cost({ kind: 'update', type: 'nope', set: [{ field: 'x', value: { kind: 'literal', value: 1 } }] } as UpdateDef)).toEqual({ rows: 0, bytes: 0 });
  });

  it('emits a joined UPDATE … FROM for a fan-out aggregate and a join `and` predicate', () => {
    const fx = fixture();
    // SET value references a FAN-OUT aggregate over an explicit relation JOIN
    // (user.orders.total). Post-refactor there is no hidden pre-aggregation CTE:
    // the aggregate runs inline over the joined rows via UPDATE … FROM.
    const aggUpdate: UpdateDef = {
      kind: 'update',
      type: 'user',
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
      set: [{ field: 'age', value: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'order', field: 'total' } } } }],
    };
    const aggSql = fx.engine.toSQL(aggUpdate, 'base').sql;
    expect(aggSql).toBe(
      'UPDATE "user" SET "age" = sum("order"."total") FROM "order" AS "order" WHERE "user"."id" = "order"."userId"',
    );

    // Authored join WITH an `and` extra predicate + RETURNING.
    const joinAnd: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'vip' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' }, and: { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 18 } } }],
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
    };
    const j = fx.engine.toSQL(joinAnd, 'postgres').sql;
    expect(j).toContain('FROM "user" AS "user"');
    expect(j).toContain('"user"."age" > ');
    expect(j).toContain('RETURNING "order"."id" AS "id"');
  });

  it('round-trips through toJSON and clone (set / joins / where / returning)', () => {
    const fx = runtimeFixture();
    const def: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'x' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 1 } }],
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
    };
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual(def);
    expect(q.clone().toJSON()).toEqual(def);
  });

  it('UpdateQuery.from rejects a non-update def, and an unknown type runs as a no-op', async () => {
    const fx = runtimeFixture();
    expect(() => UpdateQuery.from({ kind: 'select' } as unknown as QueryDef, fx.registry)).toThrow(/expected 'update'/);
    const res = await fx.engine.run({ kind: 'update', type: 'nope', set: [{ field: 'x', value: { kind: 'literal', value: 1 } }] } as UpdateDef);
    expect(res.affected).toBe(0);
  });
});

describe('DeleteQuery — validation / cost / SQL / serialization', () => {
  it('reports an unknown target type', () => {
    const fx = runtimeFixture();
    const bad: DeleteDef = { kind: 'delete', from: 'nope' };
    expect(fx.engine.validateQuery(bad).list.some((p) => p.code === 'delete.unknown-type')).toBe(true);
  });

  it('flags a join hop that collides with the DML target as source.duplicate', () => {
    const fx = runtimeFixture();
    // DELETE FROM order, hop1 → user, hop2 (user.orders) → order: the 2nd hop's
    // alias 'order' collides with the FROM target 'order'.
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [
        { on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } },
        { on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } },
      ],
    };
    expect(fx.engine.validateQuery(def).list.some((p) => p.code === 'source.duplicate')).toBe(true);
  });

  it('costs the target scan × join fan-out (and 0 for an unknown type)', () => {
    const fx = runtimeFixture();
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 99 } }],
    };
    expect(fx.engine.cost(def).rows).toBeGreaterThan(0);
    expect(fx.engine.cost({ kind: 'delete', from: 'nope' } as DeleteDef)).toEqual({ rows: 0, bytes: 0 });
  });

  it('emits a joined DELETE … USING for a fan-out aggregate and a join `and` predicate with RETURNING', () => {
    const fx = fixture();
    // WHERE references a FAN-OUT aggregate over an explicit relation JOIN. Post-
    // refactor the aggregate runs inline over the joined rows via DELETE … USING
    // (no hidden pre-aggregation CTE).
    const aggDelete: DeleteDef = {
      kind: 'delete',
      from: 'user',
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'order' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'order', field: 'total' } } }, right: { kind: 'literal', value: 100 } }],
    };
    const aggSql = fx.engine.toSQL(aggDelete, 'base').sql;
    expect(aggSql).toBe(
      'DELETE FROM "user" USING "order" AS "order" WHERE "user"."id" = "order"."userId" AND sum("order"."total") > ?',
    );

    const joinAnd: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' }, and: { kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 18 } } }],
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
    };
    const j = fx.engine.toSQL(joinAnd, 'postgres').sql;
    expect(j).toContain('USING "user" AS "user"');
    expect(j).toContain('RETURNING "order"."id" AS "id"');
  });

  it('a dialect without DELETE…USING degrades with a clear error', () => {
    const fx = fixture();
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
    };
    expect(() => fx.engine.toSQL(def, new NoDmlJoinDialect())).toThrow(/Joined DELETE/);
  });

  it('round-trips through toJSON and clone (joins / where / returning)', () => {
    const fx = runtimeFixture();
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 99 } }],
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
    };
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual(def);
    expect(q.clone().toJSON()).toEqual(def);
  });

  it('DeleteQuery.from rejects a non-delete def, and an unknown type runs as a no-op', async () => {
    const fx = runtimeFixture();
    expect(() => DeleteQuery.from({ kind: 'select' } as unknown as QueryDef, fx.registry)).toThrow(/expected 'delete'/);
    const res = await fx.engine.run({ kind: 'delete', from: 'nope' } as DeleteDef);
    expect(res.affected).toBe(0);
  });
});
