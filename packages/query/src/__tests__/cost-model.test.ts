/**
 * Cost-model — the Phase-"organize cost into the classes" behaviours:
 *  - per-expr selectivity / scan-penalty / index-probe / conjunct flattening
 *    (no `instanceof` in the cost model);
 *  - AND-flattening + `IN`-list index probes;
 *  - execution-time `filters` / dynamic `sorter` woven into the estimate;
 *  - per-field / per-index / derived Type bytes + index-only (covered) scans.
 */
import { describe, it, expect } from 'vitest';
import { fixture } from './_utils';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { QueryDef, SelectDef, TypeDef } from '../schema';

/** A `count(*)` subquery over the whole `order` table (inner cost = 1 row). */
const countOrders: QueryDef = {
  kind: 'select',
  fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} } }],
  from: { kind: 'type', type: 'order' },
};

// ─── AND-flattening + composite-index / IN probes ────────────────────────────

describe('cost-model: AND-flattening and IN-list index probes', () => {
  // A `widget` with a composite index on (a, b): prefix counts 100 then 1.
  const widget: TypeDef = {
    name: 'widget',
    fields: [
      { name: 'a', type: { kind: 'number', whole: true } },
      { name: 'b', type: { kind: 'number', whole: true } },
      { name: 'c', type: { kind: 'number', whole: true } },
    ],
    indexes: [
      {
        exprs: [
          { expr: { kind: 'field-ref', source: 'widget', field: 'a' }, count: 100 },
          { expr: { kind: 'field-ref', source: 'widget', field: 'b' }, count: 1 },
        ],
      },
    ],
    count: 1000,
    bytes: 40,
  };

  function widgetEngine(): QueryEngine {
    const registry = createRegistry();
    registry.registerType(registry.parseType(widget));
    registry.finalize();
    return new QueryEngine(registry);
  }

  const eq = (field: string, v: number): any => ({
    kind: 'comparison',
    op: '=',
    left: { kind: 'field-ref', source: 'widget', field },
    right: { kind: 'literal', value: v },
  });

  const selectC = (where: any[]): SelectDef => ({
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'widget', field: 'c' } }],
    from: { kind: 'type', type: 'widget' },
    where,
  });

  it('a NESTED `and(and(a=1, b=2), c=3)` flattens so the (a,b) prefix collapses to 1 row', () => {
    const engine = widgetEngine();
    const nested = {
      kind: 'logical',
      op: 'and',
      operands: [{ kind: 'logical', op: 'and', operands: [eq('a', 1), eq('b', 2)] }, eq('c', 3)],
    };
    // The (a,b) equality prefix ⇒ 1 row; `c=3` adds no further reduction below 1.
    expect(engine.cost(selectC([nested])).rows).toBe(1);
  });

  it('an `IN` list on the leading index column scales the matched rows by its arity', () => {
    const engine = widgetEngine();
    const def = selectC([
      { kind: 'in', value: { kind: 'field-ref', source: 'widget', field: 'a' }, in: [
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 2 },
        { kind: 'literal', value: 3 },
      ] },
    ]);
    // The `a` prefix distinct-count is 100; an IN of 3 values ⇒ ~3 of those buckets.
    expect(engine.cost(def).rows).toBe(100 * 3);
  });

  it('an `IN` on a NON-indexed column applies membership selectivity (no prefix match)', () => {
    const engine = widgetEngine();
    const def = selectC([
      { kind: 'in', value: { kind: 'field-ref', source: 'widget', field: 'c' }, in: [
        { kind: 'literal', value: 1 },
        { kind: 'literal', value: 2 },
      ] },
    ]);
    // `c` is unindexed ⇒ 1000 × 0.5 IN-selectivity.
    expect(engine.cost(def).rows).toBe(500);
  });

  it('a top-level OR is an opaque conjunct — no index / selectivity reduction', () => {
    const engine = widgetEngine();
    const def = selectC([{ kind: 'logical', op: 'or', operands: [eq('a', 1), eq('b', 2)] }]);
    expect(engine.cost(def).rows).toBe(1000);
  });

  it('IN declines an index probe for the subquery, NOT IN, and non-column-value forms', () => {
    const engine = widgetEngine();
    const sub: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'w2', field: 'a' } }],
      from: { kind: 'aliased', type: 'widget', as: 'w2' },
    };
    // Subquery form ⇒ not a static point-set (probe declined).
    expect(engine.cost(selectC([{ kind: 'in', value: { kind: 'field-ref', source: 'widget', field: 'a' }, in: sub }])).rows).toBeGreaterThan(0);
    // NOT IN over the leading index column ⇒ not a point-set (selectivity, not index).
    expect(engine.cost(selectC([{ kind: 'in', not: true, value: { kind: 'field-ref', source: 'widget', field: 'a' }, in: [{ kind: 'literal', value: 1 }] }])).rows).toBe(500);
    // A non-column value ⇒ no probe.
    expect(engine.cost(selectC([{ kind: 'in', value: { kind: 'literal', value: 5 }, in: [{ kind: 'literal', value: 1 }] }])).rows).toBe(500);
  });
});

