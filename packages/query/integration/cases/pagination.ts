/**
 * Pagination / ordering cases: OFFSET + LIMIT (a middle page), a multi-key
 * ORDER BY, and explicit NULLS placement on the nullable `shipment.shippedAt`.
 * All compared ORDER-SENSITIVELY — the row ORDER is the whole point. Structure:
 * an ORDER BY plus the LIMIT / OFFSET that windows the page.
 */
import { e } from '../model';
import { a } from './assert';
import type { EvalCase } from './types';

export const paginationCases: EvalCase[] = [
  {
    id: 'page-offset-limit-middle',
    category: 'pagination',
    request:
      'Rank ALL sales orders by total (largest first) and return the 4th, 5th, and 6th orders — skip the top 3 — as order id and total.',
    note: 'OFFSET 3 + LIMIT 3 selects the middle window [18=3200, 9=3000, 14=2500]; the top three (17=6000, 3=5000, 13=4000) are skipped. A LIMIT without the OFFSET returns the wrong page.',
    assert: [
      a.from('salesOrder'),
      a.orderBy({ by: 'total', dir: 'desc' }),
      a.limit(3),
      a.offset(3),
      a.resultOf(
        () => ({
          kind: 'select',
          fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
          from: { kind: 'type', type: 'salesOrder' },
          order: [
            { expr: e.ref('salesOrder', 'total').toJSON(), dir: 'desc' },
            { expr: e.ref('salesOrder', 'id').toJSON(), dir: 'asc' },
          ],
          limit: 3,
          offset: 3,
        }),
        { match: 'ordered' },
      ),
    ],
  },
  {
    id: 'page-multikey-status-total',
    category: 'pagination',
    request:
      'Order sales orders by status alphabetically (ascending), and within each status by total from largest to smallest, breaking ties by ascending id; return the first 6 as id, status, and total.',
    note: 'Three-key sort: cancelled(3=5000, 16=700), draft(19=500), open(6=2000, 11=750, 21=450). The secondary total-DESC and tertiary id-ASC keys are both load-bearing within the cancelled and open groups.',
    assert: [
      a.from('salesOrder'),
      a.orderBy({ by: 'status', dir: 'asc' }),
      a.orderBy({ by: 'total', dir: 'desc' }),
      a.limit(6),
      a.resultOf(
        () => ({
          kind: 'select',
          fields: [
            { expr: e.ref('salesOrder', 'id').toJSON() },
            { expr: e.ref('salesOrder', 'status').toJSON() },
            { expr: e.ref('salesOrder', 'total').toJSON() },
          ],
          from: { kind: 'type', type: 'salesOrder' },
          order: [
            { expr: e.ref('salesOrder', 'status').toJSON(), dir: 'asc' },
            { expr: e.ref('salesOrder', 'total').toJSON(), dir: 'desc' },
            { expr: e.ref('salesOrder', 'id').toJSON(), dir: 'asc' },
          ],
          limit: 6,
        }),
        { match: 'ordered' },
      ),
    ],
  },
  {
    id: 'page-nulls-first-shippedat',
    category: 'pagination',
    request:
      'List shipments by shipped date from newest to oldest, but place the not-yet-shipped ones (no shipped date) FIRST, ordered by ascending id; return the first 8 as id and shipped date.',
    note: 'NULLS FIRST forces the 7 unshipped rows (ids 4,5,9,10,14,17,18, id-ASC) ahead of any date, so the 8th row is the single latest-dated shipment (20 → 2026-04-03). Default NULLS placement (last for DESC) would instead return the 8 newest dated shipments.',
    assert: [
      a.from('shipment'),
      a.orderBy({ by: 'shippedAt', dir: 'desc' }),
      a.limit(8),
      a.resultOf(
        () => ({
          kind: 'select',
          fields: [
            { expr: e.ref('shipment', 'id').toJSON() },
            { expr: e.ref('shipment', 'shippedAt').toJSON() },
          ],
          from: { kind: 'type', type: 'shipment' },
          order: [
            { expr: e.ref('shipment', 'shippedAt').toJSON(), dir: 'desc', nulls: 'first' },
            { expr: e.ref('shipment', 'id').toJSON(), dir: 'asc' },
          ],
          limit: 8,
        }),
        { match: 'ordered' },
      ),
    ],
  },
];
