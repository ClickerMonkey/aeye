/**
 * EXECUTION-time `includeTotal` (Feature 2): a SELECT can report `total` — the
 * result count after WHERE/JOIN/GROUP/HAVING/DISTINCT but BEFORE limit/offset.
 * `includeTotal` is NOT a SelectDef field; it is passed to `engine.run` /
 * `engine.toSQL`. Covers the in-memory runtime total, grouped totals, and the
 * emitted `COUNT(*) OVER () AS "$total"` SQL (base + postgres).
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, fixture } from './_utils';
import type { SelectDef } from '../schema';

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
    expect(result.rows).toEqual([{ userId: 1 }]);
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
      'SELECT DISTINCT "order"."userId" AS "userId", ' +
        '(SELECT COUNT(*) FROM (SELECT DISTINCT "order"."userId" AS "userId" FROM "order" AS "order") AS "$dt") AS "$total" ' +
        'FROM "order" AS "order" LIMIT 1',
    );
    // The pre-DISTINCT window form is NOT used here.
    expect(sql).not.toContain('COUNT(*) OVER ()');
  });
});
