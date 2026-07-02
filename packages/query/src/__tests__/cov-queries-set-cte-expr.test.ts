/**
 * Coverage: SetOperationQuery, CTEStatementQuery (+ recursive entry), and
 * ExprQuery — the SQL-emission, validation, cost, params, and serialization
 * surfaces the runtime-only `set-cte` tests don't reach. Also drives the base
 * `Query.emitWith` (a CTE whose final arm is a set-op) and the single-`WITH`
 * hoist of a final SELECT's own planner CTE.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, fixture } from './_utils';
import { SetOperationQuery } from '../queries/set-operation';
import { CTEStatementQuery } from '../queries/cte';
import { ExprQuery } from '../queries/expr-query';
import type { SelectDef, SetOperationDef, CTEStatementDef, ExprQueryDef, ExprDef, QueryDef } from '../schema';

/** SELECT id FROM user WHERE id <op> n. */
function idsWhere(op: '<=' | '>=', n: number): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'user' },
    where: [{ kind: 'comparison', op, left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: n } }],
  };
}

const left = idsWhere('<=', 2);
const right = idsWhere('>=', 2);

describe('SetOperationQuery — SQL / cost / validate / params / serialization', () => {
  it('emits UNION ALL with a set-level ORDER BY (unqualified col) + LIMIT/OFFSET', () => {
    const fx = fixture();
    const def: SetOperationDef = {
      kind: 'union',
      left,
      right,
      all: true,
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'desc', nulls: 'last' }],
      limit: 2,
      offset: 1,
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('ORDER BY "id" DESC NULLS LAST');
    expect(sql).toContain('LIMIT 2');
    expect(sql).toContain('OFFSET 1');
  });

  it('emits INTERSECT / EXCEPT and a non-field-ref ORDER BY term falls back to its own SQL', () => {
    const fx = fixture();
    const intersect: SetOperationDef = { kind: 'intersect', left, right };
    expect(fx.engine.toSQL(intersect, 'base').sql).toContain('INTERSECT');
    const except: SetOperationDef = { kind: 'except', left, right };
    expect(fx.engine.toSQL(except, 'base').sql).toContain('EXCEPT');

    // ORDER BY a binary expr (not a bare field-ref) ⇒ emits the expr's own SQL.
    const exprOrder: SetOperationDef = {
      kind: 'union',
      left,
      right,
      order: [{ expr: { kind: 'binary', op: '+', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 1 } }, dir: 'asc' }],
    };
    expect(fx.engine.toSQL(exprOrder, 'base').sql).toContain('ORDER BY');
  });

  it('emits LIMIT/OFFSET bound to params (provided + absent value)', () => {
    const fx = fixture();
    const def: SetOperationDef = {
      kind: 'union',
      left,
      right,
      limit: { kind: 'param', name: 'lim' },
      offset: { kind: 'param', name: 'off' },
    };
    // Values provided ⇒ bound params (the arm predicates contribute leading
    // params; the trailing two are the set-level limit/offset).
    const provided = fx.engine.toSQL(def, 'base', { params: { lim: 5, off: 2 } });
    expect(provided.params.slice(-2)).toEqual([5, 2]);
    // No values ⇒ the bound is still emitted, binding null.
    const absent = fx.engine.toSQL(def, 'base');
    expect(absent.params.slice(-2)).toEqual([null, null]);
  });

  it('runs a set-level LIMIT/OFFSET bound to a param', async () => {
    const fx = runtimeFixture();
    const def: SetOperationDef = {
      kind: 'union',
      left,
      right,
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
      limit: { kind: 'param', name: 'lim' },
      offset: { kind: 'param', name: 'off' },
    };
    const res = await fx.engine.run(def, { params: { lim: 1, off: 1 } });
    expect(res.rows.map((r) => Number(r['id']))).toEqual([2]);
  });

  it('estimates cost per operation and caps by a literal LIMIT', () => {
    const fx = fixture();
    expect(fx.engine.cost({ kind: 'union', left, right } as SetOperationDef).rows).toBeGreaterThan(0);
    expect(fx.engine.cost({ kind: 'intersect', left, right } as SetOperationDef).rows).toBeGreaterThanOrEqual(0);
    expect(fx.engine.cost({ kind: 'except', left, right } as SetOperationDef).rows).toBeGreaterThanOrEqual(0);
    const capped = fx.engine.cost({ kind: 'union', left, right, limit: 1 } as SetOperationDef);
    expect(capped.rows).toBe(1);
  });

  it('validates both arms + the set-level ORDER BY, and reports its params', () => {
    const fx = fixture();
    const def: SetOperationDef = {
      kind: 'union',
      left,
      right,
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' }],
      limit: { kind: 'param', name: 'lim' },
      offset: { kind: 'param', name: 'off' },
    };
    expect(fx.engine.validateQuery(def).hasErrors).toBe(false);
    const params = fx.engine.parseQuery(def).params(fx.engine).map((p) => p.name).sort();
    expect(params).toEqual(['lim', 'off']);
  });

  it('round-trips through toJSON and clone (order / limit / offset / all)', () => {
    const fx = fixture();
    const def: SetOperationDef = {
      kind: 'union',
      left,
      right,
      all: true,
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'desc' }],
      limit: { kind: 'param', name: 'lim' },
      offset: 3,
    };
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual(def);
    expect(q.clone().toJSON()).toEqual(def);
  });

  it('SetOperationQuery.from rejects a non-set-op def', () => {
    const fx = fixture();
    expect(() => SetOperationQuery.from({ kind: 'select' } as unknown as QueryDef, fx.registry)).toThrow(/expected a set op/);
  });
});

