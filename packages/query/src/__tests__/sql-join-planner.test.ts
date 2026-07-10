/**
 * THE headline test: the shared hidden-join planner (post-`relation-path`).
 *  - two computed fields over the SAME relation join alias ⇒ EXACTLY ONE join,
 *    one alias (the authored `as` dedups);
 *  - a fan-out relation feeding an aggregate is now a plain relation JOIN the
 *    aggregate runs over — no hidden pre-aggregation CTE (and two aggregates
 *    sharing one join alias reuse the single join);
 *  - a multi-hop relation crossing chains the right joins.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { fixture } from './_utils';
import type { SelectDef, TypeDef } from '../schema';

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('SQL — join/CTE planner', () => {
  it('dedups two fields over the SAME relation join alias into ONE join + alias', () => {
    const fx = fixture();
    // order.userId is a one-to-one relation → a plain LEFT JOIN, authored once
    // under `order_userId` and reused by both computed fields.
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order_userId', field: 'name' }, as: 'cust' },
        { expr: { kind: 'field-ref', source: 'order_userId', field: 'email' }, as: 'mail' },
      ],
      from: { kind: 'type', type: 'order' },
      joins: [{ on: { kind: 'relation', source: 'order', field: 'userId', as: 'order_userId' } }],
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    // exactly one join, one alias bound once (in the JOIN's AS).
    expect(count(sql, 'LEFT JOIN')).toBe(1);
    expect(count(sql, 'AS "order_userId"')).toBe(1);
    // both fields reference the shared alias.
    expect(sql).toContain('"order_userId"."name" AS "cust"');
    expect(sql).toContain('"order_userId"."email" AS "mail"');
    expect(sql).not.toContain('WITH ');
  });

  it('fan-out relation feeding an aggregate ⇒ a plain relation JOIN (no CTE)', () => {
    const fx = fixture();
    // user.orders is a fan-out (count 12) relation. The aggregate now runs over
    // the joined rows directly — no hidden `WITH agg_… GROUP BY` pre-aggregation.
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'orders', field: 'total' } } }, as: 'spent' },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'orders' } }],
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql).not.toContain('WITH ');
    expect(sql).not.toContain('agg_sum');
    // a single LEFT JOIN over the relation; the aggregate reads the joined alias.
    expect(count(sql, 'LEFT JOIN')).toBe(1);
    expect(sql).toContain('LEFT JOIN "order" AS "orders" ON "user"."id" = "orders"."userId"');
    expect(sql).toContain('sum("orders"."total") AS "spent"');
  });

  it('two aggregates sharing one relation join alias reuse the single join', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'orders', field: 'total' } } }, as: 'a' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'orders', field: 'total' } } }, as: 'b' },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'orders' } }],
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    // exactly one join backs both aggregates; both are emitted over it.
    expect(count(sql, 'LEFT JOIN "order" AS "orders"')).toBe(1);
    expect(count(sql, 'sum("orders"."total")')).toBe(2);
  });

  it('different aggregates over the same relation share ONE join', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'field-ref', source: 'orders', field: 'total' } } }, as: 'spent' },
        { expr: { kind: 'aggregate', function: 'count', args: { value: { kind: 'field-ref', source: 'orders', field: 'id' } } }, as: 'cnt' },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { kind: 'relation', source: 'user', field: 'orders', as: 'orders' } }],
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(count(sql, 'LEFT JOIN "order" AS "orders"')).toBe(1);
    expect(sql).toContain('sum("orders"."total") AS "spent"');
    expect(sql).toContain('count("orders"."id") AS "cnt"');
  });

  it('multi-hop relation crossing chains the right joins', () => {
    const registry = createRegistry();
    const country: TypeDef = { name: 'country', fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'name', type: { kind: 'text' } }], count: 200, bytes: 32 };
    const city: TypeDef = {
      name: 'city',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'name', type: { kind: 'text' } },
        { name: 'country', type: { kind: 'relation', to: 'country', count: 1 } },
      ],
      count: 5000,
      bytes: 32,
    };
    const person: TypeDef = {
      name: 'person',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'name', type: { kind: 'text' } },
        { name: 'city', type: { kind: 'relation', to: 'city', count: 1 } },
      ],
      count: 100000,
      bytes: 32,
    };
    for (const t of [country, city, person]) registry.registerType(registry.parseType(t));
    const engine = new QueryEngine(registry);

    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'person_city_country', field: 'name' }, as: 'country' }],
      from: { kind: 'type', type: 'person' },
      joins: [
        { on: { kind: 'relation', source: 'person', field: 'city', as: 'person_city' } },
        { on: { kind: 'relation', source: 'person_city', field: 'country', as: 'person_city_country' } },
      ],
    };
    const { sql } = engine.toSQL(def, 'base');
    // two chained joins: person → city, then city → country.
    expect(count(sql, 'LEFT JOIN')).toBe(2);
    expect(sql).toContain('LEFT JOIN "city" AS "person_city" ON "person"."city" = "person_city"."id"');
    expect(sql).toContain('LEFT JOIN "country" AS "person_city_country" ON "person_city"."country" = "person_city_country"."id"');
    expect(sql).toContain('"person_city_country"."name" AS "country"');
  });
});
