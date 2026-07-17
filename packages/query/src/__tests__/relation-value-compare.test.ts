/**
 * Relation-VALUE comparison — `belongs-to = { pk } / scalar` lowered to
 * per-key-column comparisons. Runtime behaviour (Phase 1).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import type { QueryDef, JsonValue } from '../schema';

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
