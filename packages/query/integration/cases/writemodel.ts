/**
 * Write-model cases — BOTH directions:
 *  - POSITIVE inserts into the writable `product` Type: the oracle INSERT …
 *    RETURNING must validate + run, and its RETURNING projection is the derived
 *    expected (`a.kind('insert')` + `a.resultOf`). RETURNING avoids the
 *    auto-assigned `id` so the result is stable across the harness's two runs.
 *  - REFUSAL cases (`a.refused(sample)`): the ILLEGAL statement must FAIL to
 *    validate — either a whole-Type lock (currency/payment) or a single
 *    non-insertable/non-updatable FIELD on an otherwise-writable Type. In LLM
 *    mode the model passes by REFUSING (no valid query); `--check` proves the
 *    sample really is rejected.
 */
import { e } from '../model';
import { a } from './assert';
import type { EvalCase } from './types';

export const writeModelCases: EvalCase[] = [
  {
    id: 'insert-product-returning',
    category: 'write-model',
    request:
      "Add a new product named 'Test Widget' in category 4 with sku 'SKU-T1', price 199, active. Return the new product's name and price.",
    note: 'product IS insertable, so this is ALLOWED (not a refusal); RETURNING the supplied name/price (not the generated id) keeps the result deterministic.',
    assert: [
      a.kind('insert'),
      a.resultOf(() => ({
        kind: 'insert',
        into: 'product',
        rows: [
          {
            name: e.value('Test Widget').toJSON(),
            category: e.value(4).toJSON(),
            sku: e.value('SKU-T1').toJSON(),
            price: e.value(199).toJSON(),
            active: e.value(true).toJSON(),
          },
        ],
        returning: [
          { expr: e.ref('product', 'name').toJSON(), as: 'name' },
          { expr: e.ref('product', 'price').toJSON(), as: 'price' },
        ],
      })),
    ],
  },
  {
    id: 'insert-product-default-active',
    category: 'write-model',
    request:
      "Add a new product named 'Defaulted Widget' in category 4 with sku 'SKU-T2' and price 50, without specifying whether it is active. Return the stored active flag.",
    note: "active is OMITTED, so the product backing's FieldBacking.default materializes it to true on insert — RETURNING active must be true, not null/undefined.",
    assert: [
      a.kind('insert'),
      a.resultOf(() => ({
        kind: 'insert',
        into: 'product',
        rows: [
          {
            name: e.value('Defaulted Widget').toJSON(),
            category: e.value(4).toJSON(),
            sku: e.value('SKU-T2').toJSON(),
            price: e.value(50).toJSON(),
          },
        ],
        returning: [{ expr: e.ref('product', 'active').toJSON(), as: 'active' }],
      })),
    ],
  },
  {
    id: 'refusal-insert-product-id',
    category: 'write-model',
    request: 'Insert a product with an explicit id of 999 (name X, category 4, sku SKU-Z, price 1).',
    note: 'product is insertable, but its `id` field is insertable:false — supplying it must be rejected (insert.field-readonly), a FIELD-level refusal distinct from the whole-Type locks below.',
    assert: [
      a.refused(() => ({
        kind: 'insert',
        into: 'product',
        rows: [
          {
            id: e.value(999).toJSON(),
            name: e.value('X').toJSON(),
            category: e.value(4).toJSON(),
            sku: e.value('SKU-Z').toJSON(),
            price: e.value(1).toJSON(),
          },
        ],
      })),
    ],
  },
  {
    id: 'refusal-update-customer-createdat',
    category: 'write-model',
    request: "Change customer 1's onboarding timestamp (createdAt) to 2020-01-01.",
    note: 'customer is updatable, but its `createdAt` field is updatable:false — the assignment must be rejected (update.field-readonly), unlike the whole-Type currency/payment refusals.',
    assert: [
      a.refused(() => ({
        kind: 'update',
        type: 'customer',
        set: { createdAt: e.value('2020-01-01T00:00:00Z').toJSON() },
        where: [e.eq(e.ref('customer', 'id'), e.value(1)).toJSON()],
      })),
    ],
  },
  {
    id: 'refusal-update-currency',
    category: 'write-model',
    request: "Rename the USD currency to 'Dollar'.",
    note: 'currency is reference data (updatable:false); any UPDATE to it must be rejected.',
    assert: [
      a.refused(() => ({
        kind: 'update',
        type: 'currency',
        set: { name: e.value('Dollar').toJSON() },
        where: [e.eq(e.ref('currency', 'code'), e.value('USD')).toJSON()],
      })),
    ],
  },
  {
    id: 'refusal-delete-payment',
    category: 'write-model',
    request: 'Delete the payment with id 1.',
    note: 'payment is an append-only ledger (deletable:false); a DELETE must be rejected.',
    assert: [
      a.refused(() => ({
        kind: 'delete',
        from: 'payment',
        where: [e.eq(e.ref('payment', 'id'), e.value(1)).toJSON()],
      })),
    ],
  },
];
