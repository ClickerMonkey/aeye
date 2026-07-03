/**
 * Cost-accuracy — proves the cost model reflects how a SQL engine PROCESSES a
 * query: the MULTIPLICATIVE fan-out of joins, the PER-OUTER-ROW multiplication
 * of a select-position subquery / LATERAL, uncorrelated WHERE subqueries counted
 * ONCE, UNION summing its branches, GROUP BY / DISTINCT reducing OUTPUT (not
 * scan) rows, hidden backed joins counted once (shared) or per-outer-row
 * (LATERAL), and RLS work. See `SelectQuery.cost` / `_cost.ts` for the model.
 */
import { describe, it, expect } from 'vitest';
import { fixture, userTypeDef, orderTypeDef } from './_utils';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { SqlText } from '../sql/emit';
import type { QueryDef, SelectDef, TypeDef } from '../schema';
import type { TypeBacking } from '../backing';

/** A `count(*)` subquery over the whole `order` table (inner cost = 1 row, 48 B). */
const countOrders: QueryDef = {
  kind: 'select',
  fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} } }],
  from: { kind: 'type', type: 'order' },
};

describe('cost-accuracy: join fan-out MULTIPLIES and compounds', () => {
  // A three-Type has-many chain: author →(books, ×10)→ book →(pages, ×10)→ page.
  const author: TypeDef = { name: 'author', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 10, bytes: 20 };
  const book: TypeDef = {
    name: 'book',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'authorId', type: { kind: 'relation', to: 'author', count: 1, inverseRelation: 'books' } },
    ],
    count: 100,
    bytes: 30,
  };
  const page: TypeDef = {
    name: 'page',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'bookId', type: { kind: 'relation', to: 'book', count: 1, inverseRelation: 'pages' } },
    ],
    count: 1000,
    bytes: 10,
  };

  function chainEngine(): QueryEngine {
    const registry = createRegistry();
    registry.registerType(registry.parseType(author));
    registry.registerType(registry.parseType(book));
    registry.registerType(registry.parseType(page));
    registry.finalize();
    return new QueryEngine(registry);
  }

  it('one has-many join fans rows out by the relation count', () => {
    const engine = chainEngine();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'author', field: 'id' } }],
      from: { kind: 'type', type: 'author' },
      joins: [{ on: { source: 'author', field: 'books' } }],
    };
    expect(engine.cost(def).rows).toBe(10 * 10); // author(10) × books(10)
  });

  it('a chained second join COMPOUNDS the fan-out multiplicatively', () => {
    const engine = chainEngine();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'author', field: 'id' } }],
      from: { kind: 'type', type: 'author' },
      joins: [
        { on: { source: 'author', field: 'books' } },
        { on: { source: 'book', field: 'pages' } },
      ],
    };
    // 10 authors × 10 books/author × 10 pages/book = 1000.
    expect(engine.cost(def).rows).toBe(10 * 10 * 10);
  });
});

describe('cost-accuracy: per-outer-row SELECT subquery vs once-in-WHERE', () => {
  it('a SELECT-position subquery runs once per OUTPUT row (scales with M)', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'subquery', query: countOrders }, as: 'n' }],
      from: { kind: 'type', type: 'user' },
    };
    const c = fx.engine.cost(def);
    // base 1000 output rows (64 B each) + inner {1 row, 48 B} × 1000 outer rows.
    expect(c.rows).toBe(1000 + 1000 * 1);
    expect(c.bytes).toBe(1000 * 64 + 1000 * 48);
  });

  it('LIMIT caps how many times the SELECT subquery runs', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'subquery', query: countOrders }, as: 'n' }],
      from: { kind: 'type', type: 'user' },
      limit: 10,
    };
    const c = fx.engine.cost(def);
    // 10 returned rows (64 B) + inner {1 row, 48 B} × 10 = far below the unlimited estimate.
    expect(c.rows).toBe(10 + 10 * 1);
    expect(c.bytes).toBe(10 * 64 + 10 * 48);
  });

  it('an uncorrelated WHERE subquery (EXISTS) is counted ONCE', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'exists', query: countOrders }],
    };
    const c = fx.engine.cost(def);
    // 1000 base rows (EXISTS applies no row reduction) + inner {1 row} counted ONCE.
    expect(c.rows).toBe(1000 + 1);
  });

  it('the SAME subquery costs ×M in SELECT but ×1 in WHERE', () => {
    const fx = fixture();
    const inSelect: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'subquery', query: countOrders }, as: 'n' }],
      from: { kind: 'type', type: 'user' },
    };
    const inWhere: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'exists', query: countOrders }],
    };
    expect(fx.engine.cost(inSelect).rows).toBe(2000); // +1000
    expect(fx.engine.cost(inWhere).rows).toBe(1001); // +1
  });
});

describe('cost-accuracy: GROUP BY / DISTINCT reduce OUTPUT, UNION sums branches', () => {
  it('DISTINCT reduces OUTPUT rows to the estimated distinct projection', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      distinct: true,
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
    };
    const c = fx.engine.cost(def);
    // √1000 distinct-value heuristic for the un-indexed `name` key.
    expect(c.rows).toBe(Math.ceil(Math.sqrt(1000)));
    expect(c.rows).toBeLessThan(1000);
  });

  it('UNION touches the SUM of both branch costs', () => {
    const fx = fixture();
    const left: QueryDef = { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }], from: { kind: 'type', type: 'user' } };
    const right: QueryDef = { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }], from: { kind: 'type', type: 'order' } };
    const c = fx.engine.cost({ kind: 'union', left, right } as QueryDef);
    expect(c.rows).toBe(1000 + 5000);
  });

  it('bytes-touched = output rows × the per-row byte size', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
    };
    const c = fx.engine.cost(def);
    expect(c.bytes).toBe(c.rows * fx.user.bytes);
  });

  it('a HAVING predicate is folded into the cost without error', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'userId' } },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
      having: [{ kind: 'comparison', op: '>', left: { kind: 'aggregate', function: 'count', args: {} }, right: { kind: 'literal', value: 1 } }],
    };
    expect(fx.engine.cost(def).rows).toBeGreaterThan(0);
  });
});

