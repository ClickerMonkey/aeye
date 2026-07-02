/**
 * Coverage: QuerySource (subquery + tabular-function sources), QueryJoin
 * (inner/right/full runtime + `and` predicate + finalAlias + clone),
 * QueryOrder (clone + null-placement comparator), `_cost` selectivity branches,
 * and the remaining SelectQuery gaps (filterSources, natural names, bare-agg
 * cost, unresolved join at runtime, ORDER BY NULLS SQL, join `and` SQL, toJSON
 * optional clauses, cloneBound param).
 */
import { describe, it, expect } from 'vitest';
import { Value } from '../runtime/value';
import { runtimeFixture, fixture } from './_utils';
import { QueryJoin } from '../queries/join';
import { SelectQuery } from '../queries/select';
import type { NamedArgs } from '../runtime/functions';
import type { SelectDef, QueryDef } from '../schema';
import type { Type } from '../type';

// ─── Subquery source ─────────────────────────────────────────────────────────

const subquerySelect: SelectDef = {
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 's', field: 'name' }, as: 'name' }],
  from: {
    kind: 'subquery',
    as: 's',
    query: {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
      ],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 1 } }],
    },
  },
};

describe('QuerySource — subquery (derived) source', () => {
  it('resolves, validates, runs, costs, and reports referenced types', async () => {
    const fx = runtimeFixture();
    expect(fx.engine.resolveQuery(subquerySelect).kind).toBe('field');
    expect(fx.engine.validateQuery(subquerySelect).hasErrors).toBe(false);
    expect(fx.engine.cost(subquerySelect).rows).toBeGreaterThanOrEqual(0);
    expect(fx.engine.parseQuery(subquerySelect).referencedTypes()).toContain('user');
    const res = await fx.engine.run(subquerySelect);
    expect(res.rows).toEqual([{ name: 'Ada' }]);
  });

  it('emits (subquery) AS "alias" and round-trips through toJSON / clone', () => {
    const fx = runtimeFixture();
    const { sql } = fx.engine.toSQL(subquerySelect, 'base');
    expect(sql).toContain('FROM (SELECT');
    expect(sql).toContain(') AS "s"');
    const q = fx.engine.parseQuery(subquerySelect);
    expect(q.toJSON()).toEqual(subquerySelect);
    expect(q.clone().toJSON()).toEqual(subquerySelect);
  });

  it('reports an unknown source type / CTE name', () => {
    const fx = runtimeFixture();
    // An `aliased` source binds under `as` (not the type name), so the unknown
    // type name is not self-bound and the missing-type error fires.
    const bad: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'literal', value: 1 }, as: 'x' }],
      from: { kind: 'aliased', type: 'ghost', as: 'g' },
    };
    expect(fx.engine.validateQuery(bad).list.some((p) => p.code === 'source.unknown-type')).toBe(true);
  });
});

// ─── Tabular-function source: non-array + non-object row handling ────────────

const get = (a: NamedArgs, k: string): Value => a[k] ?? Value.null();

describe('QuerySource — tabular-function source row coercion', () => {
  it('a non-array function result yields zero rows; non-object rows yield empty records', async () => {
    const fx = runtimeFixture();
    const r = fx.registry;
    // scalarFn returns a scalar (not an array) ⇒ no rows.
    r.registerFunction({ name: 'scalarFn', shape: 'tabular', params: [], output: { type: 'user' } });
    r.registerFunctionRun('scalarFn', { shape: 'tabular', run: () => Value.of(42) });
    // primFn returns an ARRAY OF NUMBERS (non-object rows) ⇒ empty records.
    r.registerFunction({ name: 'primFn', shape: 'tabular', params: [], output: { type: 'user' } });
    r.registerFunctionRun('primFn', { shape: 'tabular', run: () => Value.of([1, 2, 3]) });

    const scalarSel: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'r', field: 'id' }, as: 'id' }],
      from: { kind: 'function', function: 'scalarFn', args: {}, as: 'r' },
    };
    expect((await fx.engine.run(scalarSel)).rows).toEqual([]);

    const primSel: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'r', field: 'id' }, as: 'id' }],
      from: { kind: 'function', function: 'primFn', args: {}, as: 'r' },
    };
    const res = await fx.engine.run(primSel);
    // Three rows, each an empty record ⇒ id projects to null.
    expect(res.rows).toEqual([{ id: null }, { id: null }, { id: null }]);
  });

  it('clones a tabular-function source', () => {
    const fx = runtimeFixture();
    fx.registry.registerFunction({ name: 'rangeRows', shape: 'tabular', params: [{ name: 'count', type: { kind: 'number' } }], output: { type: 'user' } });
    fx.registry.registerFunctionRun('rangeRows', {
      shape: 'tabular',
      run: (a) => {
        const n = get(a, 'count').isNull() ? 0 : Math.trunc(get(a, 'count').toNumber());
        const rows: { id: number }[] = [];
        for (let i = 0; i < n; i++) rows.push({ id: i });
        return Value.of(rows);
      },
    });
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'r', field: 'id' }, as: 'id' }],
      from: { kind: 'function', function: 'rangeRows', args: { count: { kind: 'literal', value: 2 } }, as: 'r' },
    };
    const q = fx.engine.parseQuery(def);
    expect(q.clone().toJSON()).toEqual(def);
  });
});

