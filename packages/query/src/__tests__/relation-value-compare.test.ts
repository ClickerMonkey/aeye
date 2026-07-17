/**
 * Relation-VALUE comparison — `belongs-to = { pk } / scalar` lowered to
 * per-key-column comparisons. Runtime behaviour (Phase 1).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import type { QueryDef, JsonValue, TypeDef } from '../schema';
import type { SqlParamValue } from '../sql/emit';
import type { TypeBacking } from '../backing';

/** An engine where `store.region` is a belongs-to a COMPOSITE-key `region` (country, code). */
function compositeEngine(): QueryEngine {
  const registry = createRegistry();
  const region: TypeDef = {
    name: 'region',
    fields: [{ name: 'country', type: { kind: 'text' } }, { name: 'code', type: { kind: 'text' } }],
    indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'region', field: 'country' }, count: 5 }, { expr: { kind: 'field-ref', source: 'region', field: 'code' }, count: 1 }] }],
    count: 10,
    bytes: 20,
  };
  const store: TypeDef = {
    name: 'store',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'regionCountry', type: { kind: 'text' } },
      { name: 'regionCode', type: { kind: 'text' } },
      { name: 'region', type: { kind: 'relation', to: 'region', count: 1 } },
    ],
    indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'store', field: 'id' }, count: 1 }] }],
    count: 100,
    bytes: 40,
  };
  // Composite FK: store.region joins region by (regionCountry, regionCode) → (country, code).
  const storeBacking: TypeBacking = {
    fields: { region: { relation: { keys: [{ local: 'regionCountry', foreign: 'country' }, { local: 'regionCode', foreign: 'code' }] } } },
  };
  registry.registerType(registry.parseType(region));
  registry.registerType(registry.parseType(store), storeBacking);
  registry.finalize();
  const storeRows = [
    { id: 1, regionCountry: 'US', regionCode: 'CA' },
    { id: 2, regionCountry: 'US', regionCode: 'NY' },
    { id: 3, regionCountry: 'CA', regionCode: 'ON' },
  ];
  return new QueryEngine(registry, { executors: { store: arrayExecutor(storeRows) } });
}

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

describe('relation-value-compare: composite key', () => {
  const storeDef = (op: '=' | '<>'): QueryDef => ({
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'store', field: 'id' } }],
    from: { kind: 'type', type: 'store' },
    where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'store', field: 'region' }, right: { kind: 'param', name: 'r' } }],
  } as QueryDef);

  it('matches by ALL key columns (runtime)', async () => {
    const engine = compositeEngine();
    const rows = await engine.run(storeDef('='), { params: { r: { country: 'US', code: 'CA' } } });
    expect(rows.rows.map((r) => r.id)).toEqual([1]); // only the US/CA store
    const none = await engine.run(storeDef('='), { params: { r: { country: 'US', code: 'XX' } } });
    expect(none.rows).toEqual([]);
  });

  it('emits an ANDed per-column comparison binding every key part (SQL)', () => {
    const { sql, params } = compositeEngine().toSQL(storeDef('='), 'postgres', { params: { r: { country: 'US', code: 'CA' } } });
    expect(params).toEqual(['US', 'CA']); // both key columns bound
    expect(sql).toMatch(/=\s*\$1\s+AND\s+.*=\s*\$2/i);
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
