/**
 * Golden SQL for the ANSI `base` dialect: SELECT (group/having/order/limit/
 * offset), INSERT / UPDATE / DELETE, set-ops, and an explicit CTE — asserting
 * the SQL string, `?` placeholders, and correct bind-param ordering.
 */
import { describe, it, expect } from 'vitest';
import type { QueryDef, SelectDef, InsertDef, UpdateDef, DeleteDef, SetOperationDef, CTEStatementDef } from '../schema';
import { fixture } from './_utils';

describe('SQL — base (ANSI) dialect', () => {
  const fx = fixture();
  const sql = (q: QueryDef) => fx.engine.toSQL(q, 'base');

  it('select with group / having / order / limit / offset, ordered params', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'param', name: 'minAge' } }],
      groupBy: [{ kind: 'field-ref', source: 'user', field: 'name' }],
      having: [{ kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'count', args: {} }, right: { kind: 'literal', value: 1 } }],
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, dir: 'asc' }],
      limit: 10,
      offset: 5,
    };
    const out = fx.engine.toSQL(def, 'base', { params: { minAge: 18 } });
    expect(out.sql).toBe(
      'SELECT "user"."name" AS "name", count(*) AS "n" FROM "user" AS "user" WHERE "user"."age" > ? GROUP BY "user"."name" HAVING count(*) > ? ORDER BY "user"."name" ASC LIMIT 10 OFFSET 5',
    );
    // param values appear in document order (WHERE before HAVING).
    expect(out.params).toEqual([18, 1]);
  });

  it('distinct projection', () => {
    const def: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
    };
    expect(sql(def).sql).toBe('SELECT DISTINCT "user"."name" AS "name" FROM "user" AS "user"');
  });

  it('insert with returning', () => {
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['name', 'age'],
      values: [[{ kind: 'literal', value: 'Zed' }, { kind: 'literal', value: 5 }]],
      returning: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
    };
    const out = sql(def);
    expect(out.sql).toBe('INSERT INTO "user" ("name", "age") VALUES (?, ?) RETURNING "user"."id" AS "id"');
    expect(out.params).toEqual(['Zed', 5]);
  });

  it('insert on conflict do update', () => {
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name'],
      values: [[{ kind: 'literal', value: 1 }, { kind: 'literal', value: 'Ada' }]],
      onConflict: { fields: ['id'], update: [{ field: 'name', value: { kind: 'literal', value: 'Ada2' } }] },
    };
    expect(sql(def).sql).toBe(
      'INSERT INTO "user" ("id", "name") VALUES (?, ?) ON CONFLICT ("id") DO UPDATE SET "name" = ?',
    );
  });

  it('insert on conflict do update referencing EXCLUDED', () => {
    const def: InsertDef = {
      kind: 'insert',
      into: 'user',
      fields: ['id', 'name'],
      values: [[{ kind: 'literal', value: 1 }, { kind: 'literal', value: 'Ada' }]],
      onConflict: { fields: ['id'], update: [{ field: 'name', value: { kind: 'excluded', field: 'name' } }] },
    };
    expect(sql(def).sql).toBe(
      'INSERT INTO "user" ("id", "name") VALUES (?, ?) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"',
    );
  });

  it('update with where and returning', () => {
    const def: UpdateDef = {
      kind: 'update',
      type: 'user',
      set: [{ field: 'age', value: { kind: 'literal', value: 7 } }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'param', name: 'id' } }],
    };
    const out = fx.engine.toSQL(def, 'base', { params: { id: 1 } });
    expect(out.sql).toBe('UPDATE "user" SET "age" = ? WHERE "user"."id" = ?');
    expect(out.params).toEqual([7, 1]);
  });

  it('delete with where', () => {
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 10 } }],
    };
    const out = sql(def);
    expect(out.sql).toBe('DELETE FROM "order" WHERE "order"."total" < ?');
    expect(out.params).toEqual([10]);
  });

  it('set operation (union)', () => {
    const def: SetOperationDef = {
      kind: 'union',
      left: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } },
      right: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }], from: { kind: 'type', type: 'order' } },
    };
    expect(sql(def).sql).toBe(
      '(SELECT "user"."id" AS "id" FROM "user" AS "user") UNION (SELECT "order"."id" AS "id" FROM "order" AS "order")',
    );
  });

  it('set operation with set-level ORDER BY / LIMIT / OFFSET (unqualified output column)', () => {
    const def: SetOperationDef = {
      kind: 'union',
      left: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }], from: { kind: 'type', type: 'user' } },
      right: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }], from: { kind: 'type', type: 'order' } },
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'desc' }],
      limit: 2,
      offset: 1,
    };
    expect(sql(def).sql).toBe(
      '(SELECT "user"."id" AS "id" FROM "user" AS "user") UNION (SELECT "order"."id" AS "id" FROM "order" AS "order") ORDER BY "id" DESC LIMIT 2 OFFSET 1',
    );
  });

  it('explicit CTE statement', () => {
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'big',
          query: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
            from: { kind: 'type', type: 'order' },
            where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 100 } }],
          },
        },
      ],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'big', field: 'id' }, as: 'id' }],
        from: { kind: 'type', type: 'big' },
      },
    };
    const out = sql(def);
    expect(out.sql).toBe(
      'WITH "big" AS (SELECT "order"."id" AS "id" FROM "order" AS "order" WHERE "order"."total" > ?) SELECT "big"."id" AS "id" FROM "big" AS "big"',
    );
    expect(out.params).toEqual([100]);
  });

  it('CTE statement whose final SELECT has a fan-out aggregate emits ONE WITH (BUG P0-2)', () => {
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'big',
          query: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
            from: { kind: 'type', type: 'order' },
          },
        },
      ],
      // The final SELECT's fan-out aggregate now runs over an explicit relation
      // JOIN (no hidden pre-aggregation CTE), so only the outer `big` CTE remains
      // — still exactly one `WITH` with no second one hoisted in.
      final: {
        kind: 'select',
        fields: [
          { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
          { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'orders', field: 'total' } } }, as: 'spent' },
        ],
        from: { kind: 'type', type: 'user' },
        joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'orders' } }],
      },
    };
    const out = sql(def);
    // EXACTLY one `WITH ` — the single explicit `big` CTE.
    expect(out.sql.split('WITH ').length - 1).toBe(1);
    expect(out.sql.startsWith('WITH "big" AS (')).toBe(true);
    // The fan-out aggregate is a plain relation JOIN the aggregate runs over —
    // no `agg_…` CTE, no second WITH.
    expect(out.sql).not.toContain('agg_sum');
    expect(out.sql).toContain('LEFT JOIN "order" AS "orders" ON "user"."id" = "orders"."userId"');
    expect(out.sql).toContain('sum("orders"."total") AS "spent"');
    expect(out.sql).not.toContain('AS (SELECT "user"');
  });
});
