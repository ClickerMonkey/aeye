/**
 * A18 (second half) — `affected` descends into EVERY nesting position.
 *
 * `affected` is the estimate a caller gates a WRITE on, so a mutation it cannot
 * see is the worst kind of miss: the statement reports `{rows: 0, types: []}` and
 * the gate passes it. Before `0.6.5` it was implemented per kind, and the kinds
 * that had it were the ones someone remembered — a `cte` and the three DML
 * statements. Measured on `0.6.4`, a data-modifying `WITH` reported ZERO from a
 * FROM subquery, a set-operation arm, a WHERE `in` subquery, and an
 * `INSERT … SELECT` source.
 *
 * Postgres refuses a data-modifying `WITH` below the top level, so most of those
 * are not live against a database — but they ARE live against this package's own
 * in-memory runtime, which executes each nested statement for real. The first
 * test below deletes rows through a FROM subquery to show it, rather than
 * asserting the estimate against itself.
 *
 * The fix is structural rather than another case: each kind declares its NESTED
 * STATEMENTS once (`forEachNestedQuery`) — expr-carried ones for free, via
 * `Expr.nestedQueryDef` — and `affected` is the sum over that enumeration plus
 * the statement's own target. A position that is added later gets counted by
 * declaring itself, not by remembering to update this estimate.
 */
import { describe, it, expect } from 'vitest';
import { runtimeFixture, ref, lit } from './_utils';
import { RuntimeContext } from '../runtime/context';
import type { QueryDef, SelectDef } from '../schema';

/** `DELETE FROM order WHERE total < 60 RETURNING id` — two of the four seeded orders. */
const deleteCheapOrders: QueryDef = {
  kind: 'delete',
  from: 'order',
  where: [{ kind: 'comparison', op: '<', left: ref('order', 'total'), right: lit(60) }],
  returning: [{ expr: ref('order', 'id'), as: 'id' }],
};

/** A `WITH` whose entry deletes and whose final reads the deleted ids. */
const mutatingWith: QueryDef = {
  kind: 'cte',
  ctes: [{ name: 'gone', query: deleteCheapOrders }],
  final: {
    kind: 'select',
    fields: [{ expr: ref('gone', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'gone' },
  },
};

/**
 * The rows `deleteCheapOrders` is ESTIMATED to remove: the fixture declares
 * `order.count = 5000`, and a non-indexed range predicate keeps
 * `RANGE_SELECTIVITY` (0.5) of them. An estimate, like every number `affected`
 * reports — the seeded runtime data below is four rows, of which two match.
 */
const ESTIMATED_ORDERS = 2500;
/** The orders the seeded runtime data actually loses (`total` 50 and 25). */
const RUNTIME_DELETED = 2;

describe('affected — every position that can hold a mutation is counted', () => {
  it('a FROM subquery: the runtime really deletes, so a zero here is a passed gate', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('x', 'id'), as: 'id' }],
      from: { kind: 'subquery', as: 'x', query: mutatingWith },
    };

    // The estimate sees it (it reported `{rows: 0, types: []}` on 0.6.4).
    expect(fx.engine.affected(def)).toEqual({ rows: ESTIMATED_ORDERS, types: [{ type: 'order', rows: ESTIMATED_ORDERS }] });

    // And it is not hypothetical: running it removes those rows. (Postgres would
    // refuse a data-modifying `WITH` at this depth; this runtime executes it.)
    const ctx = new RuntimeContext(fx.engine);
    const before = await fx.engine.parseQuery({ kind: 'select', fields: [{ expr: ref('order', 'id'), as: 'id' }], from: { kind: 'type', type: 'order' } } as QueryDef).execute(ctx);
    await fx.engine.parseQuery(def).execute(ctx);
    const after = await fx.engine.parseQuery({ kind: 'select', fields: [{ expr: ref('order', 'id'), as: 'id' }], from: { kind: 'type', type: 'order' } } as QueryDef).execute(ctx);
    expect(before.rows.length - after.rows.length).toBe(RUNTIME_DELETED);
  });

  it('a JOINED subquery source', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'subquery', as: 'x', query: mutatingWith }, and: lit(true), joinType: 'inner' }],
    };
    expect(fx.engine.affected(def).rows).toBe(ESTIMATED_ORDERS);
  });

  it('a WHERE `in` subquery, and an `exists` subquery', () => {
    const fx = runtimeFixture();
    const inForm: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'in', value: ref('user', 'id'), in: mutatingWith }],
    };
    expect(fx.engine.affected(inForm).rows).toBe(ESTIMATED_ORDERS);

    const existsForm: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'exists', query: mutatingWith }],
    };
    expect(fx.engine.affected(existsForm).rows).toBe(ESTIMATED_ORDERS);
  });

  it('a SET-OPERATION arm', () => {
    const fx = runtimeFixture();
    const def: QueryDef = {
      kind: 'union',
      left: { kind: 'select', fields: [{ expr: ref('user', 'id'), as: 'id' }], from: { kind: 'type', type: 'user' } },
      right: mutatingWith,
    };
    expect(fx.engine.affected(def).rows).toBe(ESTIMATED_ORDERS);
  });

  it('an `INSERT … SELECT` whose SOURCE mutates — both writes, summed per Type', () => {
    const fx = runtimeFixture();
    const def: QueryDef = {
      kind: 'insert',
      into: 'user',
      select: mutatingWith,
    };
    // The insert adds one row per source row, and the source itself deletes that
    // many orders. Two Types, two entries, the insert's own target first.
    expect(fx.engine.affected(def)).toEqual({
      rows: ESTIMATED_ORDERS * 2,
      types: [{ type: 'user', rows: ESTIMATED_ORDERS }, { type: 'order', rows: ESTIMATED_ORDERS }],
    });
  });

  it("a DELETE's own WHERE subquery adds to its own count, on the same Type", () => {
    const fx = runtimeFixture();
    const def: QueryDef = {
      kind: 'delete',
      from: 'user',
      where: [{ kind: 'in', value: ref('user', 'id'), in: mutatingWith }],
    };
    // `user.count` 1000 × IN_SELECTIVITY (0.5) = 500 users matched by the
    // predicate, plus the orders the subquery deletes while evaluating it.
    const affected = fx.engine.affected(def);
    expect(affected.types).toEqual([{ type: 'user', rows: 500 }, { type: 'order', rows: ESTIMATED_ORDERS }]);
    expect(affected.rows).toBe(500 + ESTIMATED_ORDERS);
  });

  it('a read-only statement in any of those positions still affects NOTHING', () => {
    // The enumeration must not turn every nested SELECT into a phantom write.
    const fx = runtimeFixture();
    const readOnly: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('order', 'id'), as: 'id' }],
      from: { kind: 'type', type: 'order' },
    };
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: ref('x', 'id'), as: 'id' }],
      from: { kind: 'subquery', as: 'x', query: readOnly },
      where: [{ kind: 'in', value: ref('x', 'id'), in: readOnly }],
    };
    expect(fx.engine.affected(def)).toEqual({ rows: 0, types: [] });
  });
});
