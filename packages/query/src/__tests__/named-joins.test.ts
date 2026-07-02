/**
 * Phase H2 — named hidden joins, shared + added once-if-referenced, including
 * LATERAL / CROSS APPLY.
 *
 * A `TypeBacking.joins[name]` is a `JoinBacking`; a field opts in via
 * `FieldBacking.joins`. When (and only when) a referencing field is emitted,
 * each named join is registered ONCE with the planner (deduped on its
 * deterministic `joinAlias(source, name)`), so many fields sharing a join
 * collapse to one. A relation join reuses the planner's shared `requireJoin`;
 * a lateral join attaches a correlated subquery per outer row.
 *
 * Local `account` / `org` / `order` fixtures keep this isolated from the shared
 * `user` / `order` types in `_utils`.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { joinAlias } from '../backing';
import type { Registry } from '../registry';
import type { TypeBacking } from '../backing';
import type { TypeDef, SelectDef } from '../schema';
import type { SourceRecord } from '../runtime/row';
import { ref, lit, cmp } from './_utils';

/** Conceptual `org` Type (the relation target of `account.org`). */
const orgDef: TypeDef = {
  name: 'org',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'tier', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'org', field: 'id' }, count: 1 }] }],
  count: 10,
  bytes: 32,
};

/** Conceptual `order` Type (the lateral source). */
const orderDef: TypeDef = {
  name: 'order',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'accountId', type: { kind: 'number', whole: true } },
    { name: 'total', type: { kind: 'money', currency: 'USD' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 32,
};

/** Conceptual `account` Type — stored + named-join-backed (relation + lateral) fields. */
const accountDef: TypeDef = {
  name: 'account',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'owner', type: { kind: 'number', whole: true } },
    { name: 'balance', type: { kind: 'money', currency: 'USD' }, nullable: true },
    // Belongs-to org (count 1): the local `org` field holds the org id.
    { name: 'org', type: { kind: 'relation', to: 'org', count: 1 } },
    // Named-relation-join-backed reads of the joined org.
    { name: 'orgName', type: { kind: 'text' }, nullable: true },
    { name: 'orgTier', type: { kind: 'text' }, nullable: true },
    { name: 'orgIdRef', type: { kind: 'number' }, nullable: true },
    // Lateral-backed: the account's single largest order total.
    { name: 'topOrderTotal', type: { kind: 'number' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'account', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 64,
};

const orgRows: SourceRecord[] = [
  { id: 1, name: 'Acme', tier: 'gold' },
  { id: 2, name: 'Beta', tier: 'silver' },
];
const accountRows: SourceRecord[] = [
  { id: 1, owner: 1, balance: 100, org: 1 },
  { id: 2, owner: 2, balance: 50, org: 2 },
];
const orderRows: SourceRecord[] = [
  { id: 10, accountId: 1, total: 30 },
  { id: 11, accountId: 1, total: 70 },
  { id: 12, accountId: 2, total: 200 },
];

/** Build a registry + engine over account/org/order with the given backing on `account`. */
function fixture(makeBacking: (r: Registry) => TypeBacking) {
  const registry = createRegistry();
  const account = registry.parseType(accountDef);
  registry.registerType(registry.parseType(orgDef));
  registry.registerType(registry.parseType(orderDef));
  registry.registerType(account, makeBacking(registry));
  registry.finalize();
  const engine = new QueryEngine(registry, {
    executors: {
      account: arrayExecutor(accountRows),
      org: arrayExecutor(orgRows),
      order: arrayExecutor(orderRows),
    },
  });
  return { registry, engine };
}

/** SELECT <fields...> FROM account. */
function select(...fields: string[]): SelectDef {
  return {
    kind: 'select',
    fields: fields.map((f) => ({ expr: { kind: 'field-ref', source: 'account', field: f }, as: f })),
    from: { kind: 'type', type: 'account' },
  };
}

/** A named RELATION join `org` + three fields reading the joined org through it. */
const relationBacking = (r: Registry): TypeBacking => ({
  joins: {
    org: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'org' }) },
  },
  fields: {
    orgName: { joins: ['org'], compute: { expr: () => r.parseExpr(ref(joinAlias('account', 'org'), 'name')) } },
    orgTier: { joins: ['org'], compute: { expr: () => r.parseExpr(ref(joinAlias('account', 'org'), 'tier')) } },
    orgIdRef: { joins: ['org'], compute: { expr: () => r.parseExpr(ref(joinAlias('account', 'org'), 'id')) } },
  },
});

/** A named LATERAL join `topOrder` (correlated to account.id), `pick`ing `total`. */
const lateralBacking = (): TypeBacking => ({
  joins: {
    topOrder: {
      expr: () => ({
        kind: 'lateral',
        pick: 'total',
        joinType: 'left',
        query: (outer) => ({
          kind: 'select',
          fields: [{ expr: ref('order', 'total'), as: 'total' }],
          from: { kind: 'type', type: 'order' },
          where: [cmp('=', ref('order', 'accountId'), ref(outer, 'id'))],
          order: [{ expr: ref('order', 'total'), dir: 'desc' }],
          limit: 1,
        }),
      }),
    },
  },
  // `topOrderTotal` has no `compute` ⇒ its value defaults to the lateral pick.
  fields: { topOrderTotal: { joins: ['topOrder'] } },
});

