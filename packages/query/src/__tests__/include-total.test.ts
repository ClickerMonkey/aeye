/**
 * EXECUTION-time `includeTotal` (Feature 2): a SELECT can report `total` — the
 * result count after WHERE/JOIN/GROUP/HAVING/DISTINCT but BEFORE limit/offset.
 * `includeTotal` is NOT a SelectDef field; it is passed to `engine.run` /
 * `engine.toSQL`. Covers the in-memory runtime total, grouped totals, the
 * emitted `COUNT(*) OVER () AS "$total"` SQL (base + postgres), and the
 * ROOT-ONLY property that keeps `$total` from changing the rows (P0-A).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, fixture } from './_utils';
import type { CTEStatementDef, QueryDef, SelectDef, SetOperationDef } from '../schema';

describe('includeTotal — runtime', () => {
  it('reports the full filtered count even when LIMIT slices the rows', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
      limit: 1,
    };
    const result = await fx.engine.run(def, { includeTotal: true });
    // Only 1 row returned, but the pre-limit total is the full set (3 users).
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.total).toBe(3);
    // `$total` is NOT a declared output field.
    expect(result.fields.map((f) => f.name)).toEqual(['id']);
  });

  it('reports the number of GROUPS for a grouped select', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
      limit: 1,
    };
    const result = await fx.engine.run(def, { includeTotal: true });
    // 4 orders collapse into 2 groups (userId 1 and 2); total = group count.
    expect(result.total).toBe(2);
    expect(result.rows.length).toBe(1);
  });

  it('omits `total` when includeTotal is not requested', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
    };
    const result = await fx.engine.run(def);
    expect(result.total).toBeUndefined();
  });

  it('reports the POST-DISTINCT total under DISTINCT (BUG P0-6)', async () => {
    const fx = runtimeFixture();
    // 4 orders across 2 distinct userIds → DISTINCT yields 2 rows; the total
    // must be the POST-distinct count (2), NOT the 4 pre-distinct order rows.
    const def: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' }],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: { kind: 'field-ref', source: 'order', field: 'userId' }, dir: 'asc' }],
      limit: 1,
    };
    const result = await fx.engine.run(def, { includeTotal: true });
    // A projected RELATION is its identity object (A8).
    expect(result.rows).toEqual([{ userId: { id: 1 } }]);
    expect(result.total).toBe(2);
  });
});

describe('includeTotal — SQL', () => {
  const def: SelectDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
    from: { kind: 'type', type: 'user' },
    limit: 10,
  };

  it('emits COUNT(*) OVER () AS "$total" after the projection (base dialect)', () => {
    const fx = fixture();
    const { sql } = fx.engine.toSQL(def, 'base', { includeTotal: true });
    expect(sql).toBe(
      'SELECT "user"."name" AS "name", COUNT(*) OVER () AS "$total" FROM "user" AS "user" LIMIT 10',
    );
  });

  it('emits COUNT(*) OVER () AS "$total" (postgres dialect)', () => {
    const fx = fixture();
    const { sql } = fx.engine.toSQL(def, 'postgres', { includeTotal: true });
    expect(sql).toContain('COUNT(*) OVER () AS "$total"');
  });

  it('omits the $total column when includeTotal is not requested', () => {
    const fx = fixture();
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql).not.toContain('$total');
  });

  it('counts the DISTINCT projection in a subquery, matching the runtime (BUG P0-6)', () => {
    const fx = fixture();
    // Under DISTINCT, `COUNT(*) OVER ()` would count PRE-distinct rows; the SQL
    // must instead count the distinct projection so it agrees with the runtime's
    // POST-distinct `result.total` (see the runtime test above).
    const distinctDef: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' }],
      from: { kind: 'type', type: 'order' },
      limit: 1,
    };
    const { sql } = fx.engine.toSQL(distinctDef, 'base', { includeTotal: true });
    expect(sql).toBe(
      // `order.userId` is a RELATION: it projects its IDENTITY object off this
      // row's own key column (no join), NULL when the key is unset.
      'SELECT DISTINCT CASE WHEN "order"."userId" IS NULL THEN NULL ELSE json_build_object(\'id\', "order"."userId") END AS "userId", ' +
        '(SELECT COUNT(*) FROM (SELECT DISTINCT CASE WHEN "order"."userId" IS NULL THEN NULL ELSE ' +
        'json_build_object(\'id\', "order"."userId") END AS "userId" FROM "order" AS "order") AS "$dt") AS "$total" ' +
        'FROM "order" AS "order" LIMIT 1',
    );
    // The pre-DISTINCT window form is NOT used here.
    expect(sql).not.toContain('COUNT(*) OVER ()');
  });
});

// ─── ROOT-ONLY property (BUG P0-A) ───────────────────────────────────────────

/**
 * `$total` is a PROJECTED column, so a nested SELECT that carries it is not
 * merely wasteful — inside a set-operation arm it participates in the set
 * comparison and CHANGES THE ROWS (UNION stops de-duplicating; INTERSECT /
 * EXCEPT compare counts they were never meant to see). The invariant below is
 * therefore stated over query SHAPES rather than one example, so it holds at
 * every nesting depth:
 *
 *   for every query shape Q:
 *     run(Q, { includeTotal: true }).rows === run(Q).rows                (runtime)
 *     toSQL(Q, { includeTotal: true }) projects `$total` AT MOST ONCE,
 *       and only on the ENTRY query                                     (SQL)
 *
 * The SQL half is what fails when `SqlContext.nonRoot()` propagates the flag:
 * each set-op arm and each CTE body then projects its own `$total`.
 */