describe('CTEStatementQuery — SQL / validate / cost / serialization', () => {
  const adultsCte: CTEStatementDef = {
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
    },
  };

  it('emits exactly one WITH … <final>, validates, costs, and resolves output fields', () => {
    const fx = fixture();
    const { sql } = fx.engine.toSQL(adultsCte, 'base');
    expect(sql.startsWith('WITH "adults" AS (')).toBe(true);
    expect(sql).toContain('SELECT "adults"."name" AS "name" FROM "adults" AS "adults"');
    expect(fx.engine.validateQuery(adultsCte).hasErrors).toBe(false);
    expect(fx.engine.cost(adultsCte).rows).toBeGreaterThanOrEqual(0);
    // Single output field ⇒ resolve returns that field's type directly.
    const resolved = fx.engine.resolveQuery(adultsCte);
    expect(resolved.kind).toBe('field');
    expect(fx.engine.parseQuery(adultsCte).referencedTypes()).toContain('user');
  });

  it('round-trips a non-recursive CTE through toJSON and clone', () => {
    const fx = fixture();
    const q = fx.engine.parseQuery(adultsCte);
    expect(q.toJSON()).toEqual(adultsCte);
    expect(q.clone().toJSON()).toEqual(adultsCte);
  });

  it('emits WITH RECURSIVE … UNION ALL and round-trips a recursive CTE', () => {
    const fx = fixture();
    const recursive: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'counter',
          base: { kind: 'expr', expr: { kind: 'literal', value: 1 } },
          recursive: {
            kind: 'select',
            fields: [{ expr: { kind: 'binary', op: '+', left: { kind: 'field-ref', source: 'counter', field: 'value' }, right: { kind: 'literal', value: 1 } }, as: 'value' }],
            from: { kind: 'type', type: 'counter' },
            where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'counter', field: 'value' }, right: { kind: 'literal', value: 3 } }],
          },
        },
      ],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'counter', field: 'value' }, as: 'value' }],
        from: { kind: 'type', type: 'counter' },
      },
    };
    const { sql } = fx.engine.toSQL(recursive, 'base');
    expect(sql.startsWith('WITH RECURSIVE "counter" AS (')).toBe(true);
    expect(sql).toContain('UNION ALL');
    expect(fx.engine.validateQuery(recursive).hasErrors).toBe(false);
    const q = fx.engine.parseQuery(recursive);
    expect(q.toJSON()).toEqual(recursive);
    expect(q.clone().toJSON()).toEqual(recursive);
  });

  it('hoists a final SELECT\'s own planner CTE into the single outer WITH', () => {
    const fx = fixture();
    // The final SELECT carries a fan-out aggregate ⇒ its own `agg_…` CTE, which
    // must merge into the outer WITH (not emit a second adjacent WITH).
    const hoist: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        { name: 'u', query: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }], from: { kind: 'type', type: 'user' } } },
      ],
      final: {
        kind: 'select',
        fields: [
          { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
          { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'relation-path', source: 'user', path: ['orders', 'total'] } } }, as: 'spent' },
        ],
        from: { kind: 'type', type: 'user' },
      },
    };
    const { sql } = fx.engine.toSQL(hoist, 'base');
    // Exactly one WITH, carrying both the named CTE and the hoisted agg CTE.
    expect(sql.startsWith('WITH ')).toBe(true);
    expect(sql.indexOf('WITH ', 1)).toBe(-1);
    expect(sql).toContain('"agg_sum_user_orders" AS (');
  });

  it('drives the base Query.emitWith via a CTE whose final arm is a set-op', () => {
    const fx = fixture();
    const def: CTEStatementDef = {
      kind: 'cte',
      ctes: [
        { name: 'u', query: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }], from: { kind: 'type', type: 'user' } } },
      ],
      final: { kind: 'union', left, right },
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql.startsWith('WITH "u" AS (')).toBe(true);
    expect(sql).toContain('UNION');
  });

  it('CTEStatementQuery.from rejects a non-cte def', () => {
    const fx = fixture();
    expect(() => CTEStatementQuery.from({ kind: 'select' } as unknown as QueryDef, fx.registry)).toThrow(/expected 'cte'/);
  });
});

