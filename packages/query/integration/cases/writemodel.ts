/**
 * Write-model cases — BOTH directions:
 *  - POSITIVE inserts into the writable `product` Type (`expect: 'rows'`): the
 *    oracle INSERT … RETURNING must validate + run, and its RETURNING projection
 *    is the derived expected. RETURNING avoids the auto-assigned `id` so the
 *    result is stable across the harness's two deterministic runs. One case
 *    omits `active` to exercise the `FieldBacking.default` (materialized true).
 *  - REFUSAL cases (`expect: 'refusal'`): the ILLEGAL statement must FAIL to
 *    validate — either a whole-Type lock (currency/payment) or a single
 *    non-insertable/non-updatable FIELD on an otherwise-writable Type.
 */
import { e } from '../model';
import type { EvalCase } from './types';

export const writeModelCases: EvalCase[] = [
  {
    id: 'insert-product-returning',
    category: 'write-model',
    request:
      "Add a new product named 'Test Widget' in category 4 with sku 'SKU-T1', price 199, active. Return the new product's name and price.",
    oracle: () => ({
      kind: 'insert',
      into: 'product',
      fields: ['name', 'categoryId', 'sku', 'price', 'active'],
      values: [
        [
          e.value('Test Widget').toJSON(),
          e.value(4).toJSON(),
          e.value('SKU-T1').toJSON(),
          e.value(199).toJSON(),
          e.value(true).toJSON(),
        ],
      ],
      returning: [
        { expr: e.ref('product', 'name').toJSON(), as: 'name' },
        { expr: e.ref('product', 'price').toJSON(), as: 'price' },
      ],
    }),
    note: 'product IS insertable, so this is ALLOWED (not a refusal); RETURNING the supplied name/price (not the generated id) keeps the result deterministic.',
  },
  {
    id: 'insert-product-default-active',
    category: 'write-model',
    request:
      "Add a new product named 'Defaulted Widget' in category 4 with sku 'SKU-T2' and price 50, without specifying whether it is active. Return the stored active flag.",
    oracle: () => ({
      kind: 'insert',
      into: 'product',
      fields: ['name', 'categoryId', 'sku', 'price'],
      values: [
        [
          e.value('Defaulted Widget').toJSON(),
          e.value(4).toJSON(),
          e.value('SKU-T2').toJSON(),
          e.value(50).toJSON(),
        ],
      ],
      returning: [{ expr: e.ref('product', 'active').toJSON(), as: 'active' }],
    }),
    note: "active is OMITTED, so the product backing's FieldBacking.default materializes it to true on insert — RETURNING active must be true, not null/undefined.",
  },
  {
    id: 'refusal-insert-product-id',
    category: 'write-model',
    request: 'Insert a product with an explicit id of 999 (name X, category 4, sku SKU-Z, price 1).',
    expect: 'refusal',
    oracle: () => ({
      kind: 'insert',
      into: 'product',
      fields: ['id', 'name', 'categoryId', 'sku', 'price'],
      values: [
        [
          e.value(999).toJSON(),
          e.value('X').toJSON(),
          e.value(4).toJSON(),
          e.value('SKU-Z').toJSON(),
          e.value(1).toJSON(),
        ],
      ],
    }),
    note: 'product is insertable, but its `id` field is insertable:false — supplying it must be rejected (insert.field-readonly), a FIELD-level refusal distinct from the whole-Type locks below.',
  },
  {
    id: 'refusal-update-customer-createdat',
    category: 'write-model',
    request: "Change customer 1's onboarding timestamp (createdAt) to 2020-01-01.",
    expect: 'refusal',
    oracle: () => ({
      kind: 'update',
      type: 'customer',
      set: [{ field: 'createdAt', value: e.value('2020-01-01T00:00:00Z').toJSON() }],
      where: [e.eq(e.ref('customer', 'id'), e.value(1)).toJSON()],
    }),
    note: 'customer is updatable, but its `createdAt` field is updatable:false — the assignment must be rejected (update.field-readonly), unlike the whole-Type currency/payment refusals.',
  },
  {
    id: 'refusal-update-currency',
    category: 'write-model',
    request: "Rename the USD currency to 'Dollar'.",
    expect: 'refusal',
    oracle: () => ({
      kind: 'update',
      type: 'currency',
      set: [{ field: 'name', value: e.value('Dollar').toJSON() }],
      where: [e.eq(e.ref('currency', 'code'), e.value('USD')).toJSON()],
    }),
    note: 'currency is reference data (updatable:false); any UPDATE to it must be rejected.',
  },
  {
    id: 'refusal-delete-payment',
    category: 'write-model',
    request: 'Delete the payment with id 1.',
    expect: 'refusal',
    oracle: () => ({
      kind: 'delete',
      from: 'payment',
      where: [e.eq(e.ref('payment', 'id'), e.value(1)).toJSON()],
    }),
    note: 'payment is an append-only ledger (deletable:false); a DELETE must be rejected.',
  },
];