// ─── Execution-time filters woven into cost ──────────────────────────────────

describe('cost-model: execution-time filters', () => {
  const filtersSelect: SelectDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    from: { kind: 'type', type: 'order' },
    where: [{ kind: 'filters', source: 'order' }],
  };

  it('an UNSUPPLIED filter placeholder is neutral (no row reduction)', () => {
    const fx = fixture();
    expect(fx.engine.cost(filtersSelect).rows).toBe(5000);
  });

  it("a supplied range filter weaves its selectivity in (5000 × 0.5)", () => {
    const fx = fixture();
    const c = fx.engine.cost(filtersSelect, undefined, {
      filters: { order: { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 100 } } },
    });
    expect(c.rows).toBe(2500);
  });

  it('a supplied filter containing a SUBQUERY raises the cost by the subquery scan', () => {
    const fx = fixture();
    const c = fx.engine.cost(filtersSelect, undefined, {
      filters: { order: { kind: 'exists', query: countOrders } },
    });
    // 5000 base (EXISTS applies no reduction) + the subquery's {1 row} once.
    expect(c.rows).toBe(5001);
  });
});

// ─── Dynamic sorter cost ─────────────────────────────────────────────────────

describe('cost-model: dynamic sorter cost', () => {
  const base: SelectDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
    from: { kind: 'type', type: 'user' },
  };

  it('a concrete ORDER BY term costs its sort expr per pre-LIMIT row', () => {
    const fx = fixture();
    const orderBySubquery: SelectDef = {
      ...base,
      order: [{ expr: { kind: 'subquery', query: countOrders }, dir: 'desc' }],
    };
    // base 1000 + the subquery {1 row} evaluated once per sorted (pre-LIMIT) row.
    expect(fx.engine.cost(orderBySubquery).rows).toBe(1000 + 1000);
    // A plain-column order term adds nothing.
    const orderByColumn: SelectDef = { ...base, order: [{ expr: { kind: 'field-ref', source: 'user', field: 'age' }, dir: 'asc' }] };
    expect(fx.engine.cost(orderByColumn).rows).toBe(1000);
  });

  it('sorting by a plain column adds no fan-out rows', () => {
    const fx = fixture();
    const withColumnSort: SelectDef = {
      ...base,
      order: [{ kind: 'sorter', sorts: { byName: { kind: 'field-ref', source: 'user', field: 'name' } } } as any],
    };
    expect(fx.engine.cost(withColumnSort).rows).toBe(fx.engine.cost(base).rows);
  });

  it('a sorter whose catalog holds a SUBQUERY sort key costs it once per sorted row', () => {
    const fx = fixture();
    const withSubquerySort: SelectDef = {
      ...base,
      order: [{ kind: 'sorter', sorts: { byCount: { kind: 'subquery', query: countOrders } } } as any],
    };
    // base 1000 rows + the subquery {1 row} evaluated per pre-LIMIT row (1000).
    expect(fx.engine.cost(withSubquerySort).rows).toBe(1000 + 1000);
  });

  it('a runtime `sort` selection narrows a multi-entry sorter to the chosen key', () => {
    const fx = fixture();
    const sorter: SelectDef = {
      ...base,
      order: [{ kind: 'sorter', sorts: {
        cheap: { kind: 'field-ref', source: 'user', field: 'name' },
        pricey: { kind: 'subquery', query: countOrders },
      } } as any],
    };
    // Worst case (no selection) charges the pricey subquery key…
    expect(fx.engine.cost(sorter).rows).toBe(2000);
    // …selecting only the cheap column key drops the subquery cost.
    expect(fx.engine.cost(sorter, undefined, { sort: [{ sort: 'cheap', dir: 'asc' }] }).rows).toBe(1000);
  });

  it('with no runtime selection a sorter falls back to its defaultSort entries', () => {
    const fx = fixture();
    const sorter: SelectDef = {
      ...base,
      order: [{ kind: 'sorter', sorts: {
        cheap: { kind: 'field-ref', source: 'user', field: 'name' },
        pricey: { kind: 'subquery', query: countOrders },
      }, defaultSort: [{ sort: 'pricey', dir: 'asc' }] } as any],
    };
    // No `sort` option ⇒ defaultSort drives the cost (the pricey subquery key).
    expect(fx.engine.cost(sorter).rows).toBe(2000);
  });

  it('a runtime sort naming an entry absent from the catalog charges nothing for it', () => {
    const fx = fixture();
    const sorter: SelectDef = {
      ...base,
      order: [{ kind: 'sorter', sorts: { pricey: { kind: 'subquery', query: countOrders } } } as any],
    };
    expect(fx.engine.cost(sorter, undefined, { sort: [{ sort: 'nope', dir: 'asc' }] }).rows).toBe(1000);
  });
});

