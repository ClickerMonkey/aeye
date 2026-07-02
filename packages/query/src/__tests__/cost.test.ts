/**
 * Phase 4 — bottom-up cost estimation + opt-in cost-constraint enforcement.
 */
import { describe, it, expect } from 'vitest';
import { fixture } from './_utils';
import type { QueryDef } from '../schema';

describe('cost: index & selectivity', () => {
  const fx = fixture();

  it('a unique-index equality collapses to a single row', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' } }],
      from: { kind: 'type', type: 'user' },
      // user has a UNIQUE index on user.id (count === 1).
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'user', field: 'id' }, right: { kind: 'literal', value: 5 } }],
    };
    const cost = fx.engine.cost(def);
    expect(cost.rows).toBe(1);
    expect(cost.bytes).toBe(1 * fx.user.bytes);
  });

  it('a non-indexed range predicate applies range selectivity', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
      from: { kind: 'type', type: 'order' },
      where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 100 } }],
    };
    const cost = fx.engine.cost(def);
    // 5000 rows × 0.5 range selectivity (no matching index on `total`).
    expect(cost.rows).toBe(2500);
    expect(cost.bytes).toBe(2500 * fx.order.bytes);
  });
});

describe('cost: relation join fan-out', () => {
  it('a one-to-many join multiplies rows by the relation count', () => {
    const fx = fixture();
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { source: 'user', field: 'orders' } }], // materialized has-many; count = round(5000/1000) = 5
    };
    const cost = fx.engine.cost(def);
    expect(cost.rows).toBe(fx.user.count * 5); // 1000 × 5
  });
});

describe('cost: GROUP BY reduction', () => {
  it('collapses to a √rows distinct estimate when the key is unindexed', () => {
    const fx = fixture();
    const def: QueryDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'userId' } },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'order' },
      groupBy: [{ kind: 'field-ref', source: 'order', field: 'userId' }],
    };
    const cost = fx.engine.cost(def);
    expect(cost.rows).toBe(Math.ceil(Math.sqrt(fx.order.count))); // ceil(√5000) = 71
    expect(cost.rows).toBeLessThan(fx.order.count);
  });
});

describe('cost: constraint enforcement', () => {
  const fx = fixture();
  const rangeQuery: QueryDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' } }],
    from: { kind: 'type', type: 'order' },
    where: [{ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: 'order', field: 'total' }, right: { kind: 'literal', value: 100 } }],
  };

  it('reports cost.rows-exceeded with the estimate and the cap', () => {
    const p = fx.engine.validateQuery(rangeQuery, undefined, { maxRows: 100 });
    const prob = p.list.find((x) => x.code === 'cost.rows-exceeded');
    expect(prob).toBeDefined();
    expect(prob?.message).toContain('2500'); // estimate
    expect(prob?.message).toContain('100'); // cap
  });

  it('reports cost.bytes-exceeded with the estimate and the cap', () => {
    const p = fx.engine.validateQuery(rangeQuery, undefined, { maxBytes: 50000 });
    const prob = p.list.find((x) => x.code === 'cost.bytes-exceeded');
    expect(prob).toBeDefined();
    expect(prob?.message).toContain('120000'); // 2500 × 48 bytes
    expect(prob?.message).toContain('50000'); // cap
  });

  it('checkCost is a standalone opt-in entry point', () => {
    const within = fx.engine.checkCost(rangeQuery, { maxRows: 10000 });
    expect(within.list).toHaveLength(0);
    const over = fx.engine.checkCost(rangeQuery, { maxRows: 100 });
    expect(over.list.some((x) => x.code === 'cost.rows-exceeded')).toBe(true);
  });

  it('no constraints ⇒ no cost problems during validation', () => {
    const p = fx.engine.validateQuery(rangeQuery);
    expect(p.list.some((x) => x.code.startsWith('cost.'))).toBe(false);
  });
});
