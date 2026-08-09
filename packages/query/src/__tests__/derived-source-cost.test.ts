/**
 * A18 — a DERIVED SOURCE carries its body's estimated size, so a statement that
 * reads one is no longer structurally free.
 *
 * Every derived source — a CTE name, a FROM subquery, a manually-joined subquery
 * — binds a SYNTHETIC Type, and `syntheticType` built it `count: 0, bytes: 0`.
 * The cost model reads `Type.count` for a base scan and for a join's fan-out, so
 * anything reading a derived source estimated at ZERO. That is not a loose
 * estimate, it is a hard number nobody supplied: everywhere else the caveat is
 * "the input is a `TypeDef.count` the author declared"; here there was no input
 * at all, and `checkCost` could not fire on a `WITH` however much it read.
 *
 * The reported shape (measured on 0.6.4, at `checkCost({ maxRows: 1000 })`):
 *
 *   WITH touched AS (DELETE FROM tiny RETURNING id)      -- tiny = 10 rows
 *   SELECT touched.id FROM touched INNER JOIN task ON true -- task = 1_000_000
 *
 *     cost()      {rows: 0}      PASS   <- no cost budget could fire
 *     affected()  {rows: 10}     honest, and the write really is ten rows
 *     delivers    10_000_000 rows into the caller
 *
 * `affected` was right, `cost` was the gap, and it is the one shape pagination
 * deliberately declines to cap (a LIMIT would truncate the receipt while the
 * database ran the write to completion). The same hole is reachable with NO
 * `WITH` at all, through a plain derived table — asserted below.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { QueryDef, SelectDef, TypeDef } from '../schema';

/** Ten rows. The little table a mutating `WITH` writes. */
const tiny: TypeDef = {
  name: 'tiny',
  fields: [{ name: 'id', type: { kind: 'number', whole: true } }],
  count: 10,
  bytes: 8,
};

/** A million rows. The table a join fans out across. */
const task: TypeDef = {
  name: 'task',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'hours', type: { kind: 'number' } },
  ],
  count: 1_000_000,
  bytes: 32,
};

function engineOf(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(tiny));
  registry.registerType(registry.parseType(task));
  registry.finalize();
  return new QueryEngine(registry);
}

/** `SELECT <source>.id FROM <source>` — reads a bound source by name. */
const readIds = (source: string): SelectDef => ({
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source, field: 'id' } }],
  from: { kind: 'type', type: source },
});

/** Every task id (a million rows). */
const allTasks: SelectDef = readIds('task');

/** `DELETE FROM tiny RETURNING id` — ten rows written, ten delivered. */
const deleteTiny: QueryDef = {
  kind: 'delete',
  from: 'tiny',
  returning: [{ expr: { kind: 'field-ref', source: 'tiny', field: 'id' } }],
};

