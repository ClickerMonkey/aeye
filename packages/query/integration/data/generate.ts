/**
 * DETERMINISTIC data generator for the integration harness.
 *
 *   tsx integration/data/generate.ts
 *
 * Writes one `*.json` file per Type into THIS directory. There is NO randomness
 * — every value is a literal or a pure arithmetic/loop derivation, so the output
 * is byte-stable across runs (re-running never changes a committed fixture).
 *
 * TRAP DESIGN (the whole point): the rows are laid out so a WRONG query returns
 * a WRONG answer. Deliberate distractors include:
 *   - Two customers both named "Acme…" that differ by id/region (1 vs 7) — a
 *     name filter that grabs the wrong one is caught.
 *   - Two products both named "Aurora Laptop" at different prices (1 vs 7).
 *   - Sales orders that sit JUST inside / JUST outside quarter boundaries
 *     (2026-03-01, 2026-03-31 in; 2026-04-01, 2025-12-20 out).
 *   - Cancelled / refunded / draft orders a missing status filter would wrongly
 *     include in "paid" aggregates.
 *   - Multi-line orders so a wrong join grain double-counts `salesOrder.total`.
 *   - An inactive customer (9) and product (10) for "active only" filters.
 *   - A customer (12) with NO orders for EXISTS / anti-join cases.
 *   - Invoices paid in TWO payments so counting payments ≠ counting invoices.
 *   - Shipments with a NULL `shippedAt` (unshipped) inside a shipped-date range.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

type Row = Record<string, unknown>;

/** Write `rows` to `<name>.json` (2-space indent, trailing newline). */
function write(name: string, rows: Row[]): void {
  writeFileSync(join(HERE, `${name}.json`), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

/** A midday UTC timestamp for a `YYYY-MM-DD` date. */
const ts = (date: string): string => `${date}T12:00:00Z`;

// ════════════════════════════════════════════════════════════════════════════
// Reference / dimension data (literal)
// ════════════════════════════════════════════════════════════════════════════

const currencies: Row[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', rateToUsd: 1 },
  { code: 'EUR', name: 'Euro', symbol: '€', rateToUsd: 1.08 },
  { code: 'GBP', name: 'British Pound', symbol: '£', rateToUsd: 1.27 },
];

const taxRates: Row[] = [
  { id: 1, name: 'Standard', rate: 0.08, region: 'West' },
  { id: 2, name: 'Reduced', rate: 0.04, region: 'West' },
  { id: 3, name: 'EU VAT', rate: 0.2, region: 'EU' },
  { id: 4, name: 'Zero', rate: 0, region: 'East' },
];

const categories: Row[] = [
  { id: 1, name: 'Electronics', slug: 'electronics', parentId: null },
  { id: 2, name: 'Furniture', slug: 'furniture', parentId: null },
  { id: 3, name: 'Office Supplies', slug: 'office-supplies', parentId: null },
  { id: 4, name: 'Software', slug: 'software', parentId: null },
  { id: 5, name: 'Laptops', slug: 'laptops', parentId: 1 },
  { id: 6, name: 'Phones', slug: 'phones', parentId: 1 },
  { id: 7, name: 'Chairs', slug: 'chairs', parentId: 2 },
  { id: 8, name: 'Desks', slug: 'desks', parentId: 2 },
];

const departments: Row[] = [
  { id: 1, name: 'Sales', code: 'SAL', budget: 500000 },
  { id: 2, name: 'Engineering', code: 'ENG', budget: 900000 },
  { id: 3, name: 'Support', code: 'SUP', budget: 300000 },
  { id: 4, name: 'Finance', code: 'FIN', budget: 250000 },
  { id: 5, name: 'Marketing', code: 'MKT', budget: 400000 },
];

const employees: Row[] = [
  { id: 1, name: 'Alice Reyes', departmentId: 1, title: 'Account Executive', hiredAt: '2022-03-01', salary: 85000, skills: ['negotiation', 'crm'], active: true },
  { id: 2, name: 'Bob Chen', departmentId: 1, title: 'Account Executive', hiredAt: '2021-06-15', salary: 90000, skills: ['crm', 'forecasting'], active: true },
  { id: 3, name: 'Carol White', departmentId: 1, title: 'Sales Manager', hiredAt: '2020-01-10', salary: 120000, skills: ['leadership', 'crm'], active: true },
  { id: 4, name: 'Dan Lee', departmentId: 2, title: 'Engineer', hiredAt: '2023-02-01', salary: 130000, skills: ['typescript', 'sql'], active: true },
  { id: 5, name: 'Eve Moss', departmentId: 2, title: 'Engineer', hiredAt: '2022-08-20', salary: 125000, skills: ['python', 'sql'], active: true },
  { id: 6, name: 'Frank Ito', departmentId: 3, title: 'Support Agent', hiredAt: '2023-05-05', salary: 60000, skills: ['support'], active: true },
  { id: 7, name: 'Grace Hall', departmentId: 3, title: 'Support Agent', hiredAt: '2021-11-11', salary: 62000, skills: ['support', 'crm'], active: false },
  { id: 8, name: 'Heidi Vos', departmentId: 4, title: 'Accountant', hiredAt: '2020-09-09', salary: 95000, skills: ['excel', 'accounting'], active: true },
  { id: 9, name: 'Ivan Petro', departmentId: 4, title: 'Controller', hiredAt: '2019-04-04', salary: 140000, skills: ['accounting'], active: true },
  { id: 10, name: 'Judy Kim', departmentId: 5, title: 'Marketer', hiredAt: '2023-07-07', salary: 70000, skills: ['seo', 'content'], active: true },
  { id: 11, name: 'Karl Ohm', departmentId: 1, title: 'Account Executive', hiredAt: '2024-01-15', salary: 80000, skills: ['crm'], active: false },
  { id: 12, name: 'Lena Fox', departmentId: 2, title: 'Engineer', hiredAt: '2024-03-03', salary: 118000, skills: ['go', 'sql'], active: true },
];

const customers: Row[] = [
  { id: 1, name: 'Acme Corp', region: 'West', tier: 'gold', email: 'ada@acme.com', createdAt: ts('2024-01-15'), creditLimit: 100000, metadata: { industry: 'manufacturing' }, active: true },
  { id: 2, name: 'Globex LLC', region: 'East', tier: 'silver', email: 'ops@globex.com', createdAt: ts('2024-02-20'), creditLimit: 50000, metadata: { industry: 'energy' }, active: true },
  { id: 3, name: 'Initech', region: 'West', tier: 'bronze', email: 'hi@initech.com', createdAt: ts('2024-03-05'), creditLimit: 25000, metadata: null, active: true },
  { id: 4, name: 'Umbrella Co', region: 'EU', tier: 'gold', email: 'contact@umbrella.eu', createdAt: ts('2023-11-11'), creditLimit: 200000, metadata: { industry: 'pharma' }, active: true },
  { id: 5, name: 'Hooli', region: 'West', tier: 'silver', email: 'team@hooli.com', createdAt: ts('2024-05-01'), creditLimit: 75000, metadata: { industry: 'tech' }, active: true },
  { id: 6, name: 'Stark Industries', region: 'East', tier: 'gold', email: 'tony@stark.com', createdAt: ts('2023-09-09'), creditLimit: 300000, metadata: { industry: 'defense' }, active: true },
  { id: 7, name: 'Acme Corporation', region: 'EU', tier: 'silver', email: 'eu@acme-corp.eu', createdAt: ts('2024-06-18'), creditLimit: 60000, metadata: { industry: 'manufacturing' }, active: true },
  { id: 8, name: 'Wayne Enterprises', region: 'East', tier: 'gold', email: 'bruce@wayne.com', createdAt: ts('2023-12-25'), creditLimit: 250000, metadata: null, active: true },
  { id: 9, name: 'Cyberdyne', region: 'West', tier: 'bronze', email: 'sky@cyberdyne.com', createdAt: ts('2024-04-14'), creditLimit: 15000, metadata: { industry: 'robotics' }, active: false },
  { id: 10, name: 'Soylent Corp', region: 'EU', tier: 'silver', email: 'green@soylent.eu', createdAt: ts('2024-07-22'), creditLimit: 40000, metadata: null, active: true },
  { id: 11, name: 'Tyrell Corp', region: 'West', tier: 'bronze', email: 'eye@tyrell.com', createdAt: ts('2024-08-30'), creditLimit: 20000, metadata: { industry: 'biotech' }, active: true },
  { id: 12, name: 'Vandelay Ind', region: 'East', tier: 'bronze', email: 'art@vandelay.com', createdAt: ts('2025-01-05'), creditLimit: 10000, metadata: null, active: true },
];

// Contacts: 1–2 per customer; customer 12 has one. `isPrimary` marks the main one.
const contacts: Row[] = [
  { id: 1, customerId: 1, name: 'Ada Byron', email: 'ada@acme.com', phone: '555-0101', isPrimary: true, notes: 'Prefers email contact; decision maker' },
  { id: 2, customerId: 1, name: 'Charles B', email: 'charles@acme.com', phone: null, isPrimary: false, notes: 'Accounts payable' },
  { id: 3, customerId: 2, name: 'Grace Ops', email: 'ops@globex.com', phone: '555-0102', isPrimary: true, notes: 'Renewal in Q3' },
  { id: 4, customerId: 3, name: 'Peter G', email: 'peter@initech.com', phone: null, isPrimary: true, notes: null },
  { id: 5, customerId: 4, name: 'Alice U', email: 'alice@umbrella.eu', phone: '555-0104', isPrimary: true, notes: 'Large pharma account; net-60 terms' },
  { id: 6, customerId: 5, name: 'Richard H', email: 'richard@hooli.com', phone: '555-0105', isPrimary: true, notes: 'Technical buyer' },
  { id: 7, customerId: 6, name: 'Tony S', email: 'tony@stark.com', phone: '555-0106', isPrimary: true, notes: 'VIP; escalate quickly' },
  { id: 8, customerId: 6, name: 'Pepper P', email: 'pepper@stark.com', phone: null, isPrimary: false, notes: 'Executive assistant' },
  { id: 9, customerId: 7, name: 'Euan A', email: 'eu@acme-corp.eu', phone: '555-0107', isPrimary: true, notes: 'EU branch; not the same as Acme Corp' },
  { id: 10, customerId: 8, name: 'Bruce W', email: 'bruce@wayne.com', phone: '555-0108', isPrimary: true, notes: 'Prefers phone contact' },
  { id: 11, customerId: 9, name: 'Miles D', email: 'sky@cyberdyne.com', phone: null, isPrimary: true, notes: 'Account inactive' },
  { id: 12, customerId: 10, name: 'Green S', email: 'green@soylent.eu', phone: '555-0110', isPrimary: true, notes: null },
  { id: 13, customerId: 11, name: 'Eldon T', email: 'eye@tyrell.com', phone: '555-0111', isPrimary: true, notes: 'Prefers email newsletters' },
  { id: 14, customerId: 12, name: 'Art V', email: 'art@vandelay.com', phone: null, isPrimary: true, notes: 'Importer/exporter; no orders yet' },
  { id: 15, customerId: 2, name: 'Second Globex', email: 'two@globex.com', phone: null, isPrimary: false, notes: 'Secondary buyer' },
  { id: 16, customerId: 4, name: 'Backup Umbrella', email: 'backup@umbrella.eu', phone: null, isPrimary: false, notes: null },
];

const vendors: Row[] = [
  { id: 1, name: 'Shenzhen Parts', region: 'APAC', rating: 4.5, active: true },
  { id: 2, name: 'EuroSupply GmbH', region: 'EU', rating: 4.1, active: true },
  { id: 3, name: 'Midwest Materials', region: 'West', rating: 3.8, active: true },
  { id: 4, name: 'Acme Supplies', region: 'East', rating: 4.0, active: true },
  { id: 5, name: 'Global Widgets', region: 'APAC', rating: 2.9, active: false },
  { id: 6, name: 'Northwind Traders', region: 'East', rating: 4.7, active: true },
];

const products: Row[] = [
  { id: 1, name: 'Aurora Laptop', categoryId: 5, sku: 'SKU-L1', price: 1200, weight: 1.8, tags: ['electronics', 'portable'], attributes: { ram: 16 }, active: true },
  { id: 2, name: 'Nimbus Phone', categoryId: 6, sku: 'SKU-P1', price: 800, weight: 0.2, tags: ['electronics', 'mobile'], attributes: { '5g': true }, active: true },
  { id: 3, name: 'Ergo Chair', categoryId: 7, sku: 'SKU-C1', price: 350, weight: 12.5, tags: ['furniture', 'office'], attributes: { color: 'black' }, active: true },
  { id: 4, name: 'Standing Desk', categoryId: 8, sku: 'SKU-D1', price: 600, weight: 30, tags: ['furniture', 'office'], attributes: { adjustable: true }, active: true },
  { id: 5, name: 'Paper Ream', categoryId: 3, sku: 'SKU-O1', price: 8, weight: 2.5, tags: ['office', 'paper'], attributes: null, active: true },
  { id: 6, name: 'Ink Cartridge', categoryId: 3, sku: 'SKU-O2', price: 25, weight: 0.3, tags: ['office'], attributes: null, active: true },
  { id: 7, name: 'Aurora Laptop', categoryId: 5, sku: 'SKU-L2', price: 1500, weight: 2.0, tags: ['electronics', 'portable', 'pro'], attributes: { ram: 32 }, active: true },
  { id: 8, name: 'Cloud IDE License', categoryId: 4, sku: 'SKU-S1', price: 300, weight: null, tags: ['software'], attributes: { seats: 1 }, active: true },
  { id: 9, name: 'Analytics Suite', categoryId: 4, sku: 'SKU-S2', price: 900, weight: null, tags: ['software', 'data'], attributes: { seats: 5 }, active: true },
  { id: 10, name: 'Mini Phone', categoryId: 6, sku: 'SKU-P2', price: 500, weight: 0.15, tags: ['electronics', 'mobile'], attributes: { '5g': false }, active: false },
  { id: 11, name: 'Bookshelf', categoryId: 2, sku: 'SKU-F1', price: 220, weight: 22, tags: ['furniture'], attributes: null, active: true },
  { id: 12, name: 'Desk Lamp', categoryId: 3, sku: 'SKU-O3', price: 45, weight: 1.1, tags: ['office', 'lighting'], attributes: null, active: true },
];

// Price list items: every product priced in USD; a subset also in EUR / GBP.
const priceListItems: Row[] = [];
{
  let pid = 1;
  const eurProducts = new Set([1, 2, 4, 8, 9]);
  const gbpProducts = new Set([1]);
  for (const p of products) {
    const base = p.price as number;
    priceListItems.push({ id: pid++, productId: p.id, currencyCode: 'USD', price: base, minQty: 1 });
    if (eurProducts.has(p.id as number)) {
      priceListItems.push({ id: pid++, productId: p.id, currencyCode: 'EUR', price: Math.round(base * 1.08 * 100) / 100, minQty: 1 });
    }
    if (gbpProducts.has(p.id as number)) {
      priceListItems.push({ id: pid++, productId: p.id, currencyCode: 'GBP', price: Math.round(base * 1.27 * 100) / 100, minQty: 1 });
    }
  }
}

const warehouses: Row[] = [
  { id: 1, name: 'West DC', region: 'West', capacity: 100000 },
  { id: 2, name: 'East DC', region: 'East', capacity: 80000 },
  { id: 3, name: 'EU DC', region: 'EU', capacity: 60000 },
  { id: 4, name: 'Overflow', region: 'West', capacity: 20000 },
];

// Inventory: each product stocked at 1–2 warehouses, deterministic quantities.
const inventory: Row[] = [];
{
  let iid = 1;
  for (const p of products) {
    const n = p.id as number;
    const w1 = ((n - 1) % 3) + 1; // warehouse 1..3
    inventory.push({ id: iid++, productId: n, warehouseId: w1, quantity: 20 + n * 5, reorderLevel: 10 });
    if (n % 2 === 0) {
      inventory.push({ id: iid++, productId: n, warehouseId: 4, quantity: n * 2, reorderLevel: 5 });
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Sales orders — the trap-critical fact table (literal)
// ════════════════════════════════════════════════════════════════════════════

interface OrderSeed {
  id: number;
  customerId: number;
  salesRepId: number;
  currencyCode: string;
  status: string;
  orderedAt: string;
  total: number;
  notes: string | null;
}

const orderSeeds: OrderSeed[] = [
  { id: 1, customerId: 1, salesRepId: 1, currencyCode: 'USD', status: 'paid', orderedAt: '2026-01-10', total: 1200, notes: null },
  { id: 2, customerId: 1, salesRepId: 1, currencyCode: 'USD', status: 'paid', orderedAt: '2026-02-15', total: 800, notes: 'rush order' },
  { id: 3, customerId: 1, salesRepId: 2, currencyCode: 'USD', status: 'cancelled', orderedAt: '2026-02-20', total: 5000, notes: 'cancelled by customer' },
  { id: 4, customerId: 1, salesRepId: 1, currencyCode: 'USD', status: 'paid', orderedAt: '2026-03-01', total: 350, notes: null },
  { id: 5, customerId: 1, salesRepId: 1, currencyCode: 'USD', status: 'paid', orderedAt: '2026-04-01', total: 900, notes: 'just after Q1' },
  { id: 6, customerId: 2, salesRepId: 2, currencyCode: 'USD', status: 'open', orderedAt: '2026-01-22', total: 2000, notes: null },
  { id: 7, customerId: 2, salesRepId: 2, currencyCode: 'USD', status: 'paid', orderedAt: '2026-03-15', total: 600, notes: null },
  { id: 8, customerId: 3, salesRepId: 3, currencyCode: 'USD', status: 'refunded', orderedAt: '2026-02-05', total: 1500, notes: 'defective' },
  { id: 9, customerId: 4, salesRepId: 1, currencyCode: 'EUR', status: 'paid', orderedAt: '2026-01-30', total: 3000, notes: null },
  { id: 10, customerId: 4, salesRepId: 1, currencyCode: 'EUR', status: 'paid', orderedAt: '2026-03-20', total: 1200, notes: null },
  { id: 11, customerId: 5, salesRepId: 2, currencyCode: 'USD', status: 'open', orderedAt: '2026-02-11', total: 750, notes: null },
  { id: 12, customerId: 5, salesRepId: 3, currencyCode: 'USD', status: 'paid', orderedAt: '2026-03-28', total: 1100, notes: null },
  { id: 13, customerId: 6, salesRepId: 3, currencyCode: 'USD', status: 'paid', orderedAt: '2026-01-05', total: 4000, notes: 'VIP' },
  { id: 14, customerId: 6, salesRepId: 1, currencyCode: 'USD', status: 'paid', orderedAt: '2026-02-25', total: 2500, notes: null },
  { id: 15, customerId: 7, salesRepId: 2, currencyCode: 'EUR', status: 'paid', orderedAt: '2026-02-14', total: 900, notes: 'other Acme' },
  { id: 16, customerId: 7, salesRepId: 2, currencyCode: 'EUR', status: 'cancelled', orderedAt: '2026-03-10', total: 700, notes: null },
  { id: 17, customerId: 8, salesRepId: 3, currencyCode: 'USD', status: 'paid', orderedAt: '2026-01-18', total: 6000, notes: 'largest order' },
  { id: 18, customerId: 8, salesRepId: 1, currencyCode: 'USD', status: 'paid', orderedAt: '2026-03-30', total: 3200, notes: null },
  { id: 19, customerId: 9, salesRepId: 11, currencyCode: 'USD', status: 'draft', orderedAt: '2026-02-08', total: 500, notes: 'inactive customer' },
  { id: 20, customerId: 10, salesRepId: 2, currencyCode: 'EUR', status: 'paid', orderedAt: '2026-03-05', total: 1300, notes: null },
  { id: 21, customerId: 11, salesRepId: 3, currencyCode: 'USD', status: 'open', orderedAt: '2026-03-25', total: 450, notes: null },
  { id: 22, customerId: 1, salesRepId: 1, currencyCode: 'USD', status: 'paid', orderedAt: '2025-12-20', total: 1000, notes: 'prior year' },
  { id: 23, customerId: 6, salesRepId: 3, currencyCode: 'USD', status: 'paid', orderedAt: '2026-03-31', total: 2200, notes: 'last day of Q1' },
  { id: 24, customerId: 2, salesRepId: 2, currencyCode: 'USD', status: 'refunded', orderedAt: '2026-03-18', total: 300, notes: null },
];

const salesOrders: Row[] = orderSeeds.map((o) => ({
  id: o.id,
  customerId: o.customerId,
  salesRepId: o.salesRepId,
  currencyCode: o.currencyCode,
  status: o.status,
  orderedAt: o.orderedAt,
  createdAt: ts(o.orderedAt),
  total: o.total,
  notes: o.notes,
}));

// ════════════════════════════════════════════════════════════════════════════
// Sales order lines — has-many (multi-line orders = double-count trap)
// ════════════════════════════════════════════════════════════════════════════

const productPrice = new Map<number, number>(products.map((p) => [p.id as number, p.price as number]));
const salesOrderLines: Row[] = [];
{
  let lid = 1;
  // A small deterministic product rotation per order.
  const rotation = [1, 3, 5, 2, 4, 8, 11, 12, 6, 9, 7, 10];
  for (const o of orderSeeds) {
    const numLines = ((o.id - 1) % 3) + 1; // 1..3 lines
    for (let k = 0; k < numLines; k++) {
      const productId = rotation[(o.id + k) % rotation.length]!;
      const unitPrice = productPrice.get(productId)!;
      const quantity = 1 + ((o.id + k) % 3); // 1..3
      const discount = k === 0 && o.id % 4 === 0 ? 50 : 0;
      const lineTotal = unitPrice * quantity - discount;
      salesOrderLines.push({ id: lid++, orderId: o.id, productId, quantity, unitPrice, discount, lineTotal });
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Purchase orders + lines
// ════════════════════════════════════════════════════════════════════════════

const purchaseOrders: Row[] = [
  { id: 1, vendorId: 1, warehouseId: 1, status: 'received', orderedAt: '2026-01-08', total: 12000 },
  { id: 2, vendorId: 2, warehouseId: 3, status: 'received', orderedAt: '2026-01-20', total: 8000 },
  { id: 3, vendorId: 3, warehouseId: 1, status: 'sent', orderedAt: '2026-02-02', total: 5000 },
  { id: 4, vendorId: 1, warehouseId: 2, status: 'received', orderedAt: '2026-02-18', total: 15000 },
  { id: 5, vendorId: 4, warehouseId: 2, status: 'draft', orderedAt: '2026-03-01', total: 3000 },
  { id: 6, vendorId: 6, warehouseId: 2, status: 'sent', orderedAt: '2026-03-12', total: 9500 },
  { id: 7, vendorId: 2, warehouseId: 3, status: 'received', orderedAt: '2026-03-22', total: 6200 },
  { id: 8, vendorId: 5, warehouseId: 4, status: 'cancelled', orderedAt: '2026-02-27', total: 2100 },
  { id: 9, vendorId: 3, warehouseId: 1, status: 'received', orderedAt: '2026-03-29', total: 7300 },
  { id: 10, vendorId: 6, warehouseId: 2, status: 'sent', orderedAt: '2026-03-31', total: 4400 },
];

const purchaseOrderLines: Row[] = [];
{
  let plid = 1;
  const rotation = [1, 2, 4, 11, 3, 6, 5, 12];
  for (const po of purchaseOrders) {
    const numLines = ((po.id as number) % 3) + 1;
    for (let k = 0; k < numLines; k++) {
      const productId = rotation[((po.id as number) + k) % rotation.length]!;
      const unitCost = Math.round((productPrice.get(productId)! * 0.6) * 100) / 100;
      const quantity = 5 + (((po.id as number) + k) % 4) * 5;
      purchaseOrderLines.push({ id: plid++, poId: po.id, productId, quantity, unitCost });
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Invoices (paid/open orders) + payments (some split into two)
// ════════════════════════════════════════════════════════════════════════════

/** Add days to a `YYYY-MM-DD` date, returning `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const invoices: Row[] = [];
const payments: Row[] = [];
{
  let invId = 1;
  let payId = 1;
  for (const o of orderSeeds) {
    if (o.status !== 'paid' && o.status !== 'open') continue;
    const issuedAt = addDays(o.orderedAt, 2);
    const dueAt = addDays(o.orderedAt, 32);
    // open orders → unpaid; a couple of them overdue; paid orders → paid.
    const status = o.status === 'paid' ? 'paid' : o.id === 6 ? 'overdue' : 'unpaid';
    const inv = {
      id: invId++,
      salesOrderId: o.id,
      customerId: o.customerId,
      amount: o.total,
      issuedAt,
      dueAt,
      status,
      createdAt: ts(issuedAt),
    };
    invoices.push(inv);
    if (status === 'paid') {
      const paidAt = addDays(o.orderedAt, 10);
      // Orders 13 and 17 are settled in TWO partial payments (double-row trap).
      if (o.id === 13 || o.id === 17) {
        const half = o.total / 2;
        payments.push({ id: payId++, invoiceId: inv.id, customerId: o.customerId, amount: half, method: 'wire', paidAt, createdAt: ts(paidAt) });
        payments.push({ id: payId++, invoiceId: inv.id, customerId: o.customerId, amount: half, method: 'wire', paidAt: addDays(paidAt, 5), createdAt: ts(addDays(paidAt, 5)) });
      } else {
        const method = o.id % 3 === 0 ? 'card' : o.id % 3 === 1 ? 'wire' : 'check';
        payments.push({ id: payId++, invoiceId: inv.id, customerId: o.customerId, amount: o.total, method, paidAt, createdAt: ts(paidAt) });
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Shipments (some pending with NULL shippedAt) + returns
// ════════════════════════════════════════════════════════════════════════════

const shipments: Row[] = [];
{
  let sid = 1;
  for (const o of orderSeeds) {
    if (o.status === 'draft' || o.status === 'cancelled') continue;
    // Refunded/open partly unshipped; paid mostly shipped/delivered.
    let status: string;
    let shippedAt: string | null;
    if (o.status === 'open') {
      status = 'pending';
      shippedAt = null;
    } else if (o.id % 5 === 0) {
      status = 'pending';
      shippedAt = null; // a paid order still awaiting shipment (trap inside date range)
    } else {
      status = o.id % 2 === 0 ? 'delivered' : 'shipped';
      shippedAt = addDays(o.orderedAt, 3);
    }
    const carrier = shippedAt ? (o.id % 2 === 0 ? 'UPS' : 'FedEx') : null;
    const trackingNumber = shippedAt ? `TRK${1000 + o.id}` : null;
    shipments.push({ id: sid++, salesOrderId: o.id, status, shippedAt, carrier, trackingNumber });
  }
}

const salesReturns: Row[] = [
  { id: 1, salesOrderId: 8, customerId: 3, reason: 'defective', amount: 1500, returnedAt: '2026-02-12', restocked: false },
  { id: 2, salesOrderId: 24, customerId: 2, reason: 'wrong item', amount: 300, returnedAt: '2026-03-25', restocked: true },
  { id: 3, salesOrderId: 2, customerId: 1, reason: 'partial return', amount: 200, returnedAt: '2026-02-28', restocked: true },
  { id: 4, salesOrderId: 13, customerId: 6, reason: 'damaged in transit', amount: 400, returnedAt: '2026-01-20', restocked: false },
  { id: 5, salesOrderId: 20, customerId: 10, reason: 'changed mind', amount: 1300, returnedAt: '2026-03-15', restocked: true },
];

// ════════════════════════════════════════════════════════════════════════════
// Emit
// ════════════════════════════════════════════════════════════════════════════

write('currencies', currencies);
write('taxRates', taxRates);
write('categories', categories);
write('departments', departments);
write('employees', employees);
write('customers', customers);
write('contacts', contacts);
write('vendors', vendors);
write('products', products);
write('priceListItems', priceListItems);
write('warehouses', warehouses);
write('inventory', inventory);
write('salesOrders', salesOrders);
write('salesOrderLines', salesOrderLines);
write('purchaseOrders', purchaseOrders);
write('purchaseOrderLines', purchaseOrderLines);
write('invoices', invoices);
write('payments', payments);
write('shipments', shipments);
write('salesReturns', salesReturns);

const counts: Record<string, number> = {
  currencies: currencies.length,
  taxRates: taxRates.length,
  categories: categories.length,
  departments: departments.length,
  employees: employees.length,
  customers: customers.length,
  contacts: contacts.length,
  vendors: vendors.length,
  products: products.length,
  priceListItems: priceListItems.length,
  warehouses: warehouses.length,
  inventory: inventory.length,
  salesOrders: salesOrders.length,
  salesOrderLines: salesOrderLines.length,
  purchaseOrders: purchaseOrders.length,
  purchaseOrderLines: purchaseOrderLines.length,
  invoices: invoices.length,
  payments: payments.length,
  shipments: shipments.length,
  salesReturns: salesReturns.length,
};
// eslint-disable-next-line no-console
console.log('Generated integration data:', JSON.stringify(counts));
