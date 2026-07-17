/**
 * Relation-VALUE comparison — `belongs-to = { pk } / scalar` lowered to
 * per-key-column comparisons. Runtime behaviour (Phase 1).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import type { QueryDef, JsonValue } from '../schema';
import type { SqlParamValue } from '../sql/emit';

/** The SELECT-order-by-userId def for a given op. */
function userIdCmp(op: '=' | '<>'): QueryDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    from: { kind: 'type', type: 'order' },
    where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'order', field: 'userId' }, right: { kind: 'param', name: 'u' } }],
  } as QueryDef;
}

/** SELECT order.id WHERE order.userId <op> :u, returning the matched order ids. */
async function ids(op: '=' | '<>', u: JsonValue): Promise<number[]> {
  const fx = runtimeFixture();
  const def: QueryDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    from: { kind: 'type', type: 'order' },
    where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'order', field: 'userId' }, right: { kind: 'param', name: 'u' } }],
  } as QueryDef;
  const res = await fx.engine.run(def, { params: { u } });
  return res.rows.map((r) => r.id as number).sort((a, b) => a - b);
}

describe('relation-value-compare: belongs-to = value (runtime)', () => {
  it('a { pk } object value matches by the target primary key', async () => {
    // orders 10, 11 belong to user 1; 12, 13 to user 2.
    expect(await ids('=', { id: 1 })).toEqual([10, 11]);
    expect(await ids('=', { id: 2 })).toEqual([12, 13]);
    expect(await ids('=', { id: 99 })).toEqual([]);
  });

  it('a bare scalar value still works (single-key back-compat)', async () => {
    expect(await ids('=', 1)).toEqual([10, 11]);
  });

  it('<> is the negation (excludes the matched rows)', async () => {
    expect(await ids('<>', { id: 1 })).toEqual([12, 13]);
    expect(await ids('<>', 2)).toEqual([10, 11]);
  });

  it('a null / absent key value yields UNKNOWN (keeps no rows)', async () => {
    expect(await ids('=', { id: null })).toEqual([]);
    expect(await ids('<>', { id: null })).toEqual([]);
  });
});

/** SELECT order.id WHERE order.userId [NOT] IN (:params...), returning the matched ids. */
async function inIds(not: boolean, names: string[], params: Record<string, JsonValue>): Promise<number[]> {
  const def: QueryDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    from: { kind: 'type', type: 'order' },
    where: [{ kind: 'in', not, value: { kind: 'field-ref', source: 'order', field: 'userId' }, in: names.map((n) => ({ kind: 'param', name: n })) }],
  } as QueryDef;
  const res = await runtimeFixture().engine.run(def, { params });
  return res.rows.map((r) => r.id as number).sort((a, b) => a - b);
}

describe('relation-value-compare: belongs-to IN value list (runtime + SQL)', () => {
  it('IN a list of { pk } objects matches any', async () => {
    expect(await inIds(false, ['a', 'b'], { a: { id: 1 }, b: { id: 2 } })).toEqual([10, 11, 12, 13]);
    expect(await inIds(false, ['a'], { a: { id: 1 } })).toEqual([10, 11]);
  });

  it('IN accepts bare scalars too (single-key)', async () => {
    expect(await inIds(false, ['a', 'b'], { a: 1, b: 99 })).toEqual([10, 11]);
  });

  it('NOT IN is the negation', async () => {
    expect(await inIds(true, ['a'], { a: { id: 1 } })).toEqual([12, 13]);
  });

  it('emits OR-of-column-comparisons (NOT IN wrapped in NOT)', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
      from: { kind: 'type', type: 'order' },
      where: [{ kind: 'in', not: true, value: { kind: 'field-ref', source: 'order', field: 'userId' }, in: [{ kind: 'param', name: 'a' }, { kind: 'param', name: 'b' }] }],
    } as QueryDef;
    const { sql, params } = runtimeFixture().engine.toSQL(def, 'postgres', { params: { a: { id: 1 }, b: 2 } });
    expect(params).toEqual([1, 2]);
    expect(sql).toMatch(/NOT\s*\(/i);
    expect(sql).toMatch(/OR/i);
  });
});

describe('relation-value-compare: validation', () => {
  it('rejects an ordering / LIKE operator against a relation', () => {
    const fx = runtimeFixture();
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
      from: { kind: 'type', type: 'order' },
      where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'order', field: 'userId' }, right: { kind: 'param', name: 'u' } }],
    } as QueryDef;
    const p = fx.engine.validateQuery(def);
    expect(p.list.some((x) => x.code === 'comparison.relation-order')).toBe(true);
  });
});

describe('relation-value-compare: belongs-to = value (SQL)', () => {
  const sqlOf = (op: '=' | '<>', u: SqlParamValue): { sql: string; params: unknown[] } =>
    runtimeFixture().engine.toSQL(userIdCmp(op), 'postgres', { params: { u } });

  it('decomposes a { pk } object param into per-column binds', () => {
    const { sql, params } = sqlOf('=', { id: 7 });
    expect(params).toEqual([7]); // the object's `id`, bound as a real parameter
    expect(sql).toMatch(/=\s*\$1/);
  });

  it('binds a bare scalar param directly (single-key)', () => {
    expect(sqlOf('=', 7).params).toEqual([7]);
  });

  it('<> wraps the column equality in NOT ( … )', () => {
    expect(sqlOf('<>', 7).sql).toMatch(/NOT\s*\(/i);
  });
});
