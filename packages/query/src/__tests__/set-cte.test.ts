/**
 * Set operations (union / intersect / except, with/without ALL) plus
 * non-recursive, terminating-recursive, and capped-recursive CTEs.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture } from './_utils';
import type { SelectDef, SetOperationDef, CTEStatementDef, ExprDef } from '../schema';

/** SELECT id FROM user WHERE <pred>. */
function idsWhere(pred: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'user' },
    where: [pred],
  };
}

const ids = (rows: ReadonlyArray<{ id: number }>): number[] =>
  rows.map((r) => r.id).sort((a, b) => a - b);

describe('set operations', () => {
  const left = idsWhere({ kind: 'comparison', op: '<=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 2 } }); // {1,2}
  const right = idsWhere({ kind: 'comparison', op: '>=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 2 } }); // {2,3}

  it('UNION dedupes', async () => {
    const fx = runtimeFixture();
    const def: SetOperationDef = { kind: 'union', left, right };
    const result = await fx.engine.run(def);
    expect(ids(result.rows.map((r) => ({ id: Number(r['id']) })))).toEqual([1, 2, 3]);
  });

  it('UNION ALL keeps duplicates', async () => {
    const fx = runtimeFixture();
    const def: SetOperationDef = { kind: 'union', left, right, all: true };
    const result = await fx.engine.run(def);
    expect(result.rows.length).toBe(4); // {1,2} + {2,3}
  });

  it('INTERSECT', async () => {
    const fx = runtimeFixture();
    const def: SetOperationDef = { kind: 'intersect', left, right };
    const result = await fx.engine.run(def);
    expect(ids(result.rows.map((r) => ({ id: Number(r['id']) })))).toEqual([2]);
  });

  it('EXCEPT', async () => {
    const fx = runtimeFixture();
    const def: SetOperationDef = { kind: 'except', left, right };
    const result = await fx.engine.run(def);
    expect(ids(result.rows.map((r) => ({ id: Number(r['id']) })))).toEqual([1]);
  });

  it('set-level ORDER BY / LIMIT / OFFSET sorts + slices the combined rows', async () => {
    const fx = runtimeFixture();
    // UNION dedupes to {1,2,3}; order id DESC → [3,2,1]; offset 1, limit 1 → [2].
    const def: SetOperationDef = {
      kind: 'union',
      left,
      right,
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'desc' }],
      offset: 1,
      limit: 1,
    };
    const result = await fx.engine.run(def);
    expect(result.rows.map((r) => Number(r['id']))).toEqual([2]);
  });

  it('set-level ORDER BY ascending over the whole set', async () => {
    const fx = runtimeFixture();
    const def: SetOperationDef = {
      kind: 'union',
      left,
      right,
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
    };
    const result = await fx.engine.run(def);
    expect(result.rows.map((r) => Number(r['id']))).toEqual([1, 2, 3]);
  });
});

describe('CTE', () => {
  it('non-recursive CTE feeds the final statement', async () => {
    const fx = runtimeFixture();
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'adults',
          query: {
            kind: 'select',
            fields: [
              { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' },
              { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
            ],
            from: { kind: 'type', type: 'user' },
            where: [{ kind: 'comparison', op: '>=', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 36 } }],
          },
        },
      ],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'adults', field: 'name' }, as: 'name' }],
        from: { kind: 'type', type: 'adults' },
        order: [{ expr: { kind: 'field-ref', source: 'adults', field: 'id' }, dir: 'asc' }],
      },
    };
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([{ name: 'Ada' }, { name: 'Bob' }]);
  });

  it('terminating recursive CTE reaches its fixpoint', async () => {
    const fx = runtimeFixture();
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'counter',
          base: { kind: 'expr', expr: { kind: 'literal', value: 1 } },
          recursive: {
            kind: 'select',
            fields: [
              {
                expr: { kind: 'binary', op: '+', left: { kind: 'field-ref', source: 'counter', field: 'value' }, right: { kind: 'literal', value: 1 } },
                as: 'value',
              },
            ],
            from: { kind: 'type', type: 'counter' },
            where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'counter', field: 'value' }, right: { kind: 'literal', value: 3 } }],
          },
        },
      ],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'counter', field: 'value' }, as: 'value' }],
        from: { kind: 'type', type: 'counter' },
        order: [{ expr: { kind: 'field-ref', source: 'counter', field: 'value' }, dir: 'asc' }],
      },
    };
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });

  it('non-terminating recursive CTE stops safely at the iteration cap', async () => {
    const fx = runtimeFixture();
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'counter',
          base: { kind: 'expr', expr: { kind: 'literal', value: 1 } },
          recursive: {
            kind: 'select',
            fields: [
              {
                expr: { kind: 'binary', op: '+', left: { kind: 'field-ref', source: 'counter', field: 'value' }, right: { kind: 'literal', value: 1 } },
                as: 'value',
              },
            ],
            from: { kind: 'type', type: 'counter' },
            // No bound → would loop forever without the cap.
          },
        },
      ],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'counter', field: 'value' }, as: 'value' }],
        from: { kind: 'type', type: 'counter' },
      },
    };
    const result = await fx.engine.run(def, { maxCteIterations: 10 });
    // base row + one fresh row per capped iteration.
    expect(result.rows.length).toBe(11);
  });
});