/** `user.id <op> n`, projected as `id` — the arm builder for the corpus. */
const users = (op: '>=' | '<=' | '>' | '<', n: number): SelectDef => ({
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
  from: { kind: 'type', type: 'user' },
  where: [
    {
      kind: 'comparison',
      op,
      left: { kind: 'field-ref', source: 'user', field: 'id' },
      right: { kind: 'literal', value: n },
    },
  ],
  order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
});

/** A 3-row arm (ids 1,2,3) and a 2-row arm (ids 2,3) — DIFFERENT counts, which
 *  is exactly what makes a per-arm `$total` corrupt the set comparison. */
const wide = users('>=', 1);
const narrow = users('>=', 2);

const setOp = (kind: SetOperationDef['kind'], all?: boolean): SetOperationDef => ({
  kind,
  left: wide,
  right: narrow,
  ...(all ? { all } : {}),
});

/** Query shapes covering every nesting boundary `$total` could leak across. */
const shapes: ReadonlyArray<{ name: string; query: QueryDef; totalColumns: number }> = [
  { name: 'plain select', query: users('>=', 1), totalColumns: 1 },
  { name: 'select + limit', query: { ...users('>=', 1), limit: 1 }, totalColumns: 1 },
  { name: 'distinct select', query: { ...users('>=', 1), distinct: true }, totalColumns: 1 },
  {
    name: 'grouped select',
    query: {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'userId' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
    } satisfies SelectDef,
    totalColumns: 1,
  },
  // A set operation reports NO total — in either engine — rather than a wrong one.
  { name: 'union (de-duplicating)', query: setOp('union'), totalColumns: 0 },
  { name: 'union all', query: setOp('union', true), totalColumns: 0 },
  { name: 'intersect', query: setOp('intersect'), totalColumns: 0 },
  { name: 'except', query: setOp('except'), totalColumns: 0 },
  {
    name: 'set op with set-level limit',
    query: { ...setOp('union'), limit: 2 } satisfies SetOperationDef,
    totalColumns: 0,
  },
  {
    name: 'set op nested as an arm of a set op',
    query: { kind: 'except', left: setOp('union'), right: narrow } satisfies SetOperationDef,
    totalColumns: 0,
  },
  {
    name: 'cte statement (final select)',
    query: {
      kind: 'cte',
      ctes: [{ name: 'w', query: wide }],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'w', field: 'id' }, as: 'id' }],
        from: { kind: 'type', type: 'w' },
      },
    } satisfies CTEStatementDef,
    totalColumns: 1,
  },
  {
    name: 'cte statement whose final is a set operation',
    query: {
      kind: 'cte',
      ctes: [{ name: 'w', query: wide }],
      final: {
        kind: 'union',
        left: {
          kind: 'select',
          fields: [{ expr: { kind: 'field-ref', source: 'w', field: 'id' }, as: 'id' }],
          from: { kind: 'type', type: 'w' },
        },
        right: narrow,
      },
    } satisfies CTEStatementDef,
    totalColumns: 0,
  },
  {
    name: 'select over a FROM subquery',
    query: {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 's', field: 'id' }, as: 'id' }],
      from: { kind: 'subquery', as: 's', query: wide },
    } satisfies SelectDef,
    totalColumns: 1,
  },
  {
    name: 'select wrapping a SET OPERATION as a FROM subquery (the counted form)',
    query: {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 's', field: 'id' }, as: 'id' }],
      from: { kind: 'subquery', as: 's', query: setOp('union') },
    } satisfies SelectDef,
    totalColumns: 1,
  },
  {
    name: 'select with an IN subquery',
    query: {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'in', value: { kind: 'field-ref', source: 'user', field: 'id' }, in: narrow }],
    } satisfies SelectDef,
    totalColumns: 1,
  },
];

