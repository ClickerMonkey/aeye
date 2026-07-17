/**
 * Shared test fixtures: a registry with two related example Types (`user`
 * and `order`), an engine over it, and small builder helpers for assembling
 * expression JSON + scopes in tests.
 */
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { QueryScope } from '../scope';
import type { CostContext } from '../cost';
import type { Registry } from '../registry';
import type { Type } from '../type';
import type { TypeDef, ExprDef } from '../schema';
import type { SourceRecord } from '../runtime/row';
import { arrayExecutor } from '../runtime/executor';

export const userTypeDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'age', type: { kind: 'number', whole: true }, nullable: true },
    { name: 'email', type: { kind: 'text', search: true } },
    // An array-of-text field, for array field-type + array-op tests.
    { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
    // `orders` is MATERIALIZED as the inverse of `order.userId` (see below),
    // so it is not declared here — the registry's `finalize()` adds it.
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 64,
};

export const orderTypeDef: TypeDef = {
  name: 'order',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // Belongs-to user; `inverseRelation` materializes `user.orders` (has-many).
    { name: 'userId', type: { kind: 'relation', to: 'user', count: 1, inverseRelation: 'orders' } },
    { name: 'total', type: { kind: 'money', currency: 'USD' } },
    { name: 'note', type: { kind: 'text' }, nullable: true },
  ],
  count: 5000,
  bytes: 48,
};

export interface Fixture {
  registry: Registry;
  engine: QueryEngine;
  user: Type;
  order: Type;
}

/** Build a fresh registry + engine with the example types registered. */
export function fixture(): Fixture {
  const registry = createRegistry();
  const user = registry.parseType(userTypeDef);
  const order = registry.parseType(orderTypeDef);
  registry.registerType(user);
  registry.registerType(order);
  // Materialize inverse relations (e.g. user.orders) up front so direct field
  // access in tests sees them; engine entry points also finalize lazily.
  registry.finalize();
  const engine = new QueryEngine(registry);
  return { registry, engine, user, order };
}

/** A scope with `user` (alias `u`) and `order` (alias `o`) bound as types. */
export function typeScope(fx: Fixture): QueryScope {
  const scope = fx.engine.globalScope();
  scope.bind('u', { kind: 'type', type: fx.user, source: 'u', synthetic: false });
  scope.bind('o', { kind: 'type', type: fx.order, source: 'o', synthetic: false });
  return scope;
}

// ─── In-memory dataset + runtime fixture ─────────────────────────────────────

/** Sample `user` rows (Cleo has no orders; Cleo has an empty `tags` array). */
export const userRows: SourceRecord[] = [
  { id: 1, name: 'Ada', age: 36, email: 'ada@example.com', tags: ['admin', 'beta'] },
  { id: 2, name: 'Bob', age: 42, email: 'bob@example.com', tags: ['beta'] },
  { id: 3, name: 'Cleo', age: 29, email: 'cleo@example.com', tags: [] },
];

/** Sample `order` rows, each `userId` pointing at a `user`. */
export const orderRows: SourceRecord[] = [
  { id: 10, userId: 1, total: 100, note: 'first' },
  { id: 11, userId: 1, total: 50, note: null },
  { id: 12, userId: 2, total: 200, note: 'big' },
  { id: 13, userId: 2, total: 25, note: null },
];

export interface RuntimeFixture extends Fixture {}

/**
 * A fixture whose engine has in-memory executors wired for `user` and `order`,
 * seeded from `userRows` / `orderRows`. Each call gets fresh data copies.
 */
export function runtimeFixture(): RuntimeFixture {
  const registry = createRegistry();
  const user = registry.parseType(userTypeDef);
  const order = registry.parseType(orderTypeDef);
  registry.registerType(user);
  registry.registerType(order);
  registry.finalize();
  const engine = new QueryEngine(registry, {
    executors: {
      user: arrayExecutor(userRows),
      order: arrayExecutor(orderRows),
    },
  });
  return { registry, engine, user, order };
}

// ─── Tiny expr-JSON builders ─────────────────────────────────────────────────

/** A minimal {@link CostContext} wrapping an engine, for direct `expr.cost(...)` calls in tests. */
export const cctx = (engine: QueryEngine): CostContext => ({ engine });

export const lit = (value: string | number | boolean | null): ExprDef => ({ kind: 'literal', value });
export const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
export const param = (name: string): ExprDef => ({ kind: 'param', name });
export const cmp = (op: '=' | '<>' | '<' | '<=' | '>' | '>=' | 'like' | 'notLike' | 'ilike', left: ExprDef, right: ExprDef): ExprDef => ({
  kind: 'comparison',
  op,
  left,
  right,
});
