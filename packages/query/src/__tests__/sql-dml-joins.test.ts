/**
 * BUG P0-1 — joined UPDATE / DELETE must splice the authored relation joins
 * (whose synthesized key rides in the WHERE) into the statement, NOT discard
 * them. Golden SQL for base + postgres plus a runtime check, and the documented
 * degrade for a dialect without UPDATE…FROM support.
 */
import { describe, it, expect } from 'vitest';
import type { UpdateDef, DeleteDef } from '../schema';
import { fixture, runtimeFixture } from './_utils';
import { BaseDialect } from '../sql/index';

/** A dialect that declares it cannot express joined DML (degrade path). */
class NoDmlJoinDialect extends BaseDialect {
  override readonly name = 'no-dml-join';
  override get supportsDmlJoins(): boolean {
    return false;
  }
}

describe('SQL — joined UPDATE / DELETE (BUG P0-1)', () => {
  const fx = fixture();

  it('UPDATE with an authored join → FROM <source> + key in WHERE (postgres)', () => {
    const def: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'vip' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 18 } }],
    };
    const out = fx.engine.toSQL(def, 'postgres');
    expect(out.sql).toBe(
      'UPDATE "order" SET "note" = $1 FROM "user" AS "user" WHERE "order"."userId" = "user"."id" AND "user"."age" > $2',
    );
    expect(out.params).toEqual(['vip', 18]);
  });

  it('UPDATE with an authored join → same shape on base (? placeholders)', () => {
    const def: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'vip' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 18 } }],
    };
    const out = fx.engine.toSQL(def, 'base');
    expect(out.sql).toBe(
      'UPDATE "order" SET "note" = ? FROM "user" AS "user" WHERE "order"."userId" = "user"."id" AND "user"."age" > ?',
    );
  });

  it('UPDATE with a relation join splices its join into FROM + key in WHERE', () => {
    const def: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'vip' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'order_userId' } }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'order_userId', field: 'name' }, right: { kind: 'literal', value: 'Ada' } }],
    };
    const out = fx.engine.toSQL(def, 'postgres');
    expect(out.sql).toBe(
      'UPDATE "order" SET "note" = $1 FROM "user" AS "order_userId" WHERE "order"."userId" = "order_userId"."id" AND LOWER("order_userId"."name") = LOWER($2)',
    );
    expect(out.params).toEqual(['vip', 'Ada']);
  });

  it('DELETE with an authored join → USING <source> + key in WHERE (postgres)', () => {
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 18 } }],
    };
    const out = fx.engine.toSQL(def, 'postgres');
    expect(out.sql).toBe(
      'DELETE FROM "order" USING "user" AS "user" WHERE "order"."userId" = "user"."id" AND "user"."age" < $1',
    );
    expect(out.params).toEqual([18]);
  });

  it('DELETE with a relation join splices its join into USING + key in WHERE (base)', () => {
    const def: DeleteDef = {
      kind: 'delete',
      from: 'order',
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'order_userId' } }],
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'order_userId', field: 'name' }, right: { kind: 'literal', value: 'Bob' } }],
    };
    const out = fx.engine.toSQL(def, 'base');
    expect(out.sql).toBe(
      'DELETE FROM "order" USING "user" AS "order_userId" WHERE "order"."userId" = "order_userId"."id" AND LOWER("order_userId"."name") = LOWER(?)',
    );
  });

  it('a dialect without UPDATE…FROM support degrades with a clear error', () => {
    const def: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'vip' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
    };
    expect(() => fx.engine.toSQL(def, new NoDmlJoinDialect())).toThrow(/Joined UPDATE/);
  });

  it('joinless UPDATE / DELETE still emit the plain form (no FROM/USING)', () => {
    const upd: UpdateDef = { kind: 'update', type: 'user', set: [{ field: 'age', value: { kind: 'literal', value: 7 } }] };
    expect(fx.engine.toSQL(upd, new NoDmlJoinDialect()).sql).toBe('UPDATE "user" SET "age" = ?');
  });

  it('engine.run still applies a joined UPDATE in-memory', async () => {
    const rt = runtimeFixture();
    const def: UpdateDef = {
      kind: 'update',
      type: 'order',
      set: [{ field: 'note', value: { kind: 'literal', value: 'vip' } }],
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 40 } }],
      returning: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    };
    const res = await rt.engine.run(def);
    // Only Bob (age 42) matches; his orders are 12 and 13.
    expect(res.affected).toBe(2);
    expect(res.rows.map((r) => r['id']).sort()).toEqual([12, 13]);
  });
});