// ─── QueryJoin: inner / right / full runtime + `and` predicate ───────────────

function joinSelect(joinType: 'inner' | 'right' | 'full', and?: boolean): SelectDef {
  return {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'uid' },
      { expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'oid' },
    ],
    from: { kind: 'type', type: 'user' },
    joins: [{
      on: { source: 'user', field: 'orders' },
      joinType,
      ...(and ? { and: { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 60 } } } : {}),
    }],
  };
}

describe('QueryJoin — runtime join types + `and`', () => {
  it('runs an INNER join (only matched rows)', async () => {
    const fx = runtimeFixture();
    const res = await fx.engine.run(joinSelect('inner'));
    // Users 1 & 2 each have 2 orders; user 3 (Cleo) has none ⇒ excluded.
    expect(res.rows.length).toBe(4);
    expect(res.rows.every((r) => r['oid'] !== null)).toBe(true);
  });

  it('runs a RIGHT join (every target row, unmatched left padded)', async () => {
    const fx = runtimeFixture();
    const res = await fx.engine.run(joinSelect('right'));
    // Every order appears at least once.
    expect(res.rows.length).toBeGreaterThanOrEqual(4);
    expect(res.rows.map((r) => r['oid']).sort()).toEqual([10, 11, 12, 13]);
  });

  it('runs a FULL join (matched + unmatched on both sides)', async () => {
    const fx = runtimeFixture();
    const res = await fx.engine.run(joinSelect('full'));
    // Cleo (no orders) appears once with a null oid.
    expect(res.rows.some((r) => r['uid'] === 3 && r['oid'] === null)).toBe(true);
    expect(res.rows.map((r) => r['oid']).filter((v) => v !== null).sort()).toEqual([10, 11, 12, 13]);
  });

  it('applies a join `and` predicate at runtime (inner)', async () => {
    const fx = runtimeFixture();
    const res = await fx.engine.run(joinSelect('inner', true));
    // total > 60 ⇒ orders 10 (100) and 12 (200) only.
    expect(res.rows.map((r) => r['oid']).sort()).toEqual([10, 12]);
  });

  it('finalAlias + expansionFactor resolve from the alias→Type map (and degrade)', () => {
    const fx = runtimeFixture();
    const join = QueryJoin.from({ on: { source: 'user', field: 'orders' } }, fx.registry);
    const aliasTypes = new Map<string, Type>([['user', fx.user]]);
    expect(join.label).toBe('user.orders');
    expect(join.finalAlias(fx.engine, aliasTypes)).toBe('order');
    // An empty alias map ⇒ no root ⇒ unresolved (finalAlias undefined, factor 1).
    expect(join.finalAlias(fx.engine, new Map())).toBeUndefined();
    expect(join.expansionFactor(fx.engine, new Map())).toBe(1);
    // Fan-out relation ⇒ factor = max(1, count).
    expect(join.expansionFactor(fx.engine, aliasTypes)).toBeGreaterThan(1);
    // A non-relation field ⇒ factor 1.
    const nonRel = QueryJoin.from({ on: { source: 'user', field: 'name' } }, fx.registry);
    expect(nonRel.expansionFactor(fx.engine, aliasTypes)).toBe(1);
    expect(nonRel.finalAlias(fx.engine, aliasTypes)).toBeUndefined();
  });

  it('clones a join with and without an `and` predicate', () => {
    const fx = runtimeFixture();
    const withAnd = fx.engine.parseQuery(joinSelect('inner', true));
    expect(withAnd.clone().toJSON()).toEqual(joinSelect('inner', true));
    const noAnd = fx.engine.parseQuery(joinSelect('inner'));
    expect(noAnd.clone().toJSON()).toEqual(joinSelect('inner'));
  });
});

// ─── QueryOrder: clone + null placement comparator ──────────────────────────

describe('QueryOrder — null placement comparator + clone', () => {
  it('orders a nullable column with default and explicit NULLS placement', async () => {
    const fx = runtimeFixture();
    const base = (dir: 'asc' | 'desc', nulls?: 'first' | 'last'): SelectDef => ({
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'order', field: 'note' }, as: 'note' },
      ],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: { kind: 'field-ref', source: 'order', field: 'note' }, dir, ...(nulls ? { nulls } : {}) }],
    });
    // asc ⇒ nulls first by default (orders 11 & 13 both null lead).
    const asc = await fx.engine.run(base('asc'));
    expect(asc.rows.slice(0, 2).every((r) => r['note'] === null)).toBe(true);
    // explicit NULLS LAST ⇒ nulls trail.
    const last = await fx.engine.run(base('asc', 'last'));
    expect(last.rows.slice(-2).every((r) => r['note'] === null)).toBe(true);
    // desc path exercises the negated comparator.
    const desc = await fx.engine.run(base('desc'));
    expect(desc.rows.length).toBe(4);
  });

  it('clones an ORDER BY term (with explicit nulls)', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'order' },
      order: [{ expr: { kind: 'field-ref', source: 'order', field: 'note' }, dir: 'asc', nulls: 'first' }],
    };
    expect(fx.engine.parseQuery(def).clone().toJSON()).toEqual(def);
  });
});

