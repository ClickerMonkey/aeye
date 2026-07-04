/**
 * Aggregate cases (sum money / count / avg). Scalar answers — one row, one (or
 * few) value(s). Traps: non-paid orders that must be excluded from revenue, and
 * a multi-line order that a wrong join grain would double-count.
 */
import { e } from '../model';
import type { EvalCase } from './types';
import type { QueryDef } from '../../src/index';

export const aggregateCases: EvalCase[] = [
  {
    id: 'agg-total-paid-revenue',
    category: 'aggregate',
    request: 'What is the total value (sum of totals) of all PAID sales orders?',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'revenue' }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
    }),
    note: 'Cancelled / refunded / draft / open orders must be excluded; a missing status filter inflates the sum.',
  },
  {
    id: 'agg-count-orders-customer1',
    category: 'aggregate',
    request: 'How many sales orders (of any status) has the customer with id 1 placed?',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.countStar().toJSON(), as: 'orderCount' }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.path('salesOrder', 'customer', 'id'), e.value(1)).toJSON()],
    }),
    note: 'Customer 7 ("Acme Corporation") is a name-collision distractor; the 2025 order still counts.',
  },
  {
    id: 'agg-avg-paid-order',
    category: 'aggregate',
    request: 'What is the average total of the paid sales orders?',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.avg(e.ref('salesOrder', 'total')).toJSON(), as: 'avgTotal' }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
    }),
    floatTolerance: 1e-6,
    note: 'Average over PAID orders only; including other statuses changes both the count and the mean.',
  },
  {
    id: 'agg-line-total-order17',
    category: 'aggregate',
    request: 'What is the combined line-item total (sum of lineTotal) for sales order 17?',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.sum(e.ref('salesOrderLine', 'lineTotal')).toJSON(), as: 'lineRevenue' }],
      from: { kind: 'type', type: 'salesOrderLine' },
      where: [e.eq(e.path('salesOrderLine', 'order', 'id'), e.value(17)).toJSON()],
    }),
    note: 'Order 17 has several lines; summing salesOrder.total across a lines join would double-count.',
  },
  {
    id: 'agg-paid-eur-revenue',
    category: 'aggregate',
    request:
      'What is the total value (sum of totals) of the PAID sales orders that were placed in EUR?',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'revenue' }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [
        e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON(),
        e.eq(e.path('salesOrder', 'currency', 'code'), e.value('EUR')).toJSON(),
      ],
    }),
    note: 'Currency-mixed trap: only the paid EUR orders (9,10,15,20) contribute (6400); ignoring the currency hop and summing all paid orders wildly overstates it.',
  },
  {
    id: 'agg-minmax-paid-total',
    category: 'aggregate',
    request: 'Among PAID sales orders, what are the smallest and the largest order totals?',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.min(e.ref('salesOrder', 'total')).toJSON(), as: 'minTotal' },
        { expr: e.max(e.ref('salesOrder', 'total')).toJSON(), as: 'maxTotal' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
    }),
    note: 'min/max over PAID only: min=350 (order 4), max=6000 (order 17). The refunded order 24 (300) would lower the min and the cancelled order 3 (5000) is a max distractor — both must be excluded by the status filter.',
  },
  {
    id: 'agg-argmax-top-product-revenue',
    category: 'aggregate',
    request:
      'Which single product has the highest total line revenue (sum of lineTotal across all sales-order lines)? Return the product id and that revenue.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.path('salesOrderLine', 'product', 'id').toJSON(), as: 'product' },
        { expr: e.sum(e.ref('salesOrderLine', 'lineTotal')).toJSON(), as: 'revenue' },
      ],
      from: { kind: 'type', type: 'salesOrderLine' },
      groupBy: [e.path('salesOrderLine', 'product', 'id').toJSON()],
      order: [
        { expr: e.output('revenue').toJSON(), dir: 'desc' },
        { expr: e.output('product').toJSON(), dir: 'asc' },
      ],
      limit: 1,
    }),
    match: 'ordered',
    note: 'Argmax via GROUP BY + ORDER BY revenue DESC + LIMIT 1: product 7 leads at 12000. max(lineTotal) alone (3000) answers a different question — the argmax needs the grouped sum then the top row.',
  },
  {
    id: 'agg-nested-max-customer-revenue',
    category: 'aggregate',
    request: 'What is the highest total PAID revenue booked by any single customer?',
    oracle: () => {
      const perCustomer: QueryDef = {
        kind: 'select',
        fields: [
          { expr: e.path('salesOrder', 'customer', 'id').toJSON(), as: 'cid' },
          { expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'rev' },
        ],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
        groupBy: [e.path('salesOrder', 'customer', 'id').toJSON()],
      };
      return {
        kind: 'select',
        fields: [{ expr: e.max(e.ref('perCustomer', 'rev')).toJSON(), as: 'maxRev' }],
        from: { kind: 'subquery', query: perCustomer, as: 'perCustomer' },
      };
    },
    note: 'A nested aggregate: max() OVER the per-customer grouped sums from a subquery source. The answer is 9200 (customer 8), NOT max(total)=6000 — you must group-then-max, not max a single order.',
  },
  {
    id: 'agg-having-avg-not-in-select',
    category: 'aggregate',
    request:
      'Among PAID sales orders, which customers have an AVERAGE paid-order total above 2000? Return the customer id and their paid-order COUNT (not the average).',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.path('salesOrder', 'customer', 'id').toJSON(), as: 'cid' },
        { expr: e.countStar().toJSON(), as: 'orderCount' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
      groupBy: [e.path('salesOrder', 'customer', 'id').toJSON()],
      having: [e.gt(e.avg(e.ref('salesOrder', 'total')), e.value(2000)).toJSON()],
    }),
    note: 'HAVING references avg(total) which is NOT in the SELECT list (only the count is): customers 4 (avg 2100, cnt 2), 6 (avg 2900, cnt 3), 8 (avg 4600, cnt 2) qualify. Big-count-but-low-avg customer 1 (avg 850) is the trap.',
  },
];
