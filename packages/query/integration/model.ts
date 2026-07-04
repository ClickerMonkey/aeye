/**
 * The integration harness's ERP MODEL — a made-up but coherent 20-Type ERP that
 * exercises the whole `@aeye/query` feature surface (relations both ways,
 * date/timestamp, money, search-flagged text, arrays, json, indexes, the
 * write-model, and dev-side backing).
 *
 * The Types here are the CONCEPTUAL schema the LLM is shown. Their rows live as
 * static JSON under `data/` (regenerate with `tsx integration/data/generate.ts`);
 * `buildEngine()` wires an in-memory `QueryEngine` over that data via
 * `arrayExecutor`, exactly like `examples/schema.ts` does for its 3-Type demo.
 *
 * Naming convention: Type names are SINGULAR (`salesOrder`) and a belongs-to
 * relation FIELD carries a CLEAN, LLM-facing name (`customer`, `order`,
 * `category`, …) — the physical foreign-key COLUMN it joins on
 * (`customer_id`, `order_id`, …, emitted by the generator) is hidden in
 * `FieldBacking.relation` (see `buildBackings`), NOT the field name. A
 * belongs-to relation (`count: 1`) with an `inverseRelation` materializes the
 * has-many side on the target (so `customer.salesOrders` is queryable), reusing
 * the same physical FK.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  e,
  createRegistry,
  QueryEngine,
  arrayExecutor,
  joinAlias,
  Value,
  SqlText,
  type Registry,
  type Type,
  type TypeDef,
  type ExprDef,
  type IndexDef,
  type TypeBacking,
  type FieldBacking,
  type SourceRecord,
} from '../src/index';

const HERE = dirname(fileURLToPath(import.meta.url));

// ─── helpers ────────────────────────────────────────────────────────────────

/** A single-field unique index on `field` of `type` — makes it the identity. */
function idIndex(type: string, field = 'id'): IndexDef {
  return { exprs: [{ expr: { kind: 'field-ref', source: type, field }, count: 1 }] };
}

/** A non-unique secondary index part on `type.field` with an estimated count. */
function index(type: string, field: string, count: number): IndexDef {
  return { exprs: [{ expr: { kind: 'field-ref', source: type, field }, count }] };
}

const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });

// ════════════════════════════════════════════════════════════════════════════
// TYPE DEFINITIONS (20)
// ════════════════════════════════════════════════════════════════════════════

/** currency — a read-only reference Type (append/update/delete all disabled). */
const currencyDef: TypeDef = {
  name: 'currency',
  label: 'Currency',
  description: 'An ISO-4217 currency used for pricing and orders (reference data).',
  fields: [
    { name: 'code', type: { kind: 'text' }, label: 'ISO code', updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text' } },
    { name: 'symbol', type: { kind: 'text' } },
    { name: 'rateToUsd', type: { kind: 'number' }, label: 'Rate to USD' },
  ],
  indexes: [idIndex('currency', 'code')],
  insertable: false,
  updatable: false,
  deletable: false,
  count: 3,
  bytes: 32,
};

/** taxRate — a small reference Type. */
const taxRateDef: TypeDef = {
  name: 'taxRate',
  label: 'Tax rate',
  description: 'A named sales-tax rate applied in a region.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text' } },
    { name: 'rate', type: { kind: 'number', maxPlaces: 4 }, label: 'Fractional rate' },
    { name: 'region', type: { kind: 'text' } },
  ],
  indexes: [idIndex('taxRate')],
  count: 4,
  bytes: 40,
};

/** category — self-referential (parent/children) belongs-to. */
const categoryDef: TypeDef = {
  name: 'category',
  label: 'Product category',
  description: 'A product category; may have a parent category.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text', search: true } },
    { name: 'slug', type: { kind: 'text' } },
    {
      name: 'parent',
      type: { kind: 'relation', to: 'category', count: 1, inverseRelation: 'children' },
      label: 'Parent category',
      nullable: true,
    },
  ],
  indexes: [idIndex('category')],
  count: 8,
  bytes: 48,
};

/** department — cost centre for employees. */
const departmentDef: TypeDef = {
  name: 'department',
  label: 'Department',
  description: 'An organizational department.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text' } },
    { name: 'code', type: { kind: 'text' } },
    { name: 'budget', type: { kind: 'money', currency: 'USD' } },
  ],
  indexes: [idIndex('department')],
  count: 5,
  bytes: 48,
};

