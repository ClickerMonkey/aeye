/**
 * The join model (post-`relation-path`): crossing a relation is done ONLY via
 * an explicit join in `joins[]`.
 *
 *  - A `relation` join reproduces the old belongs-to traversal EXACTLY (same
 *    synthesized FK key, LEFT by default, nullable-widened), read with a plain
 *    `{source, field}` field-ref into the REQUIRED `as` alias.
 *  - A `field-ref` to a RELATION field is a `ref.relation` validation error.
 *  - A MANUAL source-def join adds a source with `and` as its ON condition.
 */
import { describe, it, expect } from 'vitest';
import { e } from '../builder';
import { runtimeFixture, fixture } from './_utils';
import { QueryJoin } from '../queries/join';
import { Problems } from '../problem';
import { INVALID, type CheckCtx } from '../shape';
import type { SelectDef, JoinDef } from '../schema';

describe('relation join reproduces the belongs-to traversal', () => {
  it('e.relJoin crosses order → user (belongs-to) and reads the joined alias', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: e.ref('order', 'id').toJSON(), as: 'orderId' },
        { expr: e.ref('c', 'name').toJSON(), as: 'customer' },
      ],
      from: { kind: 'type', type: 'order' },
      // `relJoin` returns a plain JoinDef (no `.toJSON()`).
      joins: [e.relJoin('order', 'userId', 'c', { joinType: 'inner' })],
      order: [{ expr: e.ref('order', 'id').toJSON(), dir: 'asc' }],
    };
    expect(fx.engine.validateQuery(def).hasErrors).toBe(false);
    const result = await fx.engine.run(def);
    expect(result.rows).toEqual([
      { orderId: 10, customer: 'Ada' },
      { orderId: 11, customer: 'Ada' },
      { orderId: 12, customer: 'Bob' },
      { orderId: 13, customer: 'Bob' },
    ]);
    // SQL: the synthesized key ON, joined table aliased to the REQUIRED `as`.
    const sql = fx.engine.toSQL(def, 'base').sql;
    expect(sql).toContain('INNER JOIN "user" AS "c" ON');
    expect(sql).toContain('"order"."userId" = "c"."id"');
  });

  it('a LEFT relation join (default) nullable-widens the unmatched side', async () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: e.ref('user', 'name').toJSON(), as: 'name' },
        // has-many `user.orders` binds under the REQUIRED alias `o`.
        { expr: e.ref('o', 'id').toJSON(), as: 'orderId' },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [e.relJoin('user', 'orders', 'o')], // default LEFT
      order: [
        { expr: e.ref('user', 'id').toJSON(), dir: 'asc' },
        { expr: e.ref('o', 'id').toJSON(), dir: 'asc' },
      ],
    };
    const result = await fx.engine.run(def);
    // Cleo (id 3) has no orders ⇒ a LEFT-unmatched row with a null orderId.
    expect(result.rows).toEqual([
      { name: 'Ada', orderId: 10 },
      { name: 'Ada', orderId: 11 },
      { name: 'Bob', orderId: 12 },
      { name: 'Bob', orderId: 13 },
      { name: 'Cleo', orderId: null },
    ]);
  });
});

describe('a field-ref to a relation field is a ref.relation error', () => {
  it('reports ref.relation with the join-it hint', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('order', 'userId').toJSON(), as: 'u' }],
      from: { kind: 'type', type: 'order' },
    };
    const problems = fx.engine.validateQuery(def);
    const rel = problems.list.find((p) => p.code === 'ref.relation');
    expect(rel).toBeDefined();
    expect(rel!.message).toContain("kind:'relation'");
  });
});

describe('a manual source-def join uses `and` as its ON', () => {
  it('joins FROM order to a `type: user` source on an explicit predicate', async () => {
    const fx = runtimeFixture();
    // A MANUAL source-def join adds the `user` source directly, and `and` IS the
    // full ON condition. Crossing the `order.userId` RELATION as a value is a
    // `ref.relation` error, so the explicit ON is a plain SCALAR predicate here
    // (`user.age > 40` ⇒ only Bob qualifies to join every order).
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: e.ref('order', 'id').toJSON(), as: 'orderId' },
        { expr: e.ref('user', 'name').toJSON(), as: 'customer' },
      ],
      from: { kind: 'type', type: 'order' },
      joins: [
        {
          on: { kind: 'type', type: 'user' },
          and: e.gt(e.ref('user', 'age'), e.value(40)).toJSON(),
          joinType: 'inner',
        },
      ],
      order: [{ expr: e.ref('order', 'id').toJSON(), dir: 'asc' }],
    };
    expect(fx.engine.validateQuery(def).hasErrors).toBe(false);
    const result = await fx.engine.run(def);
    // Only Bob (age 42) satisfies the ON, so every order pairs with Bob.
    expect(result.rows).toEqual([
      { orderId: 10, customer: 'Bob' },
      { orderId: 11, customer: 'Bob' },
      { orderId: 12, customer: 'Bob' },
      { orderId: 13, customer: 'Bob' },
    ]);
    // SQL: the added source is aliased under its Type name, `and` is the ON.
    const sql = fx.engine.toSQL(def, 'base').sql;
    expect(sql).toContain('INNER JOIN "user" AS "user" ON');
    expect(sql).toContain('"user"."age" > ');
  });

  it('round-trips a manual join def through toJSON', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: e.ref('order', 'id').toJSON() }],
      from: { kind: 'type', type: 'order' },
      joins: [
        {
          on: { kind: 'aliased', type: 'user', as: 'buyer' },
          and: e.eq(e.ref('buyer', 'id'), e.ref('order', 'userId')).toJSON(),
        },
      ],
    };
    const round = fx.engine.parseQuery(def).toJSON();
    expect(round).toEqual(def);
  });
});

