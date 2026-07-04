/**
 * Additional window-function cases: `rank` / `denseRank` (with TIES designed in),
 * `lead` (the forward complement of the existing `lag` case), and `ntile`. The
 * tie is manufactured by ordering on the ORDER MONTH (`dateTrunc('month', …)`):
 * customer 1 has two February orders (2 and 3), so they share an order key —
 * making rank ≠ rowNumber and rank ≠ denseRank observable.
 */
import { e } from '../model';
import type { EvalCase } from './types';

/** Customer 1's orders (the tie set: orders 2 and 3 are both February 2026). */
const customer1 = [e.eq(e.path('salesOrder', 'customerId', 'id'), e.value(1)).toJSON()];

export const windowCases: EvalCase[] = [
  {
    id: 'win-rank-month-ties',
    category: 'window',
    request:
      "For customer 1's sales orders, rank them by the MONTH of the order date (earliest month = 1), giving orders in the same month the same rank. Return the order id and rank.",
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesOrder', 'id').toJSON(), as: 'id' },
        { expr: e.window('rank', { orderBy: [{ expr: e.dateTrunc('month', e.ref('salesOrder', 'orderedAt')), dir: 'asc' }] }).toJSON(), as: 'rnk' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: customer1,
    }),
    note: 'rank() with ties: the two February orders (2,3) both rank 3, then the March order (4) SKIPS to rank 5 — a gap rowNumber() (which would give 3,4,5) never produces.',
  },
  {
    id: 'win-denserank-month-ties',
    category: 'window',
    request:
      "For customer 1's sales orders, assign a dense rank by the MONTH of the order date (earliest month = 1, no gaps after ties). Return the order id and dense rank.",
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesOrder', 'id').toJSON(), as: 'id' },
        { expr: e.window('denseRank', { orderBy: [{ expr: e.dateTrunc('month', e.ref('salesOrder', 'orderedAt')), dir: 'asc' }] }).toJSON(), as: 'drnk' },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: customer1,
    }),
    note: 'denseRank() gives the February tie (2,3) rank 3 then March (4) rank 4 — NO gap, so it diverges from rank() (which jumps to 5) exactly at the post-tie boundary.',
  },
  {
    id: 'win-lead-next-total',
    category: 'window',
    request:
      "For customer 6's sales orders in date order, show each order id alongside the total of that customer's NEXT order (0 if there is none).",
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesOrder', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .window('lead', {
              args: { value: e.ref('salesOrder', 'total'), default: e.value(0) },
              orderBy: [{ expr: e.ref('salesOrder', 'orderedAt'), dir: 'asc' }],
            })
            .toJSON(),
          as: 'nextTotal',
        },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.path('salesOrder', 'customerId', 'id'), e.value(6)).toJSON()],
    }),
    note: 'lead(total) looks FORWARD: order 13→2500, 14→2200, and the last order 23 gets the default 0. lag (looking back) would shift every value the other way.',
  },
  {
    id: 'win-ntile-quartiles',
    category: 'window',
    request:
      'Split all PAID sales orders into 4 equal quartiles by total (ascending), and return each order id with its quartile number (1–4).',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesOrder', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .window('ntile', {
              args: { n: e.value(4) },
              orderBy: [
                { expr: e.ref('salesOrder', 'total'), dir: 'asc' },
                { expr: e.ref('salesOrder', 'id'), dir: 'asc' },
              ],
            })
            .toJSON(),
          as: 'quartile',
        },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
    }),
    note: 'ntile(4) buckets the 16 paid orders 4-per-quartile by ascending total; a bucket derived from raw total ranges (rather than equal counts) mis-assigns the boundary orders.',
  },
  {
    id: 'win-percentrank-paid-total',
    category: 'window',
    request:
      'Across all PAID sales orders, give each order its percent rank by total (ascending, where the smallest total is 0). Return the order id and the percent rank.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesOrder', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .window('percentRank', {
              orderBy: [{ expr: e.ref('salesOrder', 'total'), dir: 'asc' }],
            })
            .toJSON(),
          as: 'pr',
        },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
    }),
    floatTolerance: 1e-9,
    note: 'percentRank = (rank−1)/(N−1) over the 16 paid orders: the tied totals (two 900s, two 1200s) share a percent rank, so it diverges from a rowNumber-derived fraction exactly at the ties.',
  },
  {
    id: 'win-cumedist-dept-salary',
    category: 'window',
    request:
      'For each employee, compute the cumulative distribution of their salary WITHIN their department (fraction of the department earning at most as much). Return the employee id and the cumulative distribution.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('employee', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .window('cumeDist', {
              partitionBy: [e.ref('employee', 'departmentId')],
              orderBy: [{ expr: e.ref('employee', 'salary'), dir: 'asc' }],
            })
            .toJSON(),
          as: 'cd',
        },
      ],
      from: { kind: 'type', type: 'employee' },
    }),
    floatTolerance: 1e-9,
    note: 'cumeDist = (#rows ≤ current)/N, partitioned by department: the top earner in each department is always 1, but the fractions differ from percentRank because cumeDist counts the current row (offset by one). Omitting the partition would rank against ALL employees.',
  },
  {
    id: 'win-firstvalue-dept-top-salary',
    category: 'window',
    request:
      "For each employee, show the HIGHEST salary in that employee's department (the same value for everyone in the department). Return the employee id and that top salary.",
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('employee', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .window('firstValue', {
              args: { value: e.ref('employee', 'salary') },
              partitionBy: [e.ref('employee', 'departmentId')],
              orderBy: [{ expr: e.ref('employee', 'salary'), dir: 'desc' }],
            })
            .toJSON(),
          as: 'topSalary',
        },
      ],
      from: { kind: 'type', type: 'employee' },
    }),
    note: 'firstValue over a salary-DESC partition attaches each department’s maximum salary to every member (dept1=120000, dept2=130000, dept3=62000, dept4=140000, dept5=70000). The per-row salary itself is the wrong answer.',
  },
  {
    id: 'win-lastvalue-dept-bottom-salary',
    category: 'window',
    request:
      "For each employee, show the LOWEST salary in that employee's department (the same value for everyone in the department). Return the employee id and that bottom salary.",
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('employee', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .window('lastValue', {
              args: { value: e.ref('employee', 'salary') },
              partitionBy: [e.ref('employee', 'departmentId')],
              orderBy: [{ expr: e.ref('employee', 'salary'), dir: 'desc' }],
            })
            .toJSON(),
          as: 'bottomSalary',
        },
      ],
      from: { kind: 'type', type: 'employee' },
    }),
    note: 'lastValue uses the FULL-partition frame here, so over a salary-DESC partition it returns each department’s minimum (dept1=80000, dept2=118000, dept3=60000, dept4=95000, dept5=70000) — not the running-frame current-row value a default SQL frame would give.',
  },
  {
    id: 'win-nthvalue-second-largest-paid',
    category: 'window',
    request:
      'Label every PAID sales order with the SECOND-largest paid-order total (the same value on each row). Return the order id and that second-largest total.',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('salesOrder', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .window('nthValue', {
              args: { value: e.ref('salesOrder', 'total'), n: e.value(2) },
              orderBy: [
                { expr: e.ref('salesOrder', 'total'), dir: 'desc' },
                { expr: e.ref('salesOrder', 'id'), dir: 'asc' },
              ],
            })
            .toJSON(),
          as: 'secondLargest',
        },
      ],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
    }),
    note: 'nthValue(total, 2) over a total-DESC partition returns the 2nd-largest paid total (4000, order 13) on every row — order 17 (6000) is the max, so a max() or firstValue would wrongly return 6000.',
  },
];