/** employee — belongs-to department; has an array field + a date + money. */
const employeeDef: TypeDef = {
  name: 'employee',
  label: 'Employee',
  description: 'A staff member; sales reps place sales orders.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text', search: true } },
    {
      name: 'department',
      type: { kind: 'relation', to: 'department', count: 1, inverseRelation: 'employees' },
      label: 'Department',
    },
    { name: 'title', type: { kind: 'text' } },
    { name: 'hiredAt', type: { kind: 'date' }, label: 'Hire date' },
    { name: 'salary', type: { kind: 'money', currency: 'USD' } },
    { name: 'skills', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
    { name: 'active', type: { kind: 'bool' } },
  ],
  indexes: [idIndex('employee'), index('employee', 'department', 3)],
  count: 40,
  bytes: 96,
};

/** customer — a headline entity; has-many salesOrders / contacts / invoices. */
const customerDef: TypeDef = {
  name: 'customer',
  label: 'Customer',
  description: 'An account that places sales orders.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text', search: true }, label: 'Company name' },
    { name: 'region', type: { kind: 'text' }, label: 'Sales region' },
    { name: 'tier', type: { kind: 'text' }, description: 'gold | silver | bronze' },
    { name: 'email', type: { kind: 'text', search: true }, nullable: true },
    { name: 'createdAt', type: { kind: 'timestamp', timezone: true }, label: 'Onboarded at', updatable: false },
    { name: 'creditLimit', type: { kind: 'money', currency: 'USD' }, nullable: true },
    { name: 'metadata', type: { kind: 'json' }, nullable: true },
    { name: 'active', type: { kind: 'bool' } },
  ],
  indexes: [idIndex('customer'), index('customer', 'region', 3)],
  count: 500,
  bytes: 160,
};

/** contact — belongs-to customer (has-many contacts). */
const contactDef: TypeDef = {
  name: 'contact',
  label: 'Contact',
  description: 'A person at a customer account.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'customer',
      type: { kind: 'relation', to: 'customer', count: 1, inverseRelation: 'contacts' },
      label: 'Customer',
    },
    { name: 'name', type: { kind: 'text' } },
    { name: 'email', type: { kind: 'text' } },
    { name: 'phone', type: { kind: 'text' }, nullable: true },
    { name: 'isPrimary', type: { kind: 'bool' }, label: 'Primary contact' },
    { name: 'notes', type: { kind: 'text', search: true }, nullable: true },
  ],
  indexes: [idIndex('contact'), index('contact', 'customer', 4)],
  count: 1200,
  bytes: 128,
};

/** vendor — supplier for purchase orders. */
const vendorDef: TypeDef = {
  name: 'vendor',
  label: 'Vendor',
  description: 'A supplier the company buys inventory from.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text', search: true } },
    { name: 'region', type: { kind: 'text' } },
    { name: 'rating', type: { kind: 'number', maxPlaces: 1 }, nullable: true },
    { name: 'active', type: { kind: 'bool' } },
  ],
  indexes: [idIndex('vendor')],
  count: 60,
  bytes: 80,
};

/** product — belongs-to category; array `tags`, json `attributes`, BACKED fields. */
const productDef: TypeDef = {
  name: 'product',
  label: 'Product',
  description: 'A sellable catalog item.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text', search: true } },
    {
      name: 'category',
      type: { kind: 'relation', to: 'category', count: 1, inverseRelation: 'products' },
      label: 'Category',
    },
    { name: 'sku', type: { kind: 'text' }, label: 'SKU' },
    { name: 'price', type: { kind: 'money', currency: 'USD' }, label: 'List price' },
    { name: 'weight', type: { kind: 'number', maxPlaces: 2 }, label: 'Weight (kg)', nullable: true },
    { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
    { name: 'attributes', type: { kind: 'json' }, nullable: true },
    // Backed: `active` gets a FieldBacking.default (materialized on INSERT).
    { name: 'active', type: { kind: 'bool' } },
    // Backed: computed display label (never stored; formatted from `price`).
    { name: 'priceLabel', type: { kind: 'text' }, nullable: true, insertable: false, updatable: false },
  ],
  indexes: [idIndex('product'), index('product', 'category', 4)],
  count: 300,
  bytes: 200,
};

