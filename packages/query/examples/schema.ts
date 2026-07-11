/**
 * Shared example schema + dataset.
 *
 * Defines three related Types (`user`, `order`, `product`) over a small
 * bundled JSON dataset, and wires an in-memory `QueryEngine` whose executors
 * serve that data via `arrayExecutor`. Every numbered example imports from
 * here so they all run against one consistent fixture.
 *
 * The Type `count` / `bytes` are deliberately INFLATED beyond the tiny
 * dataset so cost estimation (and a cost-constraint rejection) is meaningful
 * even though the in-memory types hold only a handful of rows.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRegistry,
  QueryEngine,
  arrayExecutor,
  type Registry,
  type Type,
  type TypeDef,
  type SourceRecord,
} from '../src/index';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read + parse one bundled JSON dataset file. */
function loadRows(file: string): SourceRecord[] {
  const text = readFileSync(join(HERE, 'data', file), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array.`);
  return parsed;
}

export const userRows: SourceRecord[] = loadRows('users.json');
export const orderRows: SourceRecord[] = loadRows('orders.json');
export const productRows: SourceRecord[] = loadRows('products.json');

// ─── Type definitions ────────────────────────────────────────────────────────

export const userTypeDef: TypeDef = {
  name: 'user',
  label: 'User',
  description: 'A registered customer account.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, label: 'ID' },
    { name: 'name', type: { kind: 'text' }, label: 'Full name' },
    { name: 'age', type: { kind: 'number', whole: true }, nullable: true },
    { name: 'email', type: { kind: 'text', search: true }, label: 'Email address' },
    { name: 'city', type: { kind: 'text' } },
    // `orders` (has-many) is materialized as the inverse of `order.userId`.
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 80,
};

export const orderTypeDef: TypeDef = {
  name: 'order',
  label: 'Order',
  description: 'A purchase of a product by a user.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'userId', type: { kind: 'relation', to: 'user', count: 1, inverseRelation: 'orders' }, label: 'Buyer' },
    { name: 'productId', type: { kind: 'relation', to: 'product', count: 1 }, label: 'Product' },
    { name: 'total', type: { kind: 'money', currency: 'USD' }, label: 'Order total' },
    { name: 'status', type: { kind: 'text' }, label: 'Status' },
    { name: 'createdAt', type: { kind: 'timestamp', timezone: true }, label: 'Placed at' },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, count: 1 }] }],
  count: 5000,
  bytes: 60,
};

export const productTypeDef: TypeDef = {
  name: 'product',
  label: 'Product',
  description: 'A sellable item in the catalog.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text', search: true } },
    { name: 'price', type: { kind: 'money', currency: 'USD' } },
    { name: 'category', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'product', field: 'id' }, count: 1 }] }],
  count: 200,
  bytes: 50,
};

// ─── Engine assembly ───────────────────────────────────────────────────────

/** Everything an example needs: the engine, registry, and Type instances. */
export interface ExampleFixture {
  registry: Registry;
  engine: QueryEngine;
  user: Type;
  order: Type;
  product: Type;
}

/**
 * Build a fresh registry + engine with the three Types registered and
 * in-memory executors serving the bundled JSON.
 */
export function createExampleFixture(): ExampleFixture {
  const registry = createRegistry();
  const user = registry.parseType(userTypeDef);
  const order = registry.parseType(orderTypeDef);
  const product = registry.parseType(productTypeDef);
  registry.registerType(user);
  registry.registerType(order);
  registry.registerType(product);
  // Materialize inverse relations (e.g. user.orders) so they are queryable.
  registry.finalize();
  const engine = new QueryEngine(registry, {
    executors: {
      user: arrayExecutor(userRows),
      order: arrayExecutor(orderRows),
      product: arrayExecutor(productRows),
    },
  });
  return { registry, engine, user, order, product };
}
