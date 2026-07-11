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
import { AggregateExpr } from '../exprs/index';
import type { SelectDef, ExprDef } from '../schema';

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

  const sumTotal = { kind: 'aggregate' as const, function: 'sum', args: { value: ref('order', 'total') } };
  const countStar = { kind: 'aggregate' as const, function: 'count', args: {} };
  const byCnt = { kind: 'output' as const, name: 'cnt' };
  // A grouped SELECT: `revenue = sum(total)` (converts to the `total` column) and
  // optional extra fields (e.g. a `count(*)` whose column does NOT survive).
  const grouped = (order: SelectDef['order'], extra: SelectDef['fields'] = []): SelectDef => ({
    kind: 'select',
    fields: [{ expr: ref('order', 'id'), as: 'id' }, { expr: sumTotal, as: 'revenue' }, ...extra],
    from: { kind: 'type', type: 'order' },
    groupBy: [ref('order', 'id')],
    order,
  });

  it('UN-AGGREGATES an aggregate ORDER BY term to its underlying field (+ moves group-key HAVING to WHERE)', () => {
    const r = ok(drillDown({
      ...grouped([
        { expr: sumTotal, dir: 'desc' }, // sum(total) un-aggregates to `total`
        { expr: ref('order', 'id'), dir: 'asc' },
      ]),
      having: [{ kind: 'comparison', op: '>', left: ref('order', 'id'), right: lit(0) }],
    }, fx.engine));
    expect(r.warnings.list.some((p) => p.code === 'drill.order-dropped')).toBe(false); // un-aggregated, not dropped
    const out = r.query.toJSON();
    if (out.kind !== 'select') throw new Error('select');
    expect(out.where!.length).toBe(2); // pinned key + moved HAVING (id > 0)
    expect(out.order!.length).toBe(2); // both terms kept
    const first = out.order![0];
    if ('kind' in first) throw new Error('expected a term');
    expect(first.expr).toEqual({ kind: 'field-ref', source: 'order', field: 'total' });
  });

  it('UN-AGGREGATES a matching sorter sort to its underlying field and keeps the rest', () => {
    const r = ok(drillDown(grouped([
      { kind: 'sorter', sorts: { byId: ref('order', 'id'), byRev: sumTotal }, defaultSort: [{ sort: 'byRev', dir: 'desc' }, { sort: 'byId', dir: 'asc' }] },
    ]), fx.engine));
    expect(r.warnings.list.some((p) => p.code === 'drill.order-dropped')).toBe(false);
    const s = (r.query.toJSON() as SelectDef).order![0];
    if (!('kind' in s) || s.kind !== 'sorter') throw new Error('expected a sorter');
    expect(Object.keys(s.sorts)).toEqual(['byId', 'byRev']);
    expect(s.sorts['byRev']).toEqual({ kind: 'field-ref', source: 'order', field: 'total' }); // un-aggregated
    expect(s.defaultSort).toEqual([{ sort: 'byRev', dir: 'desc' }, { sort: 'byId', dir: 'asc' }]); // intact
  });

  it('DROPS an unconvertible sort (count(*) column) from a sorter + trims defaultSort, keeps the rest', () => {
    const r = ok(drillDown(grouped(
      [{ kind: 'sorter', sorts: { byId: ref('order', 'id'), byCnt }, defaultSort: [{ sort: 'byCnt', dir: 'desc' }, { sort: 'byId', dir: 'asc' }] }],
      [{ expr: countStar, as: 'cnt' }], // count(*) expands ⇒ no surviving `cnt` column
    ), fx.engine));
    expect(r.warnings.list.some((p) => p.code === 'drill.order-dropped')).toBe(true);
    const s = (r.query.toJSON() as SelectDef).order![0];
    if (!('kind' in s) || s.kind !== 'sorter') throw new Error('expected a sorter');
    expect(Object.keys(s.sorts)).toEqual(['byId']); // byCnt dropped
    expect(s.defaultSort).toEqual([{ sort: 'byId', dir: 'asc' }]); // byCnt trimmed
  });

  it('DROPS a whole sorter with no surviving sort AND a plain unconvertible ORDER term', () => {
    const r = ok(drillDown(grouped(
      [
        { kind: 'sorter', sorts: { byCnt }, defaultSort: [{ sort: 'byCnt', dir: 'desc' }] },
        { expr: countStar, dir: 'desc' },
      ],
      [{ expr: countStar, as: 'cnt' }],
    ), fx.engine));
    expect(r.warnings.list.filter((p) => p.code === 'drill.order-dropped').length).toBeGreaterThanOrEqual(2);
    expect((r.query.toJSON() as SelectDef).order).toBeUndefined(); // both dropped ⇒ no ORDER BY
  });

  it('keeps an all-scalar sorter unchanged through a drill', () => {
    const r = ok(drillDown(grouped([
      { kind: 'sorter', sorts: { byId: ref('order', 'id') }, defaultSort: [{ sort: 'byId', dir: 'asc' }] },
    ]), fx.engine));
    expect(r.warnings.list.some((p) => p.code === 'drill.order-dropped')).toBe(false);
    const s = (r.query.toJSON() as SelectDef).order![0];
    if (!('kind' in s) || s.kind !== 'sorter') throw new Error('expected a sorter');
    expect(Object.keys(s.sorts)).toEqual(['byId']);
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

// ─── drill-down.ts — un-aggregation (unaggregateDef) + AggregateExpr.unaggregate ─

describe('drillDown un-aggregation coverage', () => {
  const fx = runtimeFixture();
  const sumT: ExprDef = { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } };
  const arrT: ExprDef = { kind: 'aggregate', function: 'arrayAgg', args: { value: ref('order', 'note') } };
  const countStar: ExprDef = { kind: 'aggregate', function: 'count', args: {} };
  const gt0 = (e: ExprDef): ExprDef => ({ kind: 'comparison', op: '>', left: e, right: lit(0) });
  const subQ = { kind: 'select', fields: [{ expr: ref('order', 'id') }], from: { kind: 'type', type: 'order' } } as SelectDef;
  const bareAgg = (field: ExprDef): SelectDef => ({ kind: 'select', fields: [{ expr: field, as: 'x' }], from: { kind: 'type', type: 'order' } });

  it('un-aggregates through EVERY wrapping expr kind (recursion)', () => {
    const field: ExprDef = { kind: 'logical', op: 'and', operands: [
      gt0(sumT),                                                             // comparison
      { kind: 'binary', op: '+', left: sumT, right: lit(1) },               // binary
      { kind: 'unary', op: '-', operand: sumT },                            // unary
      { kind: 'between', value: sumT, lower: lit(0), upper: lit(9) },       // between
      { kind: 'in', value: sumT, in: [lit(1)] },                           // in (list)
      { kind: 'in', value: sumT, in: subQ },                              // in (subquery — value un-agg, opaque)
      { kind: 'is-null', value: sumT },                                   // is-null
      { kind: 'array-op', op: 'contains', target: arrT, value: lit('x') },     // array-op single
      { kind: 'array-op', op: 'containsAny', target: arrT, value: [lit('x')] }, // array-op list
      { kind: 'array-op', op: 'isEmpty', target: arrT },                  // array-op none
      { kind: 'case', branches: [{ when: gt0(sumT), then: lit(1) }], else: lit(0) }, // case (else)
      { kind: 'case', branches: [{ when: gt0(sumT), then: lit(1) }] },     // case (no else)
      { kind: 'function-call', function: 'upper', args: { value: sumT } }, // function-call
      { kind: 'tabular-function-call', function: 'gen', args: { value: sumT } }, // tabular-function-call
      ref('order', 'id'),                                                  // leaf
      { kind: 'subquery', query: subQ },                                  // subquery leaf (opaque)
    ] };
    const r = ok(drillDown(bareAgg(field), fx.engine));
    const out = r.query.toJSON();
    if (out.kind !== 'select') throw new Error('select');
    // Every aggregate replaced by its value arg; none remain, and it reads fields.
    expect(JSON.stringify(out.fields)).not.toContain('"kind":"aggregate"');
    expect(JSON.stringify(out.fields)).toContain('"field":"total"');
  });

  it('drops a window ORDER term and a count(*) ORDER term (no row-level value)', () => {
    const def: SelectDef = { ...bareAgg(sumT), order: [
      { expr: { kind: 'window', function: 'rowNumber', args: {} }, dir: 'asc' }, // window → dropped
      { expr: countStar, dir: 'asc' }, // count(*) → 1 → field-less → dropped
    ] };
    const r = ok(drillDown(def, fx.engine));
    expect((r.query.toJSON() as SelectDef).order).toBeUndefined();
    expect(r.warnings.list.filter((p) => p.code === 'drill.order-dropped').length).toBeGreaterThanOrEqual(2);
  });

  it('non-invertible: an aggregate with no template, and a field-less un-aggregation', () => {
    fx.registry.registerFunction({ name: 'noun', shape: 'aggregate', params: [{ name: 'value', type: 'any' }], output: 'inferred' });
    // round(noun(total)): function-call → args → aggregate has NO template → null.
    expect(codes(drillDown(bareAgg({ kind: 'function-call', function: 'round', args: { value: { kind: 'aggregate', function: 'noun', args: { value: ref('order', 'total') } } } }), fx.engine))).toContain('drill.non-invertible');
    // count(*) + 1 un-aggregates to 1 + 1 — references no field.
    expect(codes(drillDown(bareAgg({ kind: 'binary', op: '+', left: countStar, right: lit(1) }), fx.engine))).toContain('drill.non-invertible');
  });

  it('AggregateExpr.unaggregate: value / count(*) / count(v) / no-fn / no-template / missing-arg', () => {
    const un = (d: ExprDef): ExprDef | undefined => {
      const e = fx.engine.registry.parseExpr(d);
      if (!(e instanceof AggregateExpr)) throw new Error('agg');
      return e.unaggregate(fx.engine)?.toJSON();
    };
    expect(un(sumT)).toEqual(ref('order', 'total'));                       // sum(total) → value arg
    expect(un(countStar)).toEqual({ kind: 'literal', value: 1 });         // count(*) → 1 (empty template)
    expect((un({ kind: 'aggregate', function: 'count', args: { value: ref('order', 'total') } }) as { kind: string }).kind).toBe('case'); // count(v) → CASE
    expect(un({ kind: 'aggregate', function: 'nofn', args: {} })).toBeUndefined(); // unknown fn → no def
    fx.registry.registerFunction({ name: 'notmpl', shape: 'aggregate', params: [{ name: 'value', type: 'any' }], output: 'inferred' });
    expect(un({ kind: 'aggregate', function: 'notmpl', args: { value: ref('order', 'total') } })).toBeUndefined(); // no template
    fx.registry.registerFunction({ name: 'needsval', shape: 'aggregate', params: [{ name: 'value', type: 'any', optional: true }], output: 'inferred', unaggregate: { kind: 'arg', name: 'value' } });
    expect(un({ kind: 'aggregate', function: 'needsval', args: {} })).toBeUndefined(); // arg-less, template needs `value` → missing
  });

  it('a non-invertible aggregate nulls EVERY wrapping arm (null-propagation)', () => {
    fx.registry.registerFunction({ name: 'niagg', shape: 'aggregate', params: [{ name: 'value', type: 'any' }], output: 'inferred' }); // no template → non-invertible
    const ni: ExprDef = { kind: 'aggregate', function: 'niagg', args: { value: ref('order', 'total') } };
    const okRef = ref('order', 'total');
    const okArr: ExprDef = { kind: 'aggregate', function: 'arrayAgg', args: { value: ref('order', 'note') } };
    const wrappers: ExprDef[] = [
      { kind: 'binary', op: '+', left: ni, right: lit(1) },                          // binary left null
      { kind: 'binary', op: '+', left: okRef, right: ni },                           // binary right null
      { kind: 'unary', op: '-', operand: ni },                                       // unary null
      { kind: 'logical', op: 'and', operands: [gt0(ni), lit(true)] },               // logical (many) null
      { kind: 'in', value: ni, in: [lit(1)] },                                       // in value null
      { kind: 'in', value: okRef, in: [ni] },                                        // in-list element null
      { kind: 'between', value: ni, lower: lit(0), upper: lit(9) },                  // between null
      { kind: 'is-null', value: ni },                                                // is-null null
      { kind: 'array-op', op: 'contains', target: ni, value: lit('x') },             // array-op target null
      { kind: 'array-op', op: 'containsAny', target: okArr, value: [ni] },           // array-op list value null
      { kind: 'array-op', op: 'contains', target: okArr, value: ni },                // array-op single value null
      { kind: 'case', branches: [{ when: gt0(ni), then: lit(1) }], else: lit(0) },   // case when null
      { kind: 'case', branches: [{ when: gt0(okRef), then: ni }], else: lit(0) },    // case then null
      { kind: 'case', branches: [{ when: gt0(okRef), then: lit(1) }], else: ni },    // case else null
      { kind: 'function-call', function: 'round', args: { value: ni } },             // function-call args null
    ];
    for (const w of wrappers) {
      expect(codes(drillDown(bareAgg(w), fx.engine))).toContain('drill.non-invertible');
    }
  });
});