/** priceListItem — per-currency price for a product (has-many `prices`). */
const priceListItemDef: TypeDef = {
  name: 'priceListItem',
  label: 'Price list item',
  description: 'A product price in a specific currency, with a minimum quantity.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'product',
      type: { kind: 'relation', to: 'product', count: 1, inverseRelation: 'prices' },
      label: 'Product',
    },
    { name: 'currency', type: { kind: 'relation', to: 'currency', count: 1 }, label: 'Currency' },
    { name: 'price', type: { kind: 'money' } },
    { name: 'minQty', type: { kind: 'number', whole: true }, label: 'Minimum quantity' },
  ],
  indexes: [idIndex('priceListItem'), index('priceListItem', 'product', 3)],
  count: 900,
  bytes: 56,
};

/** warehouse — a stocking location. */
const warehouseDef: TypeDef = {
  name: 'warehouse',
  label: 'Warehouse',
  description: 'A physical stocking location.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'name', type: { kind: 'text' } },
    { name: 'region', type: { kind: 'text' } },
    { name: 'capacity', type: { kind: 'number', whole: true } },
  ],
  indexes: [idIndex('warehouse')],
  count: 6,
  bytes: 48,
};

/** inventory — junction of product × warehouse with on-hand quantity. */
const inventoryDef: TypeDef = {
  name: 'inventory',
  label: 'Inventory',
  description: 'On-hand quantity of a product at a warehouse.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'product',
      type: { kind: 'relation', to: 'product', count: 1, inverseRelation: 'stock' },
      label: 'Product',
    },
    {
      name: 'warehouse',
      type: { kind: 'relation', to: 'warehouse', count: 1, inverseRelation: 'stock' },
      label: 'Warehouse',
    },
    { name: 'quantity', type: { kind: 'number', whole: true }, label: 'On hand' },
    { name: 'reorderLevel', type: { kind: 'number', whole: true } },
  ],
  indexes: [idIndex('inventory'), index('inventory', 'product', 3)],
  count: 1800,
  bytes: 48,
};

/** salesOrder — headline fact table; belongs-to customer / rep / currency. */
const salesOrderDef: TypeDef = {
  name: 'salesOrder',
  label: 'Sales order',
  description: 'A customer order. `total` is the order value; `status` is its lifecycle state.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'customer',
      type: { kind: 'relation', to: 'customer', count: 1, inverseRelation: 'salesOrders' },
      label: 'Customer',
    },
    {
      name: 'salesRep',
      type: { kind: 'relation', to: 'employee', count: 1, inverseRelation: 'repOrders' },
      label: 'Sales rep',
    },
    { name: 'currency', type: { kind: 'relation', to: 'currency', count: 1 }, label: 'Currency' },
    { name: 'status', type: { kind: 'text' }, description: 'draft | open | paid | cancelled | refunded' },
    { name: 'orderedAt', type: { kind: 'date' }, label: 'Order date' },
    { name: 'createdAt', type: { kind: 'timestamp', timezone: true } },
    { name: 'total', type: { kind: 'money', currency: 'USD' }, label: 'Order total' },
    { name: 'notes', type: { kind: 'text' }, nullable: true },
  ],
  indexes: [idIndex('salesOrder'), index('salesOrder', 'customer', 12), index('salesOrder', 'status', 5)],
  count: 5000,
  bytes: 160,
};

/** salesOrderLine — has-many line items under a sales order. */
const salesOrderLineDef: TypeDef = {
  name: 'salesOrderLine',
  label: 'Sales order line',
  description: 'One product line on a sales order. `lineTotal` = quantity × unitPrice − discount.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'order',
      type: { kind: 'relation', to: 'salesOrder', count: 1, inverseRelation: 'lines' },
      label: 'Sales order',
    },
    { name: 'product', type: { kind: 'relation', to: 'product', count: 1 }, label: 'Product' },
    { name: 'quantity', type: { kind: 'number', whole: true } },
    { name: 'unitPrice', type: { kind: 'money', currency: 'USD' } },
    { name: 'discount', type: { kind: 'money', currency: 'USD' } },
    { name: 'lineTotal', type: { kind: 'money', currency: 'USD' }, label: 'Line total' },
  ],
  indexes: [idIndex('salesOrderLine'), index('salesOrderLine', 'order', 40)],
  count: 15000,
  bytes: 64,
};