// ─── JOIN_ON_SHAPE: the structural (zod-free) parser of a join `on` ──────────

describe('the join `on` structural parser (JOIN_ON_SHAPE)', () => {
  it('parses a non-relation `on` (a source def) into a `source` join', () => {
    const fx = fixture();
    const problems = new Problems();
    const ctx: CheckCtx = { problems, registry: fx.registry };
    const join = QueryJoin.SHAPE.check({ on: { kind: 'type', type: 'user' }, joinType: 'inner' }, ctx);
    expect(problems.hasErrors).toBe(false);
    if (join === INVALID) throw new Error('expected a QueryJoin, got INVALID');
    // The source-def `on` wraps as `{ kind:'source', source }`; its alias is the
    // Type name, so `label` reads it back.
    expect(join.on.kind).toBe('source');
    expect(join.label).toBe('user');
    expect(join.joinType).toBe('inner');
  });

  it('reports a malformed `on` (neither a relation nor a valid source) as INVALID', () => {
    const fx = fixture();
    const problems = new Problems();
    const ctx: CheckCtx = { problems, registry: fx.registry };
    // `42` is not a `kind:'relation'` record and is not a valid source def, so
    // the source branch returns INVALID and the whole join fails to parse.
    const bad = QueryJoin.SHAPE.check({ on: 42 }, ctx);
    expect(bad).toBe(INVALID);
    expect(problems.hasErrors).toBe(true);
  });
});

// ─── manual (source-def) join: cost expansion + clone ────────────────────────

describe('a manual (source-def) join — expansionFactor + clone', () => {
  it('expansionFactor of a source join is the joined source row count (ignores the alias map)', () => {
    const fx = fixture();
    const join = QueryJoin.from({ on: { kind: 'type', type: 'user' } }, fx.registry);
    // A source join resolves its own Type (not a relation on the left), so the
    // factor comes from the joined source's row count — independent of the map.
    expect(join.expansionFactor(fx.engine, new Map())).toBe(Math.max(1, fx.user.count));
    expect(join.expansionFactor(fx.engine, new Map())).toBeGreaterThanOrEqual(1);
  });

  it('a source-def join with NO `and` emits a `1 = 1` (cross) ON', () => {
    const fx = runtimeFixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: e.ref('order', 'id').toJSON(), as: 'oid' },
        { expr: e.ref('user', 'name').toJSON(), as: 'name' },
      ],
      from: { kind: 'type', type: 'order' },
      // No `and` ⇒ an unconstrained (cross) join whose ON is `1 = 1`.
      joins: [{ on: { kind: 'type', type: 'user' }, joinType: 'inner' }],
    };
    const sql = fx.engine.toSQL(def, 'base').sql;
    expect(sql).toContain('INNER JOIN "user" AS "user" ON 1 = 1');
  });

  it('clone() deep-copies a source-def join and its `and`, round-tripping toJSON', () => {
    const fx = fixture();
    const def: JoinDef = {
      on: { kind: 'aliased', type: 'user', as: 'buyer' },
      and: e.eq(e.ref('buyer', 'id'), e.ref('order', 'userId')).toJSON(),
      joinType: 'inner',
    };
    const join = QueryJoin.from(def, fx.registry);
    const cloned = join.clone();
    expect(cloned).not.toBe(join);
    expect(cloned.on.kind).toBe('source');
    expect(cloned.toJSON()).toEqual(def);
  });
});

// ─── a whole-Type output field (a tabular-function-call resolves to a Type) ──

describe('a query field that resolves to a whole Type', () => {
  it('marks the field `fieldType:"type"` with no own nullability, and folds into a synthetic type', () => {
    const fx = fixture();
    // A tabular (row-producing) function is the one expr that resolves to a
    // whole Type; used as a SELECT field it yields a whole-Type output field.
    fx.registry.registerFunction({ name: 'gen', shape: 'tabular', params: [], output: { type: 'user' } });
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: e.ref('order', 'id').toJSON(), as: 'oid' },
        { expr: { kind: 'tabular-function-call', function: 'gen', args: {} }, as: 'g' },
      ],
      from: { kind: 'type', type: 'order' },
    };
    const q = fx.engine.parseQuery(def);
    const fields = q.outputFields(fx.engine, fx.engine.globalScope());
    const g = fields.find((f) => f.name === 'g');
    expect(g).toBeDefined();
    // makeField: `asFieldType` is undefined for a whole Type ⇒ the `'type'`
    // sentinel, and a whole-Type field carries no nullability of its own.
    expect(g!.fieldType).toBe('type');
    expect(g!.nullable).toBe(false);
    // Resolving the 2-field query builds a synthetic Type over the fields,
    // folding the whole-Type field (the `kind === 'type'` nullability branch).
    const resolved = fx.engine.resolveQuery(def);
    expect(resolved.kind).toBe('type');
  });
});