describe('ExprQuery — the single-expression query', () => {
  const def: ExprQueryDef = { kind: 'expr', expr: { kind: 'binary', op: '+', left: { kind: 'literal', value: 2 }, right: { kind: 'literal', value: 3 } } };

  it('resolves to a single `value` field, validates, costs one row, and reads no types', () => {
    const fx = fixture();
    expect(fx.engine.resolveQuery(def).kind).not.toBe('type');
    expect(fx.engine.validateQuery(def).hasErrors).toBe(false);
    expect(fx.engine.cost(def).rows).toBe(1);
    expect(fx.engine.parseQuery(def).referencedTypes()).toEqual([]);
  });

  it('executes into one { value } row', async () => {
    const fx = fixture();
    const res = await fx.engine.run(def);
    expect(res.rows).toEqual([{ value: 5 }]);
    expect(res.fields.map((f) => f.name)).toEqual(['value']);
  });

  it('emits SELECT <expr> AS "value" and round-trips through toJSON / clone', () => {
    const fx = fixture();
    const emitted = fx.engine.toSQL(def, 'base');
    expect(emitted.sql).toBe('SELECT (? + ?) AS "value"');
    expect(emitted.params).toEqual([2, 3]);
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual(def);
    expect(q.clone().toJSON()).toEqual(def);
  });

  it('reports no params / no filter-sources (base Query introspection), and validates top-level', () => {
    const fx = fixture();
    const q = fx.engine.parseQuery(def);
    expect(q.params(fx.engine)).toEqual([]);
    expect(q.filterSources(fx.engine)).toEqual([]);
    expect(q.validate(fx.engine).hasErrors).toBe(false);
  });

  it('ExprQuery.from rejects a non-expr def', () => {
    const fx = fixture();
    const bad: ExprDef = { kind: 'literal', value: 1 };
    expect(() => ExprQuery.from({ kind: 'select' } as unknown as QueryDef, fx.registry)).toThrow(/expected 'expr'/);
    void bad;
  });
});
