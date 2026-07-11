/**
 * Date-range / boundary cases. Date fields compare against `makeDate(...)`
 * (date-typed); rows sit deliberately JUST inside / outside the range. Structure:
 * FROM the right Type + a filter on the date field (or the date-part grouping the
 * request implies).
 */
import { e } from '../model';
import { a } from './assert';
import type { EvalCase } from './types';

export const dateCases: EvalCase[] = [
  {
    id: 'date-orders-march-2026',
    category: 'date-range',
    request: 'List the id of every sales order placed in March 2026.',
    note: 'Order 4 (03-01) and 23 (03-31) are on the boundary (in); order 5 (04-01) is just out.',
    assert: [
      a.from('salesOrder'),
      a.filtersOn('orderedAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [
          e.gte(e.ref('salesOrder', 'orderedAt'), e.makeDate(e.value(2026), e.value(3), e.value(1))).toJSON(),
          e.lte(e.ref('salesOrder', 'orderedAt'), e.makeDate(e.value(2026), e.value(3), e.value(31))).toJSON(),
        ],
      })),
    ],
  },
  {
    id: 'date-orders-q1-2026',
    category: 'date-range',
    request: 'List the id and total of sales orders placed in Q1 2026 (January through March).',
    note: 'Order 22 (2025-12-20) and order 5 (2026-04-01) straddle the quarter and must be excluded.',
    assert: [
      a.from('salesOrder'),
      a.filtersOn('orderedAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [
          e.gte(e.ref('salesOrder', 'orderedAt'), e.makeDate(e.value(2026), e.value(1), e.value(1))).toJSON(),
          e.lte(e.ref('salesOrder', 'orderedAt'), e.makeDate(e.value(2026), e.value(3), e.value(31))).toJSON(),
        ],
      })),
    ],
  },
  {
    id: 'date-invoices-issued-2026',
    category: 'date-range',
    request: 'How many invoices were issued during the year 2026?',
    note: 'Uses the year() of a date field; an invoice issued for the 2025 order is a distractor.',
    assert: [
      a.from('invoice'),
      a.aggregate('count'),
      a.filtersOn('issuedAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.countStar().toJSON(), as: 'invoiceCount' }],
        from: { kind: 'type', type: 'invoice' },
        where: [e.eq(e.year(e.ref('invoice', 'issuedAt')), e.value(2026)).toJSON()],
      })),
    ],
  },
  {
    id: 'date-trunc-quarter-revenue',
    category: 'date-range',
    request:
      'Total PAID sales-order revenue grouped by the calendar QUARTER of the order date. Return the quarter start and the revenue.',
    note: 'dateTrunc(quarter) makes THREE buckets: 2025-Q4 (only order 22 = 1000), 2026-Q1 (Jan–Mar), and 2026-Q2 (only order 5 = 900). Truncating to month or year would merge or split these differently.',
    assert: [
      a.from('salesOrder'),
      a.groupBy(),
      a.aggregate('sum'),
      a.filtersOn('status'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [
          { expr: e.dateTrunc('quarter', e.ref('salesOrder', 'orderedAt')).toJSON(), as: 'quarter' },
          { expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'revenue' },
        ],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
        groupBy: [e.dateTrunc('quarter', e.ref('salesOrder', 'orderedAt')).toJSON()],
      })),
    ],
  },
  {
    id: 'date-datepart-quarter-two',
    category: 'date-range',
    request: 'List the id and total of every sales order placed in the SECOND quarter (April–June) of any year.',
    note: 'datePart(quarter) = 2 selects only the lone April order (5); the Q1 orders (quarter 1) and the Dec-2025 order 22 (quarter 4) are the boundary distractors.',
    assert: [
      a.from('salesOrder'),
      a.filtersOn('orderedAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.datePart('quarter', e.ref('salesOrder', 'orderedAt')), e.value(2)).toJSON()],
      })),
    ],
  },
  {
    id: 'date-dayofyear-january',
    category: 'date-range',
    request: 'List the id of every sales order placed within the first 31 days of its year (day-of-year 31 or lower).',
    note: 'dayOfYear ≤ 31 isolates January orders (1,6,9,13,17); order 9 (Jan 30 = day 30) is just inside while any Feb order (day ≥ 32) and the Dec-2025 order 22 (day ~354) are out.',
    assert: [
      a.from('salesOrder'),
      a.filtersOn('orderedAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.lte(e.dayOfYear(e.ref('salesOrder', 'orderedAt')), e.value(31)).toJSON()],
      })),
    ],
  },
];