/** How many `$total` columns the emitted SQL projects. */
function totalColumns(sql: string): number {
  return sql.split('AS "$total"').length - 1;
}

describe('includeTotal — property: it never changes the rows (BUG P0-A)', () => {
  for (const shape of shapes) {
    it(`runtime rows are identical with and without includeTotal — ${shape.name}`, async () => {
      const fx = runtimeFixture();
      const withTotal = await fx.engine.run(shape.query, { includeTotal: true });
      const without = await fx.engine.run(shape.query);
      expect(withTotal.rows).toEqual(without.rows);
      // ...and the shape actually returns rows, so the equality is not vacuous.
      expect(without.rows.length).toBeGreaterThan(0);
    });

    it(`SQL projects $total only on the entry query — ${shape.name}`, () => {
      const fx = fixture();
      const { sql } = fx.engine.toSQL(shape.query, 'base', { includeTotal: true });
      expect(totalColumns(sql)).toBe(shape.totalColumns);
      // Whatever the entry query is, the SQL without the flag never mentions it.
      expect(fx.engine.toSQL(shape.query, 'base').sql).not.toContain('$total');
    });
  }

  it('a set operation reports no total in EITHER engine, rather than a wrong one', async () => {
    const result = await runtimeFixture().engine.run(setOp('union'), { includeTotal: true });
    expect(result.total).toBeUndefined();
    const { sql } = fixture().engine.toSQL(setOp('union'), 'base', { includeTotal: true });
    expect(sql).not.toContain('$total');
  });

  it('wrapping the set operation in a SELECT is how a paged set op gets a count', async () => {
    const wrapped: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 's', field: 'id' }, as: 'id' }],
      from: { kind: 'subquery', as: 's', query: setOp('union') },
      order: [{ expr: { kind: 'field-ref', source: 's', field: 'id' }, dir: 'asc' }],
      limit: 1,
    };
    const result = await runtimeFixture().engine.run(wrapped, { includeTotal: true });
    // UNION of {1,2,3} with {2,3} de-dupes to 3 rows; LIMIT 1 returns the first.
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(result.total).toBe(3);
    const { sql } = fixture().engine.toSQL(wrapped, 'base', { includeTotal: true });
    expect(totalColumns(sql)).toBe(1);
    // The `$total` sits on the OUTER select, never inside the union arms.
    expect(sql.indexOf('AS "$total"')).toBeLessThan(sql.indexOf('UNION'));
  });

  it('a CTE body carries no $total (a window aggregate nothing selects)', () => {
    const cte: CTEStatementDef = {
      kind: 'cte',
      ctes: [{ name: 'w', query: wide }],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'w', field: 'id' }, as: 'id' }],
        from: { kind: 'type', type: 'w' },
      },
    };
    const { sql } = fixture().engine.toSQL(cte, 'base', { includeTotal: true });
    const body = sql.slice(sql.indexOf('('), sql.indexOf(')') + 1);
    expect(body).not.toContain('$total');
    expect(totalColumns(sql)).toBe(1);
  });
});