// ─── _cost selectivity branches ──────────────────────────────────────────────

describe('_cost — predicate selectivity + distinct estimation branches', () => {
  it('costs a WHERE mixing equality (ref on either side, non-indexed), range, <>, between, in, is-null, logical', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      where: [
        { kind: 'comparison', op: '=', left: { kind: 'literal', value: 1 }, right: { kind: 'field-ref', source: 'user', field: 'id' } },
        { kind: 'comparison', op: '=', left: { kind: 'literal', value: 5 }, right: { kind: 'literal', value: 6 } },
        { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'name' }, right: { kind: 'literal', value: 'Ada' } },
        { kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 99 } },
        { kind: 'comparison', op: '<>', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 0 } },
        { kind: 'between', value: { kind: 'field-ref', source: 'user', field: 'age' }, lower: { kind: 'literal', value: 1 }, upper: { kind: 'literal', value: 100 } },
        { kind: 'in', value: { kind: 'field-ref', source: 'user', field: 'id' }, in: [{ kind: 'literal', value: 1 }, { kind: 'literal', value: 2 }] },
        { kind: 'is-null', value: { kind: 'field-ref', source: 'user', field: 'age' } },
        { kind: 'logical', op: 'and', operands: [{ kind: 'literal', value: true }, { kind: 'literal', value: true }] },
      ],
    };
    expect(fx.engine.cost(def).rows).toBeGreaterThanOrEqual(1);
  });

  it('adds a per-row scan penalty for text-search / semantic predicates', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      where: [
        { kind: 'text-search', source: 'user', field: 'email', query: 'ada' },
        { kind: 'semantic', source: 'user', field: 'email', query: 'hello' },
      ],
    };
    expect(fx.engine.cost(def).bytes).toBeGreaterThan(0);
  });

  it('estimates GROUP BY distinct via an indexed key', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      groupBy: [{ kind: 'field-ref', source: 'user', field: 'id' }],
    };
    expect(fx.engine.cost(def).rows).toBeGreaterThanOrEqual(1);
  });
});

// ─── SelectQuery remaining gaps ──────────────────────────────────────────────

describe('SelectQuery — remaining surfaces', () => {
  it('filterSources exposes the FROM alias + each join target alias', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { source: 'user', field: 'orders' }, joinType: 'inner' }],
    };
    expect(fx.engine.parseQuery(def).filterSources(fx.engine)).toEqual(['user', 'order']);
  });

  it('derives natural output names for field-ref / relation-path / aggregate / other (no alias)', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'total' } },
        { expr: { kind: 'relation-path', source: 'order', path: ['userId', 'name'] } },
        { expr: { kind: 'aggregate', function: 'count', args: {} } },
        { expr: { kind: 'literal', value: 7 } },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [{ kind: 'field-ref', source: 'order', field: 'total' }],
    };
    const names = fx.engine.parseQuery(def).outputFields(fx.engine, fx.engine.globalScope()).map((f) => f.name);
    expect(names).toEqual(['total', 'name', 'count', 'col3']);
  });

  it('a bare aggregate (no GROUP BY) costs a single row', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' }],
      from: { kind: 'type', type: 'user' },
    };
    expect(fx.engine.cost(def).rows).toBe(1);
  });

  it('an unresolved join (non-relation field) expands to no extra rows at runtime', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'user' },
      // `name` is text, not a relation ⇒ buildPlan returns undefined ⇒ no expansion.
      joins: [{ on: { source: 'user', field: 'name' } }],
    };
    const res = await fx.engine.run(def);
    expect(res.rows.map((r) => r['id'])).toEqual([1, 2, 3]);
  });

  it('emits ORDER BY … NULLS and a join `and` in SQL, and round-trips a rich select', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { source: 'user', field: 'orders' }, joinType: 'inner', and: { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 10 } } }],
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 1 } }],
      groupBy: [{ kind: 'field-ref', source: 'user', field: 'name' }],
      having: [{ kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'count', args: {} }, right: { kind: 'literal', value: 0 } }],
      order: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, dir: 'asc', nulls: 'last' }],
      limit: { kind: 'param', name: 'lim' },
      offset: 2,
    };
    const { sql } = fx.engine.toSQL(def, 'base', { params: { lim: 5 } });
    expect(sql).toContain('NULLS LAST');
    expect(sql).toContain('INNER JOIN');
    expect(sql).toContain('"order"."total" > ');
    const q = fx.engine.parseQuery(def);
    expect(q.toJSON()).toEqual(def);
    expect(q.clone().toJSON()).toEqual(def);
  });

  it('SelectQuery.from rejects a non-select def', () => {
    const fx = fixture();
    const bad: QueryDef = { kind: 'delete', from: 'user' };
    expect(() => SelectQuery.from(bad, fx.registry)).toThrow(/expected 'select'/);
  });
});
