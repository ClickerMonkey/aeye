/**
 * GROUP BY (+ HAVING) cases. Multi-row grouped answers compared as a SET.
 */
import { e } from '../model';
import type { EvalCase } from './types';

export const groupByCases: EvalCase[] = [
  {
    id: 'group-revenue-by-region',
    category: 'group-by',
    request: 'Total paid sales-order revenue grouped by the customer region. Return region and revenue.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.path('salesOrder', 'customer', 'region').toJSON(), as: 'region' },
        { expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'revenue' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
      groupBy: [e.path('salesOrder', 'customer', 'region').toJSON()],
    }),
    note: 'Groups across a relation and filters status; non-paid orders must not contribute to any region.',
  },
  {
    id: 'group-orders-by-status',
    category: 'group-by',
    request: 'How many sales orders are in each status? Return the status and the count.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesOrder', 'status').toJSON() },
        { expr: e.countStar().toJSON(), as: 'orderCount' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      groupBy: [e.ref('salesOrder', 'status').toJSON()],
    }),
    note: 'Every status bucket (draft/open/paid/cancelled/refunded) must appear with its exact count.',
  },
  {
    id: 'group-having-repeat-customers',
    category: 'group-by',
    request:
      'Which customers have placed more than 2 sales orders? Return the customer id and the order count.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.path('salesOrder', 'customer', 'id').toJSON(), as: 'customer' },
        { expr: e.countStar().toJSON(), as: 'orderCount' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      groupBy: [e.path('salesOrder', 'customer', 'id').toJSON()],
      having: [e.gt(e.countStar(), e.value(2)).toJSON()],
    }),
    note: 'HAVING must use a strict > 2; customers with exactly 2 orders and the order-less customer 12 are excluded.',
  },
  {
    id: 'group-having-two-aggregates',
    category: 'group-by',
    request:
      'Among paid sales orders, which customers have at least 2 paid orders AND a total paid revenue under 5000? Return the customer id, order count, and revenue.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.path('salesOrder', 'customer', 'id').toJSON(), as: 'cid' },
        { expr: e.countStar().toJSON(), as: 'cnt' },
        { expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'rev' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
      groupBy: [e.path('salesOrder', 'customer', 'id').toJSON()],
      having: [
        e.gte(e.countStar(), e.value(2)).toJSON(),
        e.lt(e.sum(e.ref('salesOrder', 'total')), e.value(5000)).toJSON(),
      ],
    }),
    note: 'BOTH aggregate conditions are required: count≥2 alone also keeps big spenders 6 & 8 (rev>5000); revenue<5000 alone keeps single-order customers — only customers 1 and 4 satisfy both.',
  },
];