// ─── Per-field / per-index / derived bytes + covered scans ───────────────────

describe('cost-model: field / index bytes and covered scans', () => {
  it('a Type with no explicit `bytes` derives the whole-row size from its fields', () => {
    const registry = createRegistry();
    const t = registry.parseType({
      name: 'thing',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true }, bytes: 4 },
        { name: 'label', type: { kind: 'text' }, bytes: 20 },
      ],
      count: 10,
    } as TypeDef);
    registry.registerType(t);
    registry.finalize();
    expect(t.bytes).toBe(24); // 4 + 20
  });

  it('a registry default byte size fills in fields that declare none', () => {
    const registry = createRegistry();
    registry.setDefaultFieldBytes('text', 100);
    const t = registry.parseType({
      name: 'note',
      fields: [{ name: 'body', type: { kind: 'text' } }],
      count: 5,
    } as TypeDef);
    registry.registerType(t);
    registry.finalize();
    expect(t.bytes).toBe(100);
  });

  it('an index-only (covered) scan sizes bytes by the index entry, not the whole row', () => {
    const registry = createRegistry();
    const covered: TypeDef = {
      name: 'kv',
      fields: [
        { name: 'k', type: { kind: 'number', whole: true }, bytes: 8 },
        { name: 'v', type: { kind: 'text' }, bytes: 200 }, // a fat non-indexed column
      ],
      indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'kv', field: 'k' }, count: 1 }] }],
      count: 1000,
      bytes: 208,
    };
    registry.registerType(registry.parseType(covered));
    registry.finalize();
    const engine = new QueryEngine(registry);
    // SELECT k WHERE k = 5 — every column is in the (unique) index it probes.
    const c = engine.cost({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'kv', field: 'k' } }],
      from: { kind: 'type', type: 'kv' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'kv', field: 'k' }, right: { kind: 'literal', value: 5 } }],
    });
    expect(c.rows).toBe(1); // unique index
    expect(c.bytes).toBe(8); // index-entry bytes (k), NOT the 208-byte row
  });

  it('Index.bytes: an explicit value wins; a non-field-ref part uses the fallback default', () => {
    const registry = createRegistry();
    const t = registry.parseType({
      name: 'idx',
      fields: [{ name: 'k', type: { kind: 'number', whole: true }, bytes: 8 }],
      indexes: [
        { exprs: [{ expr: { kind: 'field-ref', source: 'idx', field: 'k' }, count: 1 }], bytes: 99 },
        { exprs: [{ expr: { kind: 'literal', value: 1 }, count: 5 }] },
      ],
      count: 10,
      bytes: 8,
    } as TypeDef);
    registry.registerType(t);
    registry.finalize();
    expect(t.indexes[0]!.bytes(t)).toBe(99); // explicit entry size wins
    expect(t.indexes[1]!.bytes(t)).toBe(8); // non-field-ref part ⇒ fixed fallback
    // toJSON emits `bytes` only for the explicitly-sized index.
    const json = t.toJSON();
    expect(json.indexes![0]!.bytes).toBe(99);
    expect(json.indexes![1]!.bytes).toBeUndefined();
  });

  it('outputCost sizes by the PROJECTION width, not the whole scanned row', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
    };
    // Processing cost sizes by the whole 64-byte row; the OUTPUT is only the
    // 8-byte `id` column.
    expect(fx.engine.cost(def).bytes).toBe(1000 * 64);
    const out = fx.engine.outputCost(def);
    expect(out.rows).toBe(1000);
    expect(out.bytes).toBe(1000 * 8);
  });

  it('outputCost honours a literal LIMIT / OFFSET', () => {
    const fx = fixture();
    const base: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
    };
    expect(fx.engine.outputCost({ ...base, limit: 10 }).rows).toBe(10);
    // OFFSET drops rows before the (absent) LIMIT.
    expect(fx.engine.outputCost({ ...base, offset: 995 }).rows).toBe(5);
    // OFFSET then LIMIT.
    expect(fx.engine.outputCost({ ...base, offset: 995, limit: 10 }).rows).toBe(5);
  });

  it('outputCost resolves a param-bound LIMIT from ctx.params (else leaves it uncapped)', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      limit: { kind: 'param', name: 'n' },
    };
    expect(fx.engine.outputCost(def).rows).toBe(1000); // no param supplied ⇒ uncapped
    expect(fx.engine.outputCost(def, undefined, { params: { n: 25 } }).rows).toBe(25);
  });

  it('a UNION outputCost sums the arms and caps by the set-level LIMIT', () => {
    const fx = fixture();
    const left: QueryDef = { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } };
    const right: QueryDef = { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }], from: { kind: 'type', type: 'order' } };
    expect(fx.engine.outputCost({ kind: 'union', left, right } as QueryDef).rows).toBe(6000);
    expect(fx.engine.outputCost({ kind: 'union', left, right, limit: 100 } as QueryDef).rows).toBe(100);
    // A param-bound set LIMIT resolves too…
    expect(fx.engine.outputCost({ kind: 'union', left, right, limit: { kind: 'param', name: 'k' } } as QueryDef, undefined, { params: { k: 42 } }).rows).toBe(42);
    // …and stays uncapped when the param value isn't supplied.
    expect(fx.engine.outputCost({ kind: 'union', left, right, limit: { kind: 'param', name: 'k' } } as QueryDef).rows).toBe(6000);
  });

  it('a CTE outputCost delegates to its final query', () => {
    const fx = fixture();
    const cte: QueryDef = {
      kind: 'cte',
      ctes: [{ name: 't', query: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } } }],
      final: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }], from: { kind: 'type', type: 'order' }, limit: 7 },
    } as QueryDef;
    expect(fx.engine.outputCost(cte).rows).toBe(7);
  });

  it('a non-SELECT query defaults outputCost to its processing cost', () => {
    const fx = fixture();
    const expr: QueryDef = { kind: 'expr', expr: { kind: 'literal', value: 5 } } as QueryDef;
    expect(fx.engine.outputCost(expr)).toEqual(fx.engine.cost(expr));
  });

  it('projecting a NON-indexed column falls back to the whole-row byte width', () => {
    const registry = createRegistry();
    const t: TypeDef = {
      name: 'kv2',
      fields: [
        { name: 'k', type: { kind: 'number', whole: true }, bytes: 8 },
        { name: 'v', type: { kind: 'text' }, bytes: 200 },
      ],
      indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'kv2', field: 'k' }, count: 1 }] }],
      count: 1000,
      bytes: 208,
    };
    registry.registerType(registry.parseType(t));
    registry.finalize();
    const engine = new QueryEngine(registry);
    // SELECT v (not covered by the index on k) WHERE k = 5 ⇒ full-row bytes.
    const c = engine.cost({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'kv2', field: 'v' } }],
      from: { kind: 'type', type: 'kv2' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'kv2', field: 'k' }, right: { kind: 'literal', value: 5 } }],
    });
    expect(c.rows).toBe(1);
    expect(c.bytes).toBe(208);
  });
});