/** purchaseOrder — belongs-to vendor; has-many lines. */
const purchaseOrderDef: TypeDef = {
  name: 'purchaseOrder',
  label: 'Purchase order',
  description: 'An order the company places with a vendor to restock inventory.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'vendor',
      type: { kind: 'relation', to: 'vendor', count: 1, inverseRelation: 'purchaseOrders' },
      label: 'Vendor',
    },
    { name: 'warehouse', type: { kind: 'relation', to: 'warehouse', count: 1, inverseRelation: 'inboundPOs' }, label: 'Warehouse' },
    { name: 'status', type: { kind: 'text' }, description: 'draft | sent | received | cancelled' },
    { name: 'orderedAt', type: { kind: 'date' } },
    { name: 'total', type: { kind: 'money', currency: 'USD' } },
  ],
  indexes: [idIndex('purchaseOrder')],
  count: 2000,
  bytes: 96,
};

/** purchaseOrderLine — has-many line items under a purchase order. */
const purchaseOrderLineDef: TypeDef = {
  name: 'purchaseOrderLine',
  label: 'Purchase order line',
  description: 'One product line on a purchase order.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'purchaseOrder',
      type: { kind: 'relation', to: 'purchaseOrder', count: 1, inverseRelation: 'lines' },
      label: 'Purchase order',
    },
    { name: 'product', type: { kind: 'relation', to: 'product', count: 1 }, label: 'Product' },
    { name: 'quantity', type: { kind: 'number', whole: true } },
    { name: 'unitCost', type: { kind: 'money', currency: 'USD' } },
  ],
  indexes: [idIndex('purchaseOrderLine'), index('purchaseOrderLine', 'purchaseOrder', 12)],
  count: 8000,
  bytes: 56,
};

/** invoice — belongs-to salesOrder + customer; has-many payments. */
const invoiceDef: TypeDef = {
  name: 'invoice',
  label: 'Invoice',
  description: 'A billing document for a sales order. `amount` is billed; `status` is paid | unpaid | overdue.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'salesOrder',
      type: { kind: 'relation', to: 'salesOrder', count: 1, inverseRelation: 'invoices' },
      label: 'Sales order',
    },
    {
      name: 'customer',
      type: { kind: 'relation', to: 'customer', count: 1, inverseRelation: 'invoices' },
      label: 'Customer',
    },
    { name: 'amount', type: { kind: 'money', currency: 'USD' } },
    { name: 'issuedAt', type: { kind: 'date' }, label: 'Issue date' },
    { name: 'dueAt', type: { kind: 'date' }, label: 'Due date' },
    { name: 'status', type: { kind: 'text' } },
    { name: 'createdAt', type: { kind: 'timestamp', timezone: true }, updatable: false },
  ],
  indexes: [idIndex('invoice'), index('invoice', 'status', 3)],
  count: 4800,
  bytes: 128,
};

/**
 * payment — APPEND-ONLY ledger: rows may be inserted but never updated or
 * deleted (a common financial-ledger constraint). `id` / `createdAt` are also
 * individually non-updatable.
 */
const paymentDef: TypeDef = {
  name: 'payment',
  label: 'Payment',
  description: 'A payment received against an invoice. Append-only: never updated or deleted.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    { name: 'invoice', type: { kind: 'relation', to: 'invoice', count: 1, inverseRelation: 'payments' }, label: 'Invoice' },
    { name: 'customer', type: { kind: 'relation', to: 'customer', count: 1, inverseRelation: 'payments' }, label: 'Customer' },
    { name: 'amount', type: { kind: 'money', currency: 'USD' } },
    { name: 'method', type: { kind: 'text' }, description: 'card | wire | check | cash' },
    { name: 'paidAt', type: { kind: 'date' }, label: 'Payment date' },
    { name: 'createdAt', type: { kind: 'timestamp', timezone: true }, updatable: false },
  ],
  indexes: [idIndex('payment'), index('payment', 'invoice', 2)],
  updatable: false,
  deletable: false,
  count: 6000,
  bytes: 96,
};

/** shipment — belongs-to salesOrder; a nullable shippedAt (unshipped orders). */
const shipmentDef: TypeDef = {
  name: 'shipment',
  label: 'Shipment',
  description: 'A physical shipment fulfilling a sales order.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'salesOrder',
      type: { kind: 'relation', to: 'salesOrder', count: 1, inverseRelation: 'shipments' },
      label: 'Sales order',
    },
    { name: 'status', type: { kind: 'text' }, description: 'pending | shipped | delivered' },
    { name: 'shippedAt', type: { kind: 'date' }, nullable: true },
    { name: 'carrier', type: { kind: 'text' }, nullable: true },
    { name: 'trackingNumber', type: { kind: 'text' }, nullable: true },
  ],
  indexes: [idIndex('shipment')],
  count: 4000,
  bytes: 96,
};