// ─── Hidden backed joins / LATERAL / RLS ─────────────────────────────────────

/** An engine whose `user` / `order` carry dev-side backing (RLS + hidden joins). */
function backedEngine(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(userTypeDef));
  registry.registerType(registry.parseType(orderTypeDef));
  // Two extra bare types to exercise the no-op / no-access RLS branches.
  registry.registerType(registry.parseType({ name: 'alpha', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 10, bytes: 8 }));
  registry.registerType(registry.parseType({ name: 'beta', fields: [{ name: 'id', type: { kind: 'number', whole: true } }], count: 10, bytes: 8 }));
  registry.finalize();

  const userBacking: TypeBacking = {
    // RLS: a real predicate (an EXISTS subquery ⇒ non-zero cost, counted once).
    access: { expr: () => registry.parseExpr({ kind: 'exists', query: countOrders }) },
    joins: {
      // A LATERAL correlated subquery (runs per outer row).
      lat: { expr: () => ({ kind: 'lateral', query: () => countOrders, pick: 'count' }) },
      // A relation join (a single shared join, scanned once).
      rel: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'orders' }) },
      // A raw SQL join (opaque — contributes nothing to cost).
      raw: { sql: () => SqlText.raw('CROSS JOIN whatever') },
    },
    fields: {
      latA: { joins: ['lat'] },
      latB: { joins: ['lat'] }, // shares `lat` with latA ⇒ deduped
      relA: { joins: ['rel'] },
      rawField: { joins: ['raw'] }, // JoinBacking has no `expr` ⇒ skipped
      badJoin: { joins: ['missing'] }, // no such JoinBacking ⇒ skipped
    },
  };
  const backings: Record<string, TypeBacking> = {
    user: userBacking,
    order: { access: { expr: () => true } }, // static allow ⇒ no predicate cost
    alpha: { access: { expr: () => undefined } }, // no-op RLS
    beta: { joins: {} }, // backing present but NO access predicate
  };
  return new QueryEngine(registry, { backings });
}

describe('cost-accuracy: hidden backed joins, LATERAL, and RLS', () => {
  const selectFrom = (fields: SelectDef['fields'], type: string): SelectDef => ({
    kind: 'select',
    fields,
    from: { kind: 'type', type },
  });

  it('a LATERAL backing runs once PER OUTER ROW (×M) plus the RLS predicate once', () => {
    const engine = backedEngine();
    const c = engine.cost(selectFrom([{ expr: { kind: 'field-ref', source: 'user', field: 'latA' } }], 'user'));
    // base 1000 + RLS EXISTS {1 row} once + LATERAL {1 row} × 1000 outer rows.
    expect(c.rows).toBe(1000 + 1 + 1000);
  });

  it('a shared backed join is counted ONCE across the fields that reference it', () => {
    const engine = backedEngine();
    const one = engine.cost(selectFrom([{ expr: { kind: 'field-ref', source: 'user', field: 'latA' } }], 'user'));
    const two = engine.cost(
      selectFrom(
        [
          { expr: { kind: 'field-ref', source: 'user', field: 'latA' } },
          { expr: { kind: 'field-ref', source: 'user', field: 'latB' } },
        ],
        'user',
      ),
    );
    expect(two.rows).toBe(one.rows); // deduped: the shared `lat` join is not double-counted
  });

  it('a relation backing is a single shared join, scanned ONCE (not per outer row)', () => {
    const engine = backedEngine();
    const c = engine.cost(selectFrom([{ expr: { kind: 'field-ref', source: 'user', field: 'relA' } }], 'user'));
    // base 1000 + RLS {1} once + relation join scans the whole `order` (5000) once.
    expect(c.rows).toBe(1000 + 1 + 5000);
  });

  it('opaque raw / missing join backings and unbound refs contribute nothing', () => {
    const engine = backedEngine();
    const c = engine.cost(
      selectFrom(
        [
          { expr: { kind: 'field-ref', source: 'user', field: 'rawField' } },
          { expr: { kind: 'field-ref', source: 'user', field: 'badJoin' } },
          { expr: { kind: 'field-ref', source: 'ghost', field: 'x' } },
        ],
        'user',
      ),
    );
    // Only the RLS predicate ({1 row}) is added on top of the base scan.
    expect(c.rows).toBe(1000 + 1);
  });

  it('a static-allow / no-op / missing RLS predicate adds no cost', () => {
    const engine = backedEngine();
    expect(engine.cost(selectFrom([{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }], 'order')).rows).toBe(5000);
    expect(engine.cost(selectFrom([{ expr: { kind: 'field-ref', source: 'alpha', field: 'id' } }], 'alpha')).rows).toBe(10);
    expect(engine.cost(selectFrom([{ expr: { kind: 'field-ref', source: 'beta', field: 'id' } }], 'beta')).rows).toBe(10);
  });
});