// ─── changeInterval (data-freshness estimate) ────────────────────────────────

describe('cost-model: changeInterval', () => {
  // Types with assorted `changes` rates (ms): always / never / periodic, plus
  // fields whose own rate overrides the Type's.
  function changeEngine(): QueryEngine {
    const registry = createRegistry();
    const defs: TypeDef[] = [
      { name: 'always', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 10, bytes: 8 }, // no `changes` ⇒ default 0
      { name: 'never', fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'label', type: { kind: 'text' } }], count: 10, bytes: 40, changes: -1 },
      { name: 'slow', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 10, bytes: 8, changes: 60000 },
      { name: 'fast', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 10, bytes: 8, changes: 5000 },
      // A hot field churns faster than its (slow) Type; a frozen field is immutable.
      { name: 'mixed', fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'hot', type: { kind: 'number', whole: true }, changes: 1000 }, { name: 'frozen', type: { kind: 'text' }, changes: -1 }], count: 10, bytes: 24, changes: 60000 },
    ];
    for (const d of defs) registry.registerType(registry.parseType(d));
    // Functions with estimation metadata (no runtime needed for cost / references).
    const num = { kind: 'number', whole: true } as const;
    registry.registerFunction({ name: 'todayfn', shape: 'scalar', params: [], output: num, changes: 86400000 }); // daily
    registry.registerFunction({ name: 'nowfn', shape: 'scalar', params: [], output: num, changes: 0 }); // always
    registry.registerFunction({ name: 'readsSlow', shape: 'scalar', params: [], output: num, references: ['slow'] });
    registry.registerFunction({ name: 'heavyfn', shape: 'scalar', params: [], output: num, cost: { rows: 3, bytes: 100 } }); // scans internally per call
    registry.finalize();
    return new QueryEngine(registry);
  }

  const call = (fn: string, from: string): QueryDef => ({ kind: 'select', fields: [{ expr: { kind: 'function-call', function: fn, args: {} } }], from: { kind: 'type', type: from } } as QueryDef);

  const sel = (type: string): QueryDef => ({ kind: 'select', fields: [{ expr: { kind: 'field-ref', source: type, field: 'id' } }], from: { kind: 'type', type } } as QueryDef);
  const selField = (type: string, field: string): QueryDef => ({ kind: 'select', fields: [{ expr: { kind: 'field-ref', source: type, field } }], from: { kind: 'type', type } } as QueryDef);

  it('reports a Type\'s change rate; -1 for immutable, the period for a churning Type', () => {
    const engine = changeEngine();
    expect(engine.changeInterval(sel('never'))).toBe(-1);
    expect(engine.changeInterval(sel('slow'))).toBe(60000);
    expect(engine.changeInterval(sel('always'))).toBe(0); // default 0 = always changing
  });

  it('only READ fields count — an unread volatile field does not drag the estimate down', () => {
    const engine = changeEngine();
    // mixed: Type 60000, hot 1000, frozen -1.
    // Reading only `id` ⇒ the Type's 60000 (the unread `hot` is NOT folded in).
    expect(engine.changeInterval(selField('mixed', 'id'))).toBe(60000);
    // Reading `hot` ⇒ its own 1000ms rate wins.
    expect(engine.changeInterval(selField('mixed', 'hot'))).toBe(1000);
    // Reading the immutable `frozen` ⇒ the Type's row-level 60000 still applies.
    expect(engine.changeInterval(selField('mixed', 'frozen'))).toBe(60000);
  });

  it('a multi-Type query folds to the FASTEST-changing input', () => {
    const engine = changeEngine();
    // UNION reads both arms ⇒ min(60000, 5000) = 5000.
    expect(engine.changeInterval({ kind: 'union', left: sel('slow'), right: sel('fast') } as QueryDef)).toBe(5000);
    // A never-changing arm is ignored; the periodic arm decides.
    expect(engine.changeInterval({ kind: 'union', left: sel('never'), right: sel('slow') } as QueryDef)).toBe(60000);
    // An always-changing arm dominates everything.
    expect(engine.changeInterval({ kind: 'union', left: sel('always'), right: sel('never') } as QueryDef)).toBe(0);
  });

  it('a query over no data (pure literals) never goes stale; an unregistered type is skipped', () => {
    const engine = changeEngine();
    expect(engine.changeInterval({ kind: 'expr', expr: { kind: 'literal', value: 1 } } as QueryDef)).toBe(-1);
    // A referenced-but-unregistered Type contributes nothing (folds to -1).
    expect(engine.changeInterval(sel('ghost'))).toBe(-1);
  });

  it('a called function contributes its OWN volatility even over immutable data', () => {
    const engine = changeEngine();
    // `never` is immutable (-1); a daily function makes the result stale daily.
    expect(engine.changeInterval(call('todayfn', 'never'))).toBe(86400000);
    // an always-changing function dominates.
    expect(engine.changeInterval(call('nowfn', 'never'))).toBe(0);
    // a function that READS a churning Type folds in that Type's rate.
    expect(engine.changeInterval(call('readsSlow', 'never'))).toBe(60000);
  });

  it('references() enumerates the Types, fields, and functions a query reads', () => {
    const engine = changeEngine();
    expect(engine.references(selField('mixed', 'hot'))).toEqual({ types: ['mixed'], fields: [{ type: 'mixed', field: 'hot' }], functions: [] });
    const fnRefs = engine.references(call('readsSlow', 'never'));
    expect(fnRefs.functions).toEqual(['readsSlow']);
    expect(fnRefs.types).toEqual(expect.arrayContaining(['never', 'slow'])); // 'slow' via the function's own reads
  });

  it('references() folds in execution-time filters and selected sorts', () => {
    const engine = changeEngine();
    // A supplied filter over `slow.id` adds that field to the reads.
    const withFilter = engine.references(sel('slow'), undefined, {
      filters: { slow: { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'slow', field: 'id' }, right: { kind: 'literal', value: 1 } } },
    });
    expect(withFilter.fields).toEqual(expect.arrayContaining([{ type: 'slow', field: 'id' }]));
  });

  it('a function-call folds its intrinsic fan-out `cost` into the query cost', () => {
    const engine = changeEngine();
    // heavyfn scans 3 rows/call ⇒ +3 per output row (10 `never` rows) = +30.
    const withHeavy = engine.cost(call('heavyfn', 'never'));
    const plain = engine.cost(call('nowfn', 'never'));
    expect(withHeavy.rows).toBe(plain.rows + 3 * 10);
  });

  it('built-in clock / random functions carry their volatility (currentDate daily, now/random always)', () => {
    const engine = changeEngine();
    expect(engine.lookupFunction('currentDate')!.changes).toBe(86400000);
    expect(engine.lookupFunction('now')!.changes).toBe(0);
    expect(engine.lookupFunction('random')!.changes).toBe(0);
    // A SELECT of currentDate() over immutable data still goes stale daily.
    expect(engine.changeInterval(call('currentDate', 'never'))).toBe(86400000);
    // A pure built-in leaves an immutable query immutable.
    expect(engine.changeInterval({ kind: 'select', fields: [{ expr: { kind: 'function-call', function: 'upper', args: { value: { kind: 'field-ref', source: 'never', field: 'label' } } } }], from: { kind: 'type', type: 'never' } } as QueryDef)).toBe(-1);
  });

  it('references() walks GROUP BY / HAVING / concrete ORDER BY and notes aggregate functions', () => {
    const engine = changeEngine();
    const refs = engine.references({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'fast', field: 'id' } }, { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' }],
      from: { kind: 'type', type: 'fast' },
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'fast', field: 'id' }, right: { kind: 'literal', value: 0 } }],
      groupBy: [{ kind: 'field-ref', source: 'fast', field: 'id' }],
      having: [{ kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'count', args: {} }, right: { kind: 'literal', value: 1 } }],
      order: [{ expr: { kind: 'field-ref', source: 'fast', field: 'id' }, dir: 'asc' }],
    } as QueryDef);
    expect(refs.functions).toContain('count');
    expect(refs.fields).toEqual(expect.arrayContaining([{ type: 'fast', field: 'id' }]));
  });

  it('references() walks a join `and` predicate', () => {
    const fx = fixture();
    const refs = fx.engine.references({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'o' }, and: { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'o', field: 'total' }, right: { kind: 'literal', value: 100 } } }],
    } as QueryDef);
    // the join's `and` reads `order.total`.
    expect(refs.fields).toEqual(expect.arrayContaining([{ type: 'order', field: 'total' }]));
  });

  it('references() merges functions across UNION arms', () => {
    const engine = changeEngine();
    const refs = engine.references({ kind: 'union', left: call('currentDate', 'never'), right: sel('fast') } as QueryDef);
    expect(refs.functions).toContain('currentDate');
    expect(refs.types).toEqual(expect.arrayContaining(['never', 'fast']));
  });

  it('a recursive CTE folds both arms for changeInterval', () => {
    const engine = changeEngine();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [{
        name: 'walk',
        base: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'slow', field: 'id' }, as: 'v' }], from: { kind: 'type', type: 'slow' } },
        recursive: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'walk', field: 'v' }, as: 'v' }], from: { kind: 'type', type: 'walk' } },
      }],
      final: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'walk', field: 'v' }, as: 'v' }], from: { kind: 'type', type: 'walk' } },
    } as QueryDef;
    // The base arm reads `slow` (60000); the rest is the CTE / immutable ⇒ 60000.
    expect(engine.changeInterval(def)).toBe(60000);
  });

  it('a tabular-function-call exposes its name and tolerates an unknown function in cost', () => {
    const engine = changeEngine();
    const expr = engine.parse({ kind: 'tabular-function-call', function: 'ghosttab', args: {} });
    expect(expr.functionRef()).toBe('ghosttab');
    // An unknown tabular function adds no intrinsic function cost.
    expect(expr.cost({ engine }, engine.globalScope()).rows).toBeGreaterThanOrEqual(0);
  });

  it('references() expands a sorter to only its SELECTED catalog exprs', () => {
    const engine = changeEngine();
    const refs = engine.references({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'mixed', field: 'id' } }],
      from: { kind: 'type', type: 'mixed' },
      order: [{ kind: 'sorter', sorts: { byHot: { kind: 'field-ref', source: 'mixed', field: 'hot' }, byFrozen: { kind: 'field-ref', source: 'mixed', field: 'frozen' } } }],
    } as QueryDef, undefined, { sort: [{ sort: 'byHot', dir: 'asc' }] });
    // Only the SELECTED `byHot` sort's field is read — `byFrozen` is not.
    expect(refs.fields).toEqual(expect.arrayContaining([{ type: 'mixed', field: 'hot' }]));
    expect(refs.fields).not.toContainEqual({ type: 'mixed', field: 'frozen' });
  });

  it('references() notes window functions', () => {
    const engine = changeEngine();
    const refs = engine.references({
      kind: 'select',
      fields: [{ expr: { kind: 'window', function: 'rowNumber', args: {} }, as: 'rn' }],
      from: { kind: 'type', type: 'fast' },
    } as QueryDef);
    expect(refs.functions).toContain('rowNumber');
  });

  it('references() of an expr query notes its functions (no bound scope, no fields)', () => {
    const engine = changeEngine();
    const refs = engine.references({ kind: 'expr', expr: { kind: 'function-call', function: 'currentDate', args: {} } } as QueryDef);
    expect(refs.functions).toContain('currentDate');
    expect(refs.fields).toEqual([]);
  });

  it('a CTE folds its entries and final query for changeInterval', () => {
    const engine = changeEngine();
    const cte: QueryDef = { kind: 'cte', ctes: [{ name: 't', query: sel('slow') }], final: sel('fast') } as QueryDef;
    // final reads `fast` (5000), entry reads `slow` (60000) ⇒ 5000.
    expect(engine.changeInterval(cte)).toBe(5000);
  });

  it('an unknown function-call contributes only its arg costs (no function found)', () => {
    const engine = changeEngine();
    const c = engine.cost({ kind: 'select', fields: [{ expr: { kind: 'function-call', function: 'ghostfn', args: {} } }], from: { kind: 'type', type: 'fast' } } as QueryDef);
    expect(c.rows).toBe(10); // fast.count, no fan-out from the missing function
  });

  it('function metadata round-trips through toJSON (emitting only when set)', () => {
    const engine = changeEngine();
    expect(engine.lookupFunction('todayfn')!.toJSON().changes).toBe(86400000);
    expect(engine.lookupFunction('heavyfn')!.toJSON().cost).toEqual({ rows: 3, bytes: 100 });
    expect(engine.lookupFunction('readsSlow')!.toJSON().references).toEqual(['slow']);
    // A pure function omits all three.
    const pure = engine.lookupFunction('upper')!.toJSON();
    expect(pure.changes).toBeUndefined();
    expect(pure.cost).toBeUndefined();
    expect(pure.references).toBeUndefined();
  });

  it('round-trips `changes` on Types and fields (emitting only when set)', () => {
    const engine = changeEngine();
    const json = engine.type('mixed')!.toJSON();
    expect(json.changes).toBe(60000);
    expect(json.fields.find((f) => f.name === 'hot')!.changes).toBe(1000);
    expect(json.fields.find((f) => f.name === 'id')!.changes).toBeUndefined();
    // A default (0) Type omits `changes`.
    expect(engine.type('always')!.toJSON().changes).toBeUndefined();
  });
});