/** salesReturn — belongs-to salesOrder + customer. */
const salesReturnDef: TypeDef = {
  name: 'salesReturn',
  label: 'Return',
  description: 'A returned sales order (or part of one), with a reason and refund amount.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true }, updatable: false, insertable: false },
    {
      name: 'salesOrder',
      type: { kind: 'relation', to: 'salesOrder', count: 1, inverseRelation: 'returns' },
      label: 'Sales order',
    },
    {
      name: 'customer',
      type: { kind: 'relation', to: 'customer', count: 1, inverseRelation: 'returns' },
      label: 'Customer',
    },
    // Composite-FK relation (DEMO): the invoice for the SAME sales order AND the
    // SAME customer as this return — its ON ANDs two physical FK pairs
    // (`sales_order_id`, `customer_id`). Nullable: a refunded order has no invoice.
    {
      name: 'invoice',
      type: { kind: 'relation', to: 'invoice', count: 1 },
      label: 'Matching invoice',
      nullable: true,
    },
    { name: 'reason', type: { kind: 'text' } },
    { name: 'amount', type: { kind: 'money', currency: 'USD' }, label: 'Refund amount' },
    { name: 'returnedAt', type: { kind: 'date' } },
    { name: 'restocked', type: { kind: 'bool' } },
  ],
  indexes: [idIndex('salesReturn')],
  count: 800,
  bytes: 96,
};

/** Every conceptual Type def, in registration order. */
export const TYPE_DEFS: readonly TypeDef[] = [
  currencyDef,
  taxRateDef,
  categoryDef,
  departmentDef,
  employeeDef,
  customerDef,
  contactDef,
  vendorDef,
  productDef,
  priceListItemDef,
  warehouseDef,
  inventoryDef,
  salesOrderDef,
  salesOrderLineDef,
  purchaseOrderDef,
  purchaseOrderLineDef,
  invoiceDef,
  paymentDef,
  shipmentDef,
  salesReturnDef,
];

/** Map a Type name → the plural JSON data file that backs it. */
const DATA_FILE: Readonly<Record<string, string>> = {
  currency: 'currencies.json',
  taxRate: 'taxRates.json',
  category: 'categories.json',
  department: 'departments.json',
  employee: 'employees.json',
  customer: 'customers.json',
  contact: 'contacts.json',
  vendor: 'vendors.json',
  product: 'products.json',
  priceListItem: 'priceListItems.json',
  warehouse: 'warehouses.json',
  inventory: 'inventory.json',
  salesOrder: 'salesOrders.json',
  salesOrderLine: 'salesOrderLines.json',
  purchaseOrder: 'purchaseOrders.json',
  purchaseOrderLine: 'purchaseOrderLines.json',
  invoice: 'invoices.json',
  payment: 'payments.json',
  shipment: 'shipments.json',
  salesReturn: 'salesReturns.json',
};

// ─── Backing (compute + default) ─────────────────────────────────────────────

/**
 * `product` backing: a computed `priceLabel` (dual sql/run — formats `price`
 * as a currency string, never stored) and a `FieldBacking.default` on `active`
 * (materialized to `true` on INSERT when omitted). Exercises the compute +
 * insert-default surface of the write-model.
 */
const productComputeBacking: Record<string, FieldBacking> = {
  priceLabel: {
    compute: {
      run: (alias, row) => {
        const price = row[alias]?.['price'];
        const n = typeof price === 'number' ? price : 0;
        return Value.of(`$${n.toFixed(2)}`);
      },
      sql: (alias, ctx) => SqlText.concat([SqlText.raw("'$' || "), ctx.dialect.field(alias, 'price')]),
    },
  },
  active: {
    default: Value.of(true),
  },
};

