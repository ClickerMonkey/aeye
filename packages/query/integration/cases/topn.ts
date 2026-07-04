/**
 * Top-N cases: ORDER BY + LIMIT, compared ORDER-SENSITIVELY (`match: 'ordered'`).
 */
import { e } from '../model';
import type { EvalCase } from './types';

export const topNCases: EvalCase[] = [
  {
    id: 'topn-largest-orders',
    category: 'top-n',
    request: 'What are the 3 largest sales orders by total? Return the order id and total, largest first.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
      from: { kind: 'type', type: 'salesOrder' },
      order: [
        { expr: e.ref('salesOrder', 'total').toJSON(), dir: 'desc' },
        { expr: e.ref('salesOrder', 'id').toJSON(), dir: 'asc' },
      ],
      limit: 3,
    }),
    match: 'ordered',
    note: 'Order 17 (6000) leads; the cancelled order 3 (5000) is a distractor a status-unaware top-N still ranks.',
  },
  {
    id: 'topn-top-customers-by-revenue',
    category: 'top-n',
    request:
      'Who are the top 2 customers by total PAID revenue? Return the customer id and revenue, highest first.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.path('salesOrder', 'customerId', 'id').toJSON(), as: 'customerId' },
        { expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'revenue' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
      groupBy: [e.path('salesOrder', 'customerId', 'id').toJSON()],
      order: [
        { expr: e.output('revenue').toJSON(), dir: 'desc' },
        { expr: e.output('customerId').toJSON(), dir: 'asc' },
      ],
      limit: 2,
    }),
    match: 'ordered',
    note: 'Combines group-by + order + limit; the paid-only filter and the sort order both matter.',
  },
];
