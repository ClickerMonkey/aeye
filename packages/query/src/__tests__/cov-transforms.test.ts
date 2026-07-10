/**
 * Coverage: autoPaginate JSON-def branches + drillDown edge paths (count(*)
 * expansion, non-type source, moved HAVING, dropped aggregate ORDER BY, group
 * key not projected, distinct/joins/offset assembly, unique param names).
 */
import { describe, it, expect } from 'vitest';
import { drillDown, drillDownInto, autoPaginate } from '../transforms/index';
import type { DrillDownResult } from '../transforms/index';
import { SelectQuery } from '../queries/index';
import { runtimeFixture, ref, lit } from './_utils';
import type { SelectDef } from '../schema';

const ok = (r: DrillDownResult): Extract<DrillDownResult, { query: SelectQuery }> => {
  if (!('query' in r)) throw new Error('expected drill success: ' + JSON.stringify('error' in r ? r.error.list : r));
  return r;
};
const codes = (r: DrillDownResult): string[] => ('error' in r ? r.error.list.map((p) => p.code) : []);

describe('autoPaginate JSON-def branches', () => {
  const base: SelectDef = { kind: 'select', fields: [{ expr: ref('order', 'id') }], from: { kind: 'type', type: 'order' } };

  it('adds limit/offset params by default; deletes when disabled', () => {
    const added = autoPaginate(base);
    expect(added.limit).toEqual({ kind: 'param', name: 'limit' });
    expect(added.offset).toEqual({ kind: 'param', name: 'offset' });
    const none = autoPaginate(base, { limit: false, offset: false });
    expect(none.limit).toBeUndefined();
    expect(none.offset).toBeUndefined();
  });
});

describe('drillDown edge paths', () => {
  const fx = runtimeFixture();

  it('count(*) un-ravels into the source type fields', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'userId' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [ref('order', 'userId')],
    };
    const r = ok(drillDown(def, fx.engine));
    const out = r.query.toJSON();
    if (out.kind !== 'select') throw new Error('select');
    // count(*) expanded to order's fields (id, userId, total, note ...).
    expect(out.fields.length).toBeGreaterThan(2);
  });

  it('count(*) over a non-type (subquery) source is non-invertible', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' }],
      from: {
        kind: 'subquery',
        query: { kind: 'select', fields: [{ expr: ref('order', 'id'), as: 'id' }], from: { kind: 'type', type: 'order' } },
        as: 'sub',
      },
    };
    expect(codes(drillDown(def, fx.engine))).toContain('drill.non-invertible');
  });

  it('moves a group-key-only HAVING into WHERE and drops aggregate ORDER BY (warn)', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: 'userId' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [ref('order', 'userId')],
      having: [{ kind: 'comparison', op: '>', left: ref('order', 'userId'), right: lit(0) }],
      order: [
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, dir: 'desc' },
        { expr: ref('order', 'userId'), dir: 'asc' },
      ],
    };
    const r = ok(drillDown(def, fx.engine));
    expect(r.warnings.list.some((p) => p.code === 'drill.order-dropped')).toBe(true);
    const out = r.query.toJSON();
    if (out.kind !== 'select') throw new Error('select');
    // WHERE gained: the pinned key + the moved HAVING (userId > 0).
    expect(out.where!.length).toBe(2);
    expect(out.order!.length).toBe(1); // only the non-aggregate order term kept
  });

  it('handles a group key not projected, distinct / joins / offset, and a SelectQuery input', () => {
    const def: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } } }], // no `as`
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'user' } }],
      groupBy: [ref('order', 'userId')], // NOT projected → derived field name
      offset: 5,
      limit: 10,
    };
    const r = ok(drillDown(SelectQuery.from(def, fx.registry), fx.engine));
    const out = r.query.toJSON();
    if (out.kind !== 'select') throw new Error('select');
    expect(out.distinct).toBe(true);
    expect(out.joins!.length).toBe(1);
    expect(out.offset).toBe(5);
    expect(out.limit).toBe(10);
    expect(r.params.length).toBe(1);
  });

  it('derives a valid identifier when the group-key output name is not one (leading digit)', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId'), as: '2weird' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [ref('order', 'userId')],
    };
    const r = ok(drillDown(def, fx.engine));
    expect(r.params[0]!.name).toBe('_2weird');
  });

  it('count(*) over an unregistered type source is non-invertible', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' }],
      from: { kind: 'type', type: 'not_registered' },
    };
    expect(codes(drillDown(def, fx.engine))).toContain('drill.non-invertible');
  });

  it('reserves existing limit/offset param names and keeps a bare non-aggregate field', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('order', 'userId') }, // non-aggregate, NO `as`
        { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } }, as: 'revenue' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [ref('order', 'userId')],
      limit: { kind: 'param', name: 'lim' },
      offset: { kind: 'param', name: 'off' },
    };
    const r = ok(drillDown(def, fx.engine));
    const out = r.query.toJSON();
    if (out.kind !== 'select') throw new Error('select');
    expect(out.limit).toEqual({ kind: 'param', name: 'lim' });
    expect(out.offset).toEqual({ kind: 'param', name: 'off' });
    expect(r.params.length).toBe(1);
  });

  it('drillDownInto propagates a drillDown failure', () => {
    const plain: SelectDef = { kind: 'select', fields: [{ expr: ref('order', 'id') }], from: { kind: 'type', type: 'order' } };
    const d = drillDownInto(plain, {}, fx.engine);
    expect('error' in d).toBe(true);
    if ('error' in d) expect(d.error.list.map((p) => p.code)).toContain('drill.no-aggregation');
  });
});