// ─── affected (mutation estimate: total + per-type) ──────────────────────────

describe('cost-model: affected', () => {
  it('DELETE with no WHERE affects every row; a unique-index match affects one', () => {
    const fx = fixture();
    expect(fx.engine.affected({ kind: 'delete', from: 'order' } as QueryDef)).toEqual({ rows: 5000, types: [{ type: 'order', rows: 5000 }] });
    expect(fx.engine.affected({
      kind: 'delete',
      from: 'user',
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 5 } }],
    } as QueryDef)).toEqual({ rows: 1, types: [{ type: 'user', rows: 1 }] });
  });

  it('UPDATE affects the WHERE-matched rows (index / selectivity)', () => {
    const fx = fixture();
    // A range on the unindexed `age` ⇒ 1000 × 0.5.
    expect(fx.engine.affected({
      kind: 'update',
      type: 'user',
      set: { age: { kind: 'literal', value: 100 } },
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'user', field: 'age' }, right: { kind: 'literal', value: 30 } }],
    } as QueryDef)).toEqual({ rows: 500, types: [{ type: 'user', rows: 500 }] });
  });

  it('an OR is estimated as the UNION (index-merge) of its branches', () => {
    const fx = fixture();
    // total>100 (0.5) OR total<10 (0.5) ⇒ 1 − (0.5 × 0.5) = 0.75 ⇒ 3750.
    expect(fx.engine.affected({
      kind: 'delete',
      from: 'order',
      where: [{ kind: 'logical', op: 'or', operands: [
        { kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 100 } },
        { kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 10 } },
      ] }],
    } as QueryDef).rows).toBe(3750);
  });

  it('an OR of two unique-index equalities unions to ~2 rows', () => {
    const fx = fixture();
    const { rows } = fx.engine.affected({
      kind: 'delete',
      from: 'user',
      where: [{ kind: 'logical', op: 'or', operands: [
        { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 5 } },
        { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 6 } },
      ] }],
    } as QueryDef);
    expect(rows).toBeCloseTo(2, 2);
  });

  it('INSERT affects the VALUES row count, or the source SELECT output rows (on `into`)', () => {
    const fx = fixture();
    expect(fx.engine.affected({
      kind: 'insert',
      into: 'user',
      rows: [{ id: { kind: 'literal', value: 1 } }, { id: { kind: 'literal', value: 2 } }],
    } as QueryDef)).toEqual({ rows: 2, types: [{ type: 'user', rows: 2 }] });
    expect(fx.engine.affected({
      kind: 'insert',
      into: 'user',
      select: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' }, limit: 3 },
    } as QueryDef)).toEqual({ rows: 3, types: [{ type: 'user', rows: 3 }] });
  });

  it('a read-only SELECT affects nothing', () => {
    const fx = fixture();
    expect(fx.engine.affected({ kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } } as QueryDef)).toEqual({ rows: 0, types: [] });
  });

  it('an INSERT with neither VALUES nor a source SELECT affects nothing', () => {
    const fx = fixture();
    expect(fx.engine.affected({ kind: 'insert', into: 'user' } as QueryDef)).toEqual({ rows: 0, types: [] });
  });

  it('a non-OR logical (NOT) conjunct applies no reduction (conservative)', () => {
    const fx = fixture();
    expect(fx.engine.affected({
      kind: 'delete',
      from: 'user',
      where: [{ kind: 'logical', op: 'not', operands: [
        { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 5 } },
      ] }],
    } as QueryDef).rows).toBe(1000);
  });

  it('an UPDATE / DELETE over an unknown type affects nothing', () => {
    const fx = fixture();
    expect(fx.engine.affected({ kind: 'update', type: 'ghost', set: {}, where: [] } as QueryDef)).toEqual({ rows: 0, types: [] });
    expect(fx.engine.affected({ kind: 'delete', from: 'ghost', where: [] } as QueryDef)).toEqual({ rows: 0, types: [] });
  });

  it('a recursive CTE (read-only arms) affects nothing', () => {
    const fx = fixture();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [{
        name: 'walk',
        base: { kind: 'expr', expr: { kind: 'literal', value: 1 } },
        recursive: {
          kind: 'union',
          left: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'walk', field: 'value' }, as: 'value' }], from: { kind: 'type', type: 'walk' } },
          right: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'value' }], from: { kind: 'type', type: 'user' }, where: [{ kind: 'comparison', op: '<', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 0 } }] },
        },
      }],
      final: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'walk', field: 'value' }, as: 'value' }], from: { kind: 'type', type: 'walk' } },
    } as QueryDef;
    expect(fx.engine.affected(def)).toEqual({ rows: 0, types: [] });
  });

  it('a CTE breaks its mutations down PER TYPE across entries and the final query', () => {
    const fx = fixture();
    const cte: QueryDef = {
      kind: 'cte',
      ctes: [{ name: 't', query: {
        kind: 'delete',
        from: 'user',
        where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 5 } }],
      } }],
      final: { kind: 'delete', from: 'order' },
    } as QueryDef;
    // final DELETE order (5000) + entry DELETE user (1 unique row), one entry each.
    expect(fx.engine.affected(cte)).toEqual({ rows: 5001, types: [{ type: 'order', rows: 5000 }, { type: 'user', rows: 1 }] });
  });

  it('a CTE SUMS same-Type mutations into one breakdown entry', () => {
    const fx = fixture();
    const del = (id: number): QueryDef => ({
      kind: 'delete',
      from: 'user',
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: id } }],
    } as QueryDef);
    const cte: QueryDef = { kind: 'cte', ctes: [{ name: 't', query: del(5) }], final: del(6) } as QueryDef;
    // Both DELETE `user` (1 each) ⇒ merged to a single { user, 2 } entry.
    expect(fx.engine.affected(cte)).toEqual({ rows: 2, types: [{ type: 'user', rows: 2 }] });
  });
});