describe('named joins: once-if-referenced + dedup', () => {
  it('a single named join referenced by THREE fields emits exactly ONE join', () => {
    const fx = fixture(relationBacking);
    const { sql } = fx.engine.toSQL(select('orgName', 'orgTier', 'orgIdRef'), 'base');
    // The relation join is materialized once, aliased to `account__org`.
    const joins = sql.match(/AS "account__org"/g) ?? [];
    expect(joins.length).toBe(1);
    expect(sql).toContain('LEFT JOIN "org" AS "account__org"');
    // All three fields read columns off that single alias.
    expect(sql).toContain('"account__org"."name"');
    expect(sql).toContain('"account__org"."tier"');
  });

  it('a field with NO `joins` is unaffected (no extra join)', () => {
    const fx = fixture(relationBacking);
    const { sql } = fx.engine.toSQL(select('owner'), 'base');
    expect(sql).not.toContain('account__org');
    expect(sql).toContain('"account"."owner" AS "owner"');
  });

  it('the named relation join resolves the joined value at runtime', async () => {
    const fx = fixture(relationBacking);
    const result = await fx.engine.run(select('id', 'orgName', 'orgTier'));
    expect(result.rows).toEqual([
      { id: 1, orgName: 'Acme', orgTier: 'gold' },
      { id: 2, orgName: 'Beta', orgTier: 'silver' },
    ]);
  });
});

describe('named joins: LATERAL / CROSS APPLY', () => {
  it('emits `LEFT JOIN LATERAL (…) ON true` in postgres', () => {
    const fx = fixture(lateralBacking);
    const { sql } = fx.engine.toSQL(select('id', 'topOrderTotal'), 'postgres');
    expect(sql).toContain('LEFT JOIN LATERAL (');
    expect(sql).toContain(') AS "account__topOrder" ON true');
    // The field reads the picked column off the lateral alias.
    expect(sql).toContain('"account__topOrder"."total"');
    // The subquery is correlated to the outer account row.
    expect(sql).toContain('"order"."accountId" = "account"."id"');
  });

  it('emits the portable base form `LEFT JOIN LATERAL (…) ON 1 = 1`', () => {
    const fx = fixture(lateralBacking);
    const { sql } = fx.engine.toSQL(select('id', 'topOrderTotal'), 'base');
    expect(sql).toContain('LEFT JOIN LATERAL (');
    expect(sql).toContain(') AS "account__topOrder" ON 1 = 1');
  });

  it('runs in-memory, returning the correct per-row lateral value', async () => {
    const fx = fixture(lateralBacking);
    const result = await fx.engine.run(select('id', 'topOrderTotal'));
    // account 1's largest order is 70; account 2's is 200.
    expect(result.rows).toEqual([
      { id: 1, topOrderTotal: 70 },
      { id: 2, topOrderTotal: 200 },
    ]);
  });
});

describe('named joins: shared between a compute field and an FLS access predicate', () => {
  /** `org` join shared by a compute field (`orgName`) AND a field's FLS access. */
  const sharedBacking = (r: Registry): TypeBacking => ({
    joins: {
      org: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'org' }) },
    },
    fields: {
      orgName: { joins: ['org'], compute: { expr: () => r.parseExpr(ref(joinAlias('account', 'org'), 'name')) } },
      // `balance` is visible only for `gold`-tier orgs — the gate reads the
      // SAME named join the compute field uses.
      balance: {
        joins: ['org'],
        access: { expr: () => r.parseExpr(cmp('=', ref(joinAlias('account', 'org'), 'tier'), lit('gold'))) },
      },
    },
  });

  it('dedups to ONE join across the compute field and the access gate', () => {
    const fx = fixture(sharedBacking);
    const { sql } = fx.engine.toSQL(select('orgName', 'balance'), 'base');
    const joins = sql.match(/AS "account__org"/g) ?? [];
    expect(joins.length).toBe(1);
    // The FLS gate emits a CASE reading the shared join's `tier` column.
    expect(sql).toContain('CASE WHEN');
    expect(sql).toContain('"account__org"."tier"');
  });

  it('resolves the compute AND applies the gate at runtime', async () => {
    const fx = fixture(sharedBacking);
    const result = await fx.engine.run(select('id', 'orgName', 'balance'));
    // account 1 (gold) sees its balance; account 2 (silver) is gated to NULL.
    expect(result.rows).toEqual([
      { id: 1, orgName: 'Acme', balance: 100 },
      { id: 2, orgName: 'Beta', balance: null },
    ]);
  });
});
