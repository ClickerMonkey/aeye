/**
 * THE headline test: the shared hidden-join / CTE planner.
 *  - two relation-path values over the SAME relation ⇒ EXACTLY ONE join, one
 *    alias (dedup);
 *  - a fan-out relation feeding an aggregate ⇒ a `WITH agg_… GROUP BY` CTE
 *    (and identical aggregates dedup to one CTE);
 *  - a multi-hop relation path chains the right joins.
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
  it('dedups two relation-paths over the SAME relation into ONE join + alias', () => {
    const fx = fixture();
    // order.userId is a one-to-one relation → a plain LEFT JOIN.
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'relation-path', source: 'order', path: ['userId', 'name'] }, as: 'cust' },
        { expr: { kind: 'relation-path', source: 'order', path: ['userId', 'email'] }, as: 'mail' },
      ],
      from: { kind: 'type', type: 'order' },
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

  it('fan-out relation feeding an aggregate ⇒ a grouped CTE', () => {
    const fx = fixture();
    // user.orders is a fan-out (count 12) relation.
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'relation-path', source: 'user', path: ['orders', 'total'] } } }, as: 'spent' },
      ],
      from: { kind: 'type', type: 'user' },
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql.startsWith('WITH ')).toBe(true);
    expect(sql).toContain('"agg_sum_user_orders" AS (SELECT "t"."userId" AS "k", sum("t"."total") AS "v" FROM "order" AS "t" GROUP BY "t"."userId")');
    // attached by a LEFT JOIN on the grouped key.
    expect(sql).toContain('LEFT JOIN "agg_sum_user_orders" ON "user"."id" = "agg_sum_user_orders"."k"');
    expect(sql).toContain('"agg_sum_user_orders"."v" AS "spent"');
  });

  it('dedups two identical fan-out aggregates into ONE CTE', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'relation-path', source: 'user', path: ['orders', 'total'] } } }, as: 'a' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'relation-path', source: 'user', path: ['orders', 'total'] } } }, as: 'b' },
      ],
      from: { kind: 'type', type: 'user' },
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(count(sql, 'agg_sum_user_orders" AS (')).toBe(1);
    expect(count(sql, 'LEFT JOIN "agg_sum_user_orders"')).toBe(1);
  });

  it('different aggregates over the same relation ⇒ separate CTEs', () => {
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'relation-path', source: 'user', path: ['orders', 'total'] } } }, as: 'spent' },
        { expr: { kind: 'aggregate', function: 'count', args: { value: { kind: 'relation-path', source: 'user', path: ['orders'] } } }, as: 'cnt' },
      ],
      from: { kind: 'type', type: 'user' },
    };
    const { sql } = fx.engine.toSQL(def, 'base');
    expect(sql).toContain('"agg_sum_user_orders" AS (');
    expect(sql).toContain('"agg_count_user_orders" AS (SELECT "t"."userId" AS "k", count(*) AS "v"');
    // count over an absent group coalesces to 0.
    expect(sql).toContain('COALESCE("agg_count_user_orders"."v", 0) AS "cnt"');
  });

  it('multi-hop relation path chains the right joins', () => {
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
      fields: [{ expr: { kind: 'relation-path', source: 'person', path: ['city', 'country', 'name'] }, as: 'country' }],
      from: { kind: 'type', type: 'person' },
    };
    const { sql } = engine.toSQL(def, 'base');
    // two chained joins: person → city, then city → country.
    expect(count(sql, 'LEFT JOIN')).toBe(2);
    expect(sql).toContain('LEFT JOIN "city" AS "person_city" ON "person"."city" = "person_city"."id"');
    expect(sql).toContain('LEFT JOIN "country" AS "person_city_country" ON "person_city"."country" = "person_city_country"."id"');
    expect(sql).toContain('"person_city_country"."name" AS "country"');
  });
});