describe('A18 — a CTE name costs what its body reads', () => {
  it('the reported shape: a ten-row write cross-joined to a million now COSTS ten million', () => {
    const engine = engineOf();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [{ name: 'touched', query: deleteTiny }],
      final: {
        ...readIds('touched'),
        joins: [{ on: { kind: 'type', type: 'task' }, and: { kind: 'literal', value: true }, joinType: 'inner' }],
      },
    };
    // 10 CTE rows × 1_000_000 joined rows — what the statement DELIVERS.
    expect(engine.outputCost(def).rows).toBe(10_000_000);
    // …so the budget that already existed now refuses it. This is the whole ask:
    // no new gate, no consumer-side re-derivation of the cost model.
    expect(engine.checkCost(def, { maxRows: 1000 }).list.map((p) => p.code)).toEqual(['cost.rows-exceeded']);
    // `affected` is unchanged and still answers about the WRITE, not the read.
    expect(engine.affected(def)).toEqual({ rows: 10, types: [{ type: 'tiny', rows: 10 }] });
  });

  it('a plain read-only `WITH` costs its body PLUS its final — an entry is not free', () => {
    const engine = engineOf();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [{ name: 'rows', query: allTasks }],
      final: readIds('rows'),
    };
    // The body materializes a million rows (this runtime literally holds them in
    // memory) and the final reads a million: the WORK is both.
    expect(engine.cost(def).rows).toBe(2_000_000);
    // The RESULT is still just what the caller receives.
    expect(engine.outputCost(def).rows).toBe(1_000_000);
  });

  it("an entry's work counts even when `final` COLLAPSES it away", () => {
    const engine = engineOf();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [{ name: 'rows', query: allTasks }],
      final: {
        kind: 'select',
        fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' }],
        from: { kind: 'type', type: 'rows' },
      },
    };
    // One output row, a million rows read to produce it. Reporting `1` would say
    // this statement is as cheap as `SELECT 1`.
    expect(engine.outputCost(def).rows).toBe(1);
    expect(engine.cost(def).rows).toBeGreaterThan(1_000_000);
  });

  it('a LIMIT on the body caps what the name binds (the entry materializes only that)', () => {
    const engine = engineOf();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [{ name: 'rows', query: { ...allTasks, limit: 3 } }],
      final: {
        ...readIds('rows'),
        joins: [{ on: { kind: 'type', type: 'task' }, and: { kind: 'literal', value: true }, joinType: 'inner' }],
      },
    };
    // 3 × 1_000_000 — the bound Type carries THREE rows, not a million and not zero.
    expect(engine.outputCost(def).rows).toBe(3_000_000);
  });

  it('a later entry reads an earlier one at its real size', () => {
    const engine = engineOf();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [
        { name: 'first', query: { ...allTasks, limit: 7 } },
        { name: 'second', query: readIds('first') },
      ],
      final: readIds('second'),
    };
    // Entries bind in order, so `second` sees `first` at 7 rows — not at zero.
    expect(engine.outputCost(def).rows).toBe(7);
  });

  it('a RECURSIVE entry is the seed plus a bounded number of expansions, never zero', () => {
    const engine = engineOf();
    const def: QueryDef = {
      kind: 'cte',
      ctes: [
        {
          name: 'walk',
          base: { ...allTasks, limit: 5 },
          recursive: readIds('walk'),
        },
      ],
      final: readIds('walk'),
    };
    // The fixpoint depth is data-dependent and not statically knowable, so the
    // model assumes RECURSIVE_CTE_LEVELS expansions of the arm over the seed. The
    // assertion that matters is the SHAPE: strictly more than the seed, and
    // bounded — not the old hard zero.
    const rows = engine.outputCost(def).rows;
    expect(rows).toBeGreaterThan(5);
    expect(rows).toBe(5 + 5 * 4);
  });
});

describe('A18 — a derived TABLE has the same hole, with no `WITH` involved', () => {
  it('`SELECT … FROM (SELECT … FROM task) x` costs a million, not zero', () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'x', field: 'id' } }],
      from: { kind: 'subquery', as: 'x', query: allTasks },
    };
    expect(engine.cost(def).rows).toBe(1_000_000);
    expect(engine.checkCost(def, { maxRows: 1000 }).list.map((p) => p.code)).toEqual(['cost.rows-exceeded']);
  });

  it('a JOIN over a derived source fans out by its real cardinality, not by 1', () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'tiny', field: 'id' } }],
      from: { kind: 'type', type: 'tiny' },
      joins: [{
        on: { kind: 'subquery', as: 'x', query: allTasks },
        and: { kind: 'literal', value: true },
        joinType: 'inner',
      }],
    };
    // 10 × 1_000_000. A zero-count join source reported `Math.max(1, 0)` = 1, so
    // this whole statement used to estimate at the ten rows of `tiny`.
    expect(engine.cost(def).rows).toBe(10_000_000);
  });

  it('the estimate survives NESTING, and resolving it stays linear in depth', () => {
    const engine = engineOf();
    let def: QueryDef = allTasks;
    for (let i = 0; i < 200; i++) {
      def = {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: `x${i}`, field: 'id' } }],
        from: { kind: 'subquery', as: `x${i}`, query: def },
      };
    }
    // Two hundred derived tables deep still reports the base table's rows. The
    // real assertion is that this RETURNS: sizing a derived source made binding
    // non-trivial, and each level binds its inner statement twice (once for its
    // FIELDS, once for its SIZE), so an unmemoized binding is exponential —
    // measured at 40s for twenty levels before `ScopeMemo`.
    const started = Date.now();
    expect(engine.cost(def).rows).toBe(1_000_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
