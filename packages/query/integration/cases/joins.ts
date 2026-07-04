/**
 * Relation-path / multi-hop join cases. The oracle reaches across a belongs-to
 * relation via `e.path(...)`; a wrong join grain or the wrong key would diverge.
 */
import { e } from '../model';
import type { EvalCase } from './types';

export const joinCases: EvalCase[] = [
  {
    id: 'join-orders-eu-customers',
    category: 'join',
    request: 'List the id of every sales order placed by a customer in the EU region.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.path('salesOrder', 'customer', 'region'), e.value('EU')).toJSON()],
    }),
    note: 'Requires hopping salesOrder→customer.region; West/East customers are distractors.',
  },
  {
    id: 'join-products-in-software',
    category: 'join',
    request: "List the id and name of products in the 'Software' category.",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
      from: { kind: 'type', type: 'product' },
      where: [e.eq(e.path('product', 'category', 'name'), e.value('Software')).toJSON()],
    }),
    note: 'Category must be matched by NAME across the relation; subcategories (Laptops/Phones) are distractors.',
  },
  {
    id: 'join-orders-by-rep-name',
    category: 'join',
    request: "Which sales orders were handled by the sales rep named 'Carol White'? Return the order id.",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.path('salesOrder', 'salesRep', 'name'), e.value('Carol White')).toJSON()],
    }),
    note: 'Joins salesOrder→employee by rep name; orders by other reps are distractors.',
  },
  {
    id: 'join-subcategories-electronics',
    category: 'join',
    request: "List the id and name of categories whose parent category is 'Electronics'.",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('category', 'id').toJSON() }, { expr: e.ref('category', 'name').toJSON() }],
      from: { kind: 'type', type: 'category' },
      where: [e.eq(e.path('category', 'parent', 'name'), e.value('Electronics')).toJSON()],
    }),
    note: 'Self-join category→parent by name — only Laptops (5) and Phones (6); the Furniture subcategories (Chairs/Desks) and the top-level roots are distractors.',
  },
  {
    id: 'join-lines-eu-3hop',
    category: 'join',
    request: 'List the id of every sales order LINE that belongs to an order placed by a customer in the EU region.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrderLine', 'id').toJSON() }],
      from: { kind: 'type', type: 'salesOrderLine' },
      where: [e.eq(e.path('salesOrderLine', 'order', 'customer', 'region'), e.value('EU')).toJSON()],
    }),
    note: 'Three-hop path line→order→customer→region; West/East orders and their lines are distractors a shallower join would include.',
  },
  {
    id: 'join-contacts-count-multi',
    category: 'join',
    request:
      'Which customers have more than one contact? Return the customer id and the number of contacts.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.path('contact', 'customer', 'id').toJSON(), as: 'customer' },
        { expr: e.countStar().toJSON(), as: 'contactCount' },
      ],
      from: { kind: 'type', type: 'contact' },
      groupBy: [e.path('contact', 'customer', 'id').toJSON()],
      having: [e.gt(e.countStar(), e.value(1)).toJSON()],
    }),
    note: 'Inverse has-many aggregation (customer.contacts) — only customers 1,2,4,6 have 2 contacts; single-contact customers are excluded by the HAVING.',
  },
  {
    id: 'join-distinct-products-west-warehouses',
    category: 'join',
    request: 'How many DISTINCT products are stocked in warehouses located in the West region?',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.agg('count', { value: e.path('inventory', 'product', 'id') }, true).toJSON(), as: 'productCount' },
      ],
      from: { kind: 'type', type: 'inventory' },
      where: [e.eq(e.path('inventory', 'warehouse', 'region'), e.value('West')).toJSON()],
    }),
    note: 'Fan-out dedup across the product×warehouse junction: West holds two warehouses (West DC, Overflow) whose stock lists OVERLAP on products 4 and 10, so COUNT(DISTINCT product)=8 while a plain row count (10) double-counts the shared products.',
  },
  {
    id: 'join-software-line-quantity',
    category: 'join',
    request: "What is the total quantity ordered (sum of line quantities) across all sales-order lines for products in the 'Software' category?",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.sum(e.ref('salesOrderLine', 'quantity')).toJSON(), as: 'totalQty' }],
      from: { kind: 'type', type: 'salesOrderLine' },
      where: [e.eq(e.path('salesOrderLine', 'product', 'category', 'name'), e.value('Software')).toJSON()],
    }),
    note: 'Aggregation at the LINE grain across a two-hop line→product→category path: only Software products 8 & 9 (qty 15 + 4 = 19) count; summing at the order grain or omitting the category hop changes the total.',
  },
  {
    id: 'join-products-priced-in-eur',
    category: 'join',
    request: 'List the distinct id and name of products that have a price-list entry denominated in EUR.',
    oracle: () => ({
      kind: 'select',
      distinct: true,
      fields: [
        { expr: e.path('priceListItem', 'product', 'id').toJSON(), as: 'id' },
        { expr: e.path('priceListItem', 'product', 'name').toJSON(), as: 'name' },
      ],
      from: { kind: 'type', type: 'priceListItem' },
      where: [e.eq(e.path('priceListItem', 'currency', 'code'), e.value('EUR')).toJSON()],
    }),
    note: 'Many-to-many product×currency junction filtered by currency code: products 1,2,4,8,9 have EUR entries; USD-only products and the single GBP entry (also product 1, deduped by DISTINCT) are the distractors.',
  },
  {
    id: 'join-return-matching-invoice',
    category: 'join',
    request:
      'For every sales return that has a matching invoice (the invoice for the SAME sales order AND the same customer), return the return id and that invoice amount.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesReturn', 'id').toJSON(), as: 'id' },
        { expr: e.path('salesReturn', 'invoice', 'amount').toJSON(), as: 'invoiceAmount' },
      ],
      from: { kind: 'type', type: 'salesReturn' },
      where: [e.notNull(e.path('salesReturn', 'invoice', 'id')).toJSON()],
    }),
    note: 'Composite-FK relation: salesReturn.invoice joins on BOTH sales_order_id AND customer_id. Returns 3 (order 2 → 800), 4 (order 13 → 4000), 5 (order 20 → 1300) match; returns 1 & 2 are on REFUNDED orders (8, 24) that were never invoiced, so their matching invoice is null and they drop out. Matching on only one of the two key columns would keep them.',
  },
];
