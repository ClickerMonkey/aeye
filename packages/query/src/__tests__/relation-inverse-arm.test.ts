/**
 * A1 — a MATERIALIZED INVERSE must never take the belongs-to arm.
 *
 * `Registry.finalize()` estimates a materialized inverse's `count` as a ROW
 * RATIO (`round(source.count / target.count)`), so a 1:1 pair — or two types
 * that simply share one declared row estimate, which is every freshly-authored
 * type under a single default — yields `count === 1`. Reading the cardinality
 * alone then resolved the inverse as though the FK lived on the WRONG side:
 * `order.invoice = invoice.id`, where `order.invoice` is the synthetic relation
 * field the registry had just added rather than a column. Every traversal
 * matched zero rows, silently.
 *
 * The discriminator is `inverseVia`, which only a materialized inverse carries.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { RelationFieldType } from '../field-types/index';
import type { TypeDef, SelectDef } from '../schema';

/** `invoice` 1..N `order`, both with the SAME row estimate ⇒ inverse count 1. */
const invoiceDef: TypeDef = {
  name: 'invoice',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'ref', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'invoice', field: 'id' }, count: 1 }] }],
  // Equal counts are what make `round(count/count) === 1` — the shape every
  // newly-authored pair has before anything measures either side.
  count: 1000,
  bytes: 32,
};

const orderDef: TypeDef = {
  name: 'order',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // Belongs-to invoice; materializes `invoice.orders` back on the target.
    { name: 'invoice', type: { kind: 'relation', to: 'invoice', count: 1, inverseRelation: 'orders' } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 32,
};

const invoiceRows = [
  { id: 1, ref: 'INV-1' },
  { id: 2, ref: 'INV-2' },
];
const orderRows = [
  { id: 10, invoice: 1 },
  { id: 11, invoice: 1 },
  { id: 12, invoice: 2 },
];

function engineWithInverse(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(invoiceDef));
  registry.registerType(registry.parseType(orderDef));
  registry.finalize();
  return new QueryEngine(registry, {
    executors: { invoice: arrayExecutor(invoiceRows), order: arrayExecutor(orderRows) },
  });
}

describe('A1 — a materialized inverse is never belongs-to', () => {
  it('the fixture really does produce the count===1 inverse this guards against', () => {
    const engine = engineWithInverse();
    const orders = engine.type('invoice')!.field('orders')!;
    const ft = orders.fieldType;
    expect(ft).toBeInstanceOf(RelationFieldType);
    if (!(ft instanceof RelationFieldType)) return;
    // The precondition: a ratio-derived cardinality of 1 with an `inverseVia`.
    expect(ft.count).toBe(1);
    expect(ft.inverseVia).toBe('invoice');
    // …which is nonetheless NOT a belongs-to — the FK is on `order`.
    expect(ft.isBelongsTo()).toBe(false);
  });

  it('resolves the inverse join on the FK side (order.invoice = invoice.id)', () => {
    const engine = engineWithInverse();
    const invoice = engine.type('invoice')!;
    const order = engine.type('order')!;
    const ft = invoice.field('orders')!.fieldType;
    if (!(ft instanceof RelationFieldType)) throw new Error('expected a relation');

    // The belongs-to arm would answer `{ localField: 'orders', foreignField: 'id' }`
    // — a join against `invoice.orders`, which is not a column at all.
    expect(ft.resolveKey('orders', invoice, order)).toEqual({ localField: 'id', foreignField: 'invoice' });
    expect(ft.resolveKeys(engine, 'orders', invoice, order)).toEqual([{ local: 'id', foreign: 'invoice' }]);
    const on = ft.resolveOn(engine, 'orders', invoice, order, 'invoice', 'o');
    expect(on.keys).toEqual([{ localField: 'id', foreignField: 'invoice' }]);
  });

  it('traversing the inverse returns the related rows instead of NOTHING', async () => {
    const engine = engineWithInverse();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'invoice', field: 'ref' }, as: 'ref' },
        { expr: { kind: 'field-ref', source: 'o', field: 'id' }, as: 'orderId' },
      ],
      from: { kind: 'type', type: 'invoice' },
      joins: [{ on: { kind: 'relation', source: 'invoice', field: 'orders', as: 'o' } }],
      order: [
        { expr: { kind: 'field-ref', source: 'invoice', field: 'id' }, dir: 'asc' },
        { expr: { kind: 'field-ref', source: 'o', field: 'id' }, dir: 'asc' },
      ],
    };
    // Under the old rule this produced ZERO rows, with no error anywhere.
    expect((await engine.run(def)).rows).toEqual([
      { ref: 'INV-1', orderId: 10 },
      { ref: 'INV-1', orderId: 11 },
      { ref: 'INV-2', orderId: 12 },
    ]);
    expect(engine.toSQL(def, 'postgres').sql).toContain('ON "invoice"."id" = "o"."invoice"');
  });

  it('a hand-declared count===1 relation IS still belongs-to (no `inverseVia`)', () => {
    const engine = engineWithInverse();
    const ft = engine.type('order')!.field('invoice')!.fieldType;
    if (!(ft instanceof RelationFieldType)) throw new Error('expected a relation');
    expect(ft.inverseVia).toBeUndefined();
    expect(ft.isBelongsTo()).toBe(true);
    expect(ft.resolveKey('invoice', engine.type('order')!, engine.type('invoice')!)).toEqual({
      localField: 'invoice',
      foreignField: 'id',
    });
  });
});
