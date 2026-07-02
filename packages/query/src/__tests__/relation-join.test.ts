/**
 * Relation joins: the synthesized join key.
 *  - DEFAULT convention: `user.orders` (count > 1) ⇒ has-many, key
 *    `user.id = order.userId`.
 *  - EXPLICIT hints: a `belongs-to` relation pinned with `by: 'userId'` ⇒ key
 *    `order.userId = user.id`.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { fixture, userTypeDef, orderTypeDef, userRows, orderRows } from './_utils';
import type { SelectDef } from '../schema';

describe('relation joins', () => {
  it('default convention has-many join (user.orders) including a LEFT-unmatched row', async () => {
    const registry = createRegistry();
    registry.registerType(registry.parseType(userTypeDef));
    registry.registerType(registry.parseType(orderTypeDef));
    const engine = new QueryEngine(registry, {
      executors: { user: arrayExecutor(userRows), order: arrayExecutor(orderRows) },
    });

    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        // `user.orders` binds the joined source under its TARGET TYPE name `order`.
        { expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'orderId' },
      ],
      from: { kind: 'type', type: 'user' },
      joins: [{ on: { source: 'user', field: 'orders' }, joinType: 'left' }],
      order: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' },
        { expr: { kind: 'field-ref', source: 'order', field: 'id' }, dir: 'asc' },
      ],
    };
    const result = await engine.run(def);
    expect(result.rows).toEqual([
      { name: 'Ada', orderId: 10 },
      { name: 'Ada', orderId: 11 },
      { name: 'Bob', orderId: 12 },
      { name: 'Bob', orderId: 13 },
      { name: 'Cleo', orderId: null },
    ]);
  });

  it('belongs-to join (order.userId): the relation field name IS the key', async () => {
    const registry = createRegistry();
    registry.registerType(registry.parseType(userTypeDef));
    registry.registerType(registry.parseType(orderTypeDef));
    const engine = new QueryEngine(registry, {
      executors: { user: arrayExecutor(userRows), order: arrayExecutor(orderRows) },
    });

    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'orderId' },
        { expr: { kind: 'field-ref', source: 'c', field: 'name' }, as: 'customer' },
      ],
      from: { kind: 'type', type: 'order' },
      // belongs-to: order.userId = user.id (no FK hints — the name is the key).
      joins: [{ on: { source: 'order', field: 'userId' }, as: 'c', joinType: 'inner' }],
      order: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, dir: 'asc' }],
    };
    const result = await engine.run(def);
    expect(result.rows).toEqual([
      { orderId: 10, customer: 'Ada' },
      { orderId: 11, customer: 'Ada' },
      { orderId: 12, customer: 'Bob' },
      { orderId: 13, customer: 'Bob' },
    ]);
  });

  it('a join whose target type collides with the FROM type reports source.duplicate; `as` resolves it', async () => {
    const registry = createRegistry();
    registry.registerType(registry.parseType(userTypeDef));
    registry.registerType(registry.parseType(orderTypeDef));
    registry.finalize();
    const engine = new QueryEngine(registry, {
      executors: { user: arrayExecutor(userRows), order: arrayExecutor(orderRows) },
    });

    // FROM user, then CHAIN user.orders (binds `order`) then order.userId (a
    // belongs-to back to `user`): the second hop binds under the target type
    // name `user`, colliding with the FROM source `user`.
    const colliding: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
      joins: [
        { on: { source: 'user', field: 'orders' } },
        { on: { source: 'order', field: 'userId' } },
      ],
    };
    const problems = engine.validateQuery(colliding);
    expect(problems.list.some((p) => p.code === 'source.duplicate')).toBe(true);

    // Adding `as` on the final hop renames it (intermediate hop still binds
    // `order`), clearing the collision. The query then validates, runs, and
    // emits SQL that aliases the joined-back user as `owner`.
    const resolved: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, as: 'userId' },
        { expr: { kind: 'field-ref', source: 'owner', field: 'id' }, as: 'ownerId' },
      ],
      from: { kind: 'type', type: 'user' },
      // Chain: user.orders (binds `order`) then order.userId AS owner.
      joins: [
        { on: { source: 'user', field: 'orders' }, joinType: 'inner' },
        { on: { source: 'order', field: 'userId' }, as: 'owner', joinType: 'inner' },
      ],
      order: [
        { expr: { kind: 'field-ref', source: 'user', field: 'id' }, dir: 'asc' },
        { expr: { kind: 'field-ref', source: 'owner', field: 'id' }, dir: 'asc' },
      ],
    };
    const ok = engine.validateQuery(resolved);
    expect(ok.list.some((p) => p.code === 'source.duplicate')).toBe(false);
    expect(ok.hasErrors).toBe(false);

    // Each user fans out over its orders, each of which points back to the same
    // user (owner === user), so every row has ownerId === userId.
    const result = await engine.run(resolved);
    expect(result.rows).toEqual([
      { userId: 1, ownerId: 1 },
      { userId: 1, ownerId: 1 },
      { userId: 2, ownerId: 2 },
      { userId: 2, ownerId: 2 },
    ]);

    // SQL emission uses the type-named intermediate alias `order` and the
    // authored final alias `owner`.
    const sql = engine.toSQL(resolved, 'base').sql;
    expect(sql).toContain('AS "owner"');
    expect(sql).toContain('AS "order"');
  });

  it('the synthesized key honors the relation field type resolveKey', () => {
    const fx = fixture();
    // user.orders → materialized has-many: user.id = order.userId (FK = inverseVia).
    const ordersField = fx.user.field('orders')!;
    const rel = ordersField.fieldType;
    if (rel.kind !== 'relation') throw new Error('expected relation');
    expect(rel.resolveKey('orders', fx.user, fx.order)).toEqual({ localField: 'id', foreignField: 'userId' });
    // order.userId → belongs-to (count 1): order.userId = user.id (the name is the key).
    const userIdField = fx.order.field('userId')!;
    const rel2 = userIdField.fieldType;
    if (rel2.kind !== 'relation') throw new Error('expected relation');
    expect(rel2.resolveKey('userId', fx.order, fx.user)).toEqual({ localField: 'userId', foreignField: 'id' });
  });
});
