/**
 * Function cases: window functions (`rowNumber`, `lag`), statistical /
 * collecting aggregates (`stddev`, `stringAgg`, `countIf`), extra date builtins
 * (`month`, `dayOfWeek`, `age`, `dateTrunc`), and string builtins. Structure:
 * the matching `a.window(fn)` / `a.aggregate(fn)`, or a filter on the transformed
 * field, plus the RESULT check.
 */
import { e } from '../model';
import { a } from './assert';
import type { EvalCase } from './types';

export const functionCases: EvalCase[] = [
  {
    id: 'fn-window-rownumber',
    category: 'window',
    request:
      "Rank customer 1's sales orders from largest total to smallest; return the order id and its 1-based rank.",
    note: 'rowNumber() over total desc — the cancelled order 3 (5000) still ranks #1; the window ignores status, so the sort, not a filter, sets the numbering.',
    assert: [
      a.from('salesOrder'),
      a.window('rowNumber'),
      a.joins('customer'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [
          { expr: e.ref('salesOrder', 'id').toJSON() },
          {
            expr: e
              .window('rowNumber', {
                orderBy: [
                  { expr: e.ref('salesOrder', 'total'), dir: 'desc' },
                  { expr: e.ref('salesOrder', 'id'), dir: 'asc' },
                ],
              })
              .toJSON(),
            as: 'rank',
          },
        ],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.path('salesOrder', 'customer', 'id'), e.value(1)).toJSON()],
      })),
    ],
  },
  {
    id: 'fn-window-lag',
    category: 'window',
    request:
      "For customer 6's sales orders in date order, show each order id alongside the total of that customer's previous order (0 if none).",
    note: 'lag(total) ordered by date — order 13 (earliest) gets the default 0; 14→4000, 23→2500. A wrong order direction shifts every prior value.',
    assert: [
      a.from('salesOrder'),
      a.window('lag'),
      a.joins('customer'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [
          { expr: e.ref('salesOrder', 'id').toJSON() },
          {
            expr: e
              .window('lag', {
                args: { value: e.ref('salesOrder', 'total'), default: e.value(0) },
                orderBy: [{ expr: e.ref('salesOrder', 'orderedAt'), dir: 'asc' }],
              })
              .toJSON(),
            as: 'prevTotal',
          },
        ],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.path('salesOrder', 'customer', 'id'), e.value(6)).toJSON()],
      })),
    ],
  },
  {
    id: 'fn-stddev-paid',
    category: 'function',
    request: 'What is the sample standard deviation of the totals of the PAID sales orders?',
    note: 'Sample stddev over PAID orders only; including cancelled/refunded/open/draft totals changes both n and the spread.',
    assert: [
      a.from('salesOrder'),
      a.aggregate('stddev'),
      a.filtersOn('status'),
      a.resultOf(
        () => ({
          kind: 'select',
          fields: [{ expr: e.stddev(e.ref('salesOrder', 'total')).toJSON(), as: 'sd' }],
          from: { kind: 'type', type: 'salesOrder' },
          where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
        }),
        { tolerance: 1e-6 },
      ),
    ],
  },
  {
    id: 'fn-stringagg-eu-names',
    category: 'function',
    request: 'For the EU region, list the region and a comma-separated string of its customer names.',
    note: 'stringAgg concatenates the three EU customers (Umbrella Co, Acme Corporation, Soylent Corp); West/East names must not leak into the string.',
    assert: [
      a.from('customer'),
      a.groupBy(),
      a.aggregate('stringAgg'),
      a.filtersOn('region'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [
          { expr: e.ref('customer', 'region').toJSON(), as: 'region' },
          { expr: e.stringAgg(e.ref('customer', 'name'), e.value(', ')).toJSON(), as: 'names' },
        ],
        from: { kind: 'type', type: 'customer' },
        where: [e.eq(e.ref('customer', 'region'), e.value('EU')).toJSON()],
        groupBy: [e.ref('customer', 'region').toJSON()],
      })),
    ],
  },
  {
    id: 'fn-countif-active-by-dept',
    category: 'function',
    request: 'For each department id, how many of its employees are active? Return the department id and the count.',
    note: 'countIf(active) differs from count(*): dept 1 has 4 employees but 3 active (Karl 11 inactive); dept 3 has 2 but 1 active (Grace 7 inactive).',
    assert: [
      a.from('employee'),
      a.groupBy(),
      a.aggregate('countIf'),
      a.joins('department'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [
          { expr: e.path('employee', 'department', 'id').toJSON(), as: 'departmentId' },
          { expr: e.countIf(e.eq(e.ref('employee', 'active'), e.value(true))).toJSON(), as: 'activeCount' },
        ],
        from: { kind: 'type', type: 'employee' },
        groupBy: [e.path('employee', 'department', 'id').toJSON()],
      })),
    ],
  },
  {
    id: 'fn-month-march',
    category: 'function',
    request: 'List the id of every sales order placed in the month of March (any year).',
    note: 'month() extracts 1–12 regardless of year; the December 2025 order (22) and April order (5) are distractors.',
    assert: [
      a.from('salesOrder'),
      a.filtersOn('orderedAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.month(e.ref('salesOrder', 'orderedAt')), e.value(3)).toJSON()],
      })),
    ],
  },
  {
    id: 'fn-dayofweek-weekend',
    category: 'function',
    request: 'List the id of every sales order that was placed on a weekend (Saturday or Sunday).',
    note: 'dayOfWeek() is 0=Sunday … 6=Saturday; weekday orders must be excluded, so the day-of-week of each date, not the date itself, is the discriminator.',
    assert: [
      a.from('salesOrder'),
      a.filtersOn('orderedAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.inList(e.dayOfWeek(e.ref('salesOrder', 'orderedAt')), [0, 6]).toJSON()],
      })),
    ],
  },
  {
    id: 'fn-age-payment-lag',
    category: 'function',
    request: 'List the id of every payment that arrived more than 10 days after its invoice was issued.',
    note: 'age() is the whole-day span across a relation hop; most payments land in 8 days — only the late second payments 10 & 14 (13 days) qualify.',
    assert: [
      a.from('payment'),
      a.joins('invoice'),
      a.filtersOn('paidAt'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('payment', 'id').toJSON() }],
        from: { kind: 'type', type: 'payment' },
        where: [
          e.gt(e.age(e.ref('payment', 'paidAt'), e.path('payment', 'invoice', 'issuedAt')), e.value(10)).toJSON(),
        ],
      })),
    ],
  },
  {
    id: 'fn-datetrunc-month-revenue',
    category: 'function',
    request: 'Total PAID sales-order revenue grouped by the calendar month of the order date. Return the month and the revenue.',
    note: 'dateTrunc(month) buckets each date to its month start; the 2025-12 paid order (22) forms its own bucket and must not merge into 2026-01.',
    assert: [
      a.from('salesOrder'),
      a.groupBy(),
      a.aggregate('sum'),
      a.filtersOn('status'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [
          { expr: e.dateTrunc('month', e.ref('salesOrder', 'orderedAt')).toJSON(), as: 'month' },
          { expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'revenue' },
        ],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
        groupBy: [e.dateTrunc('month', e.ref('salesOrder', 'orderedAt')).toJSON()],
      })),
    ],
  },
  {
    id: 'fn-length-long-names',
    category: 'function',
    request: 'List the id and name of products whose name is longer than 12 characters.',
    note: "length() on the name — 'Nimbus Phone' (12) is on the strict boundary and excluded; 'Aurora Laptop' (13) is included.",
    assert: [
      a.from('product'),
      a.filtersOn('name'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
        from: { kind: 'type', type: 'product' },
        where: [e.gt(e.fn('length', { value: e.ref('product', 'name') }), e.value(12)).toJSON()],
      })),
    ],
  },
  {
    id: 'fn-variance-paid',
    category: 'function',
    request: 'What is the sample variance of the totals of the PAID sales orders?',
    note: 'Sample variance (n−1) over PAID orders only; the square of stddev. Including non-paid totals changes both n and the spread.',
    assert: [
      a.from('salesOrder'),
      a.aggregate('variance'),
      a.filtersOn('status'),
      a.resultOf(
        () => ({
          kind: 'select',
          fields: [{ expr: e.variance(e.ref('salesOrder', 'total')).toJSON(), as: 'v' }],
          from: { kind: 'type', type: 'salesOrder' },
          where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
        }),
        { tolerance: 1e-3 },
      ),
    ],
  },
  {
    id: 'fn-upper-acme-exact',
    category: 'function',
    request: "List the id of every customer whose name, upper-cased, is exactly 'ACME CORP'.",
    note: "upper() then an EXACT match: only 'Acme Corp' (1); the longer 'Acme Corporation' (7) upper-cases to a different string and is excluded.",
    assert: [
      a.from('customer'),
      a.filtersOn('name'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('customer', 'id').toJSON(), as: 'id' }],
        from: { kind: 'type', type: 'customer' },
        where: [e.eq(e.fn('upper', { value: e.ref('customer', 'name') }), e.value('ACME CORP')).toJSON()],
      })),
    ],
  },
  {
    id: 'fn-substring-name-prefix',
    category: 'function',
    request: "List the id of every customer whose name begins with the 4 characters 'Acme'.",
    note: "substring(name, 0, 4) isolates the 4-char prefix — matches BOTH 'Acme Corp' (1) and 'Acme Corporation' (7); an exact-name compare would miss the second.",
    assert: [
      a.from('customer'),
      a.filtersOn('name'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('customer', 'id').toJSON(), as: 'id' }],
        from: { kind: 'type', type: 'customer' },
        where: [
          e.eq(
            e.fn('substring', { value: e.ref('customer', 'name'), start: e.value(0), length: e.value(4) }),
            e.value('Acme'),
          ).toJSON(),
        ],
      })),
    ],
  },
  {
    id: 'fn-replace-sku',
    category: 'function',
    request: "List the id of every product whose sku, with the 'SKU-' prefix removed, is exactly 'L2'.",
    note: "replace() strips the prefix before comparing: only SKU-L2 (7) yields 'L2'; SKU-L1 (1) yields 'L1' and is excluded, so the transform (not a raw sku compare) is what matches.",
    assert: [
      a.from('product'),
      a.filtersOn('sku'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('product', 'id').toJSON(), as: 'id' }],
        from: { kind: 'type', type: 'product' },
        where: [
          e.eq(
            e.fn('replace', { value: e.ref('product', 'sku'), search: e.value('SKU-'), replacement: e.value('') }),
            e.value('L2'),
          ).toJSON(),
        ],
      })),
    ],
  },
  {
    id: 'fn-nullif-gold-tier',
    category: 'function',
    request: 'List the id of every gold-tier customer, identifying gold as the tier value that nullif turns into null.',
    note: "nullif(tier,'gold') is NULL exactly when tier = 'gold', so IS NULL selects the four gold customers (1,4,6,8); silver/bronze rows stay non-null and are excluded.",
    assert: [
      a.from('customer'),
      a.filtersOn('tier'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('customer', 'id').toJSON(), as: 'id' }],
        from: { kind: 'type', type: 'customer' },
        where: [e.isNull(e.fn('nullif', { value: e.ref('customer', 'tier'), other: e.value('gold') })).toJSON()],
      })),
    ],
  },
];