/**
 * RELATION-JOIN BACKING for the whole ERP. Every belongs-to relation FIELD now
 * carries a clean, LLM-facing NAME (`customer`, `order`, `category`, …), while
 * its physical foreign-key COLUMN stays hidden in `FieldBacking.relation` — the
 * generator emits those columns as snake_case (`customer_id`, `order_id`, …).
 * The name convention alone would NOT resolve these joins (there is no
 * `customer` column), so the backing is what makes them work. A materialized
 * inverse has-many (e.g. `customer.salesOrders`, `category.children`) REUSES the
 * owning FK — no extra backing on the inverse.
 *
 * Two richer forms are demonstrated:
 *  - a COMPOSITE FK on `salesReturn.invoice` (two ANDed key pairs), and
 *  - a custom `on` (dual `expr`) on `salesOrderLine.order`.
 *
 * Built with the `registry` in scope so the custom `on.expr` can parse its dual
 * predicate `Expr`.
 */
export function buildBackings(registry: Registry): Readonly<Record<string, TypeBacking>> {
  /** A belongs-to relation whose ON is the hidden physical FK `<local>` → target `<foreign>`. */
  const fk = (local: string, foreign = 'id'): FieldBacking => ({ relation: { keys: [{ local, foreign }] } });

  return {
    category: { fields: { parent: fk('parent_id') } },
    employee: { fields: { department: fk('department_id') } },
    contact: { fields: { customer: fk('customer_id') } },
    product: { fields: { category: fk('category_id'), ...productComputeBacking } },
    priceListItem: { fields: { product: fk('product_id'), currency: fk('currency_code', 'code') } },
    inventory: { fields: { product: fk('product_id'), warehouse: fk('warehouse_id') } },
    salesOrder: {
      fields: { customer: fk('customer_id'), salesRep: fk('sales_rep_id'), currency: fk('currency_code', 'code') },
    },
    salesOrderLine: {
      fields: {
        // Custom `on` (DEMO): a DUAL `expr` ON matching the hidden physical
        // `order_id` → salesOrder `id`. It drives BOTH the SQL emission and the
        // in-memory runtime; the inverse `salesOrder.lines` has-many reuses this
        // same predicate (ON is symmetric).
        order: {
          relation: {
            on: { expr: (l, j) => registry.parseExpr(e.eq(e.ref(l, 'order_id'), e.ref(j, 'id')).toJSON()) },
          },
        },
        product: fk('product_id'),
      },
    },
    purchaseOrder: { fields: { vendor: fk('vendor_id'), warehouse: fk('warehouse_id') } },
    purchaseOrderLine: { fields: { purchaseOrder: fk('po_id'), product: fk('product_id') } },
    invoice: { fields: { salesOrder: fk('sales_order_id'), customer: fk('customer_id') } },
    payment: { fields: { invoice: fk('invoice_id'), customer: fk('customer_id') } },
    shipment: { fields: { salesOrder: fk('sales_order_id') } },
    salesReturn: {
      fields: {
        salesOrder: fk('sales_order_id'),
        customer: fk('customer_id'),
        // Composite FK (DEMO): the invoice for the SAME order AND customer — two
        // physical key pairs, ANDed in the ON.
        invoice: {
          relation: {
            keys: [
              { local: 'sales_order_id', foreign: 'sales_order_id' },
              { local: 'customer_id', foreign: 'customer_id' },
            ],
          },
        },
      },
    },
  };
}

// ─── engine assembly ─────────────────────────────────────────────────────────

/** Read + parse one `data/*.json` dataset (must be a JSON array). */
function loadRows(file: string): SourceRecord[] {
  const text = readFileSync(join(HERE, 'data', file), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array.`);
  return parsed;
}

/** Everything the harness needs: the engine, registry, and Type instances. */
export interface ErpModel {
  registry: Registry;
  engine: QueryEngine;
  types: Type[];
}

/**
 * Build a fresh registry + engine with all 20 Types registered (product with
 * its backing), inverse relations materialized, and in-memory executors serving
 * the bundled JSON.
 */
export function buildEngine(): ErpModel {
  const registry = createRegistry();
  const backings = buildBackings(registry);
  const types: Type[] = [];
  for (const def of TYPE_DEFS) {
    const type = registry.parseType(def);
    registry.registerType(type, backings[def.name]);
    types.push(type);
  }
  registry.finalize();

  const executors: Record<string, ReturnType<typeof arrayExecutor>> = {};
  for (const def of TYPE_DEFS) {
    executors[def.name] = arrayExecutor(loadRows(DATA_FILE[def.name]!));
  }
  const engine = new QueryEngine(registry, { executors });
  return { registry, engine, types };
}

// Re-export the builder namespace so cases can `import { e } from '../model'`.
export { e };
