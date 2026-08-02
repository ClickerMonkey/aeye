/**
 * drillDown / drillDownInto — PARAMETERIZED aggregate un-ravelling.
 *
 * Covers: the rebuilt query pins each group key to `key = param(name)` with a
 * correct `DrillParam` mapping; `drillDownInto` extracts a chosen row's values
 * and the drilled query returns that group's underlying rows; `query.params`
 * reports the drill params (and `limit`/`offset` after `autoPaginate`); and one
 * test per `drill.*` failure code.
 */
import { describe, it, expect } from 'vitest';
import { drillDown, drillDownInto, autoPaginate } from '../transforms/index';
import type { DrillDownResult, DrillDownIntoSuccess } from '../transforms/index';
import type { SelectDef } from '../schema';
import { SelectQuery } from '../queries/index';
import { runtimeFixture } from './_utils';

/** Build the canonical "revenue per user" aggregate select. */
function revenuePerUser(): SelectDef {
  return {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' },
      {
        expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'order', field: 'total' } } },
        as: 'revenue',
      },
    ],
    from: { kind: 'type', type: 'order' },
    groupBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
  };
}

/** The set of failure codes from a result (empty on success). */
function codes(result: DrillDownResult | DrillDownIntoSuccess): string[] {
  return 'error' in result ? result.error.list.map((p) => p.code) : [];
}

describe('drillDown — parameterized success', () => {
  it('pins each group key to a bind param and records the DrillParam mapping', () => {
    const fx = runtimeFixture();
    const result = drillDown(revenuePerUser(), fx.engine);

    expect('query' in result).toBe(true);
    if (!('query' in result)) return;

    // One drill param per group key: userId → :userId, keyed off the output
    // field that carries the value, pinning the group-by key expr.
    expect(result.params).toEqual([
      { name: 'userId', field: 'userId', key: { kind: 'field-ref', source: 'order', field: 'userId' } },
    ]);

    // The rebuilt WHERE contains `o.userId = param(userId)` (no literal).
    const def = result.query.toJSON();
    expect(def.kind).toBe('select');
    if (def.kind !== 'select') return;
    expect(def.where).toEqual([
      {
        kind: 'comparison',
        op: '=',
        left: { kind: 'field-ref', source: 'order', field: 'userId' },
        right: { kind: 'param', name: 'userId' },
      },
    ]);
    // The aggregate `sum(o.total)` un-ravels to its underlying argument.
    expect(def.fields.some((f) => f.expr.kind === 'aggregate')).toBe(false);
  });

  it('derives a UNIQUE param name when the natural name collides', () => {
    const fx = runtimeFixture();
    // Group by userId but ALSO reference a param literally named `userId`, so
    // the drill key cannot reuse that name.
    const sel: SelectDef = {
      ...revenuePerUser(),
      where: [
        {
          kind: 'comparison',
          op: '>',
          left: { kind: 'field-ref', source: 'order', field: 'total' },
          right: { kind: 'param', name: 'userId' },
        },
      ],
    };
    const result = drillDown(sel, fx.engine);
    expect('query' in result).toBe(true);
    if (!('query' in result)) return;
    expect(result.params[0]!.name).toBe('userId_2');
  });
});

describe('drillDownInto — over the in-memory dataset', () => {
  it('extracts a row\'s key values and returns that user\'s underlying rows', async () => {
    const fx = runtimeFixture();

    // Aggregate revenue per user, then pick user 1's row. `order.userId` is a
    // RELATION, so the grouped row carries its IDENTITY object, not a bare id.
    const aggregated = await fx.engine.run(revenuePerUser());
    const userOneRow = aggregated.rows.find((r) => JSON.stringify(r['userId']) === JSON.stringify({ id: 1 }));
    expect(userOneRow).toBeDefined();
    if (!userOneRow) return;

    const drilled = drillDownInto(revenuePerUser(), userOneRow, fx.engine);
    expect('query' in drilled).toBe(true);
    if (!('query' in drilled)) return;

    // The extracted bind values map the param name → the row's key value — the
    // identity object, which is exactly the shape a relation comparison binds.
    expect(drilled.params).toEqual({ userId: { id: 1 } });

    // Running with those params returns ONLY user 1's underlying orders (2).
    const run = await fx.engine.run(drilled.query, { params: drilled.params });
    expect(run.rows.length).toBe(2);
    expect(run.rows.every((r) => JSON.stringify(r['userId']) === JSON.stringify({ id: 1 }))).toBe(true);
  });

  it('drill.missing-group-value when the group row lacks a key value', () => {
    const fx = runtimeFixture();
    // No `userId` present in the group row.
    expect(codes(drillDownInto(revenuePerUser(), { revenue: 150 }, fx.engine))).toContain(
      'drill.missing-group-value',
    );
  });
});

describe('query.params — introspection', () => {
  it('reports the drill param with its inferred type', () => {
    const fx = runtimeFixture();
    const drilled = drillDown(revenuePerUser(), fx.engine);
    if (!('query' in drilled)) throw new Error('expected success');
    const params = drilled.query.params(fx.engine);
    const names = params.map((p) => p.name);
    expect(names).toContain('userId');
  });

  it('reports limit/offset params after autoPaginate (number type)', () => {
    const fx = runtimeFixture();
    const paged = autoPaginate(SelectQuery.from(revenuePerUser(), fx.registry));
    const params = paged.params(fx.engine);
    const byName = new Map(params.map((p) => [p.name, p]));
    expect(byName.has('limit')).toBe(true);
    expect(byName.has('offset')).toBe(true);
    expect(byName.get('limit')!.type.kind).toBe('number');
    expect(byName.get('offset')!.type.kind).toBe('number');
  });
});

describe('drillDown — failures', () => {
  it('drill.no-aggregation when there is no group-by or aggregate', () => {
    const fx = runtimeFixture();
    const plain: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
      from: { kind: 'type', type: 'order' },
    };
    expect(codes(drillDown(plain, fx.engine))).toContain('drill.no-aggregation');
  });

  it('drill.non-invertible when an aggregate argument references no field', () => {
    const fx = runtimeFixture();
    const select: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'literal', value: 1 } } }, as: 'cnt' },
      ],
      from: { kind: 'type', type: 'order' },
    };
    expect(codes(drillDown(select, fx.engine))).toContain('drill.non-invertible');
  });

  it('drill.having-aggregate when HAVING references an aggregate', () => {
    const fx = runtimeFixture();
    const select: SelectDef = {
      ...revenuePerUser(),
      having: [
        {
          kind: 'comparison',
          op: '>',
          left: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'order', field: 'total' } } },
          right: { kind: 'literal', value: 100 },
        },
      ],
    };
    expect(codes(drillDown(select, fx.engine))).toContain('drill.having-aggregate');
  });

  it('drill.window-unsupported when a field uses a window function', () => {
    const fx = runtimeFixture();
    const select: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' },
        {
          expr: {
            kind: 'window',
            function: 'sum', args: { value: { kind: 'field-ref', source: 'order', field: 'total' } },
            partitionBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
          },
          as: 'running',
        },
      ],
      from: { kind: 'type', type: 'order' },
    };
    expect(codes(drillDown(select, fx.engine))).toContain('drill.window-unsupported');
  });
});
