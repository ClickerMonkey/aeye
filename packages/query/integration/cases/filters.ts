/**
 * Simple single-Type filter cases. Each oracle is a plain SELECT with a WHERE;
 * the trap is a distractor row a missing / wrong filter would wrongly include.
 */
import { e } from '../model';
import type { EvalCase } from './types';

export const filterCases: EvalCase[] = [
  {
    id: 'filter-active-customers',
    category: 'filter',
    request: 'List the id and name of every active customer.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('customer', 'id').toJSON() }, { expr: e.ref('customer', 'name').toJSON() }],
      from: { kind: 'type', type: 'customer' },
      where: [e.eq(e.ref('customer', 'active'), e.value(true)).toJSON()],
    }),
    note: 'Customer 9 (Cyberdyne) is inactive; omitting the active=true filter wrongly includes it.',
  },
  {
    id: 'filter-region-west',
    category: 'filter',
    request: 'Which customers are in the West sales region? Return their id and name.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('customer', 'id').toJSON() }, { expr: e.ref('customer', 'name').toJSON() }],
      from: { kind: 'type', type: 'customer' },
      where: [e.eq(e.ref('customer', 'region'), e.value('West')).toJSON()],
    }),
    note: 'East / EU customers are distractors; the region string must match exactly.',
  },
  {
    id: 'filter-paid-orders-customer1',
    category: 'filter',
    request:
      'Show the id and total of the PAID sales orders for the customer whose id is 1.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [
        e.eq(e.path('salesOrder', 'customerId', 'id'), e.value(1)).toJSON(),
        e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON(),
      ],
    }),
    note: 'Order 3 (cancelled) and customer 7 (the other "Acme") are distractors; both filters are required.',
  },
  {
    id: 'filter-products-over-500',
    category: 'filter',
    request: 'List the id and name of products with a list price greater than 500.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
      from: { kind: 'type', type: 'product' },
      where: [e.gt(e.ref('product', 'price'), e.value(500)).toJSON()],
    }),
    note: 'Mini Phone is exactly 500 (excluded by strict >); both "Aurora Laptop" rows (1200 & 1500) are included.',
  },
  {
    id: 'filter-gold-west-cross',
    category: 'filter',
    request: 'List the id of every customer that is BOTH gold tier and in the West region.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('customer', 'id').toJSON(), as: 'id' }],
      from: { kind: 'type', type: 'customer' },
      where: [
        e.eq(e.ref('customer', 'tier'), e.value('gold')).toJSON(),
        e.eq(e.ref('customer', 'region'), e.value('West')).toJSON(),
      ],
    }),
    note: 'Tier×region cross-filter: only Acme Corp (1) is gold AND West; the other gold customers (4,6,8) sit in EU/East, and other West customers are non-gold — both predicates are load-bearing.',
  },
  {
    id: 'filter-creditlimit-boundary',
    category: 'filter',
    request: 'Which customers have a credit limit of at least 50000? Return their id.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('customer', 'id').toJSON(), as: 'id' }],
      from: { kind: 'type', type: 'customer' },
      where: [e.gte(e.ref('customer', 'creditLimit'), e.value(50000)).toJSON()],
    }),
    note: 'Inclusive boundary at 50000: Globex (2) is exactly 50000 and must be kept; a strict > would wrongly drop it. Sub-50k customers (3,9,10,11,12) are excluded.',
  },
  {
    id: 'filter-2024-silver-onboarded',
    category: 'filter',
    request: 'List the id of every silver-tier customer that was onboarded (createdAt) during the year 2024.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('customer', 'id').toJSON(), as: 'id' }],
      from: { kind: 'type', type: 'customer' },
      where: [
        e.eq(e.ref('customer', 'tier'), e.value('silver')).toJSON(),
        e.eq(e.year(e.ref('customer', 'createdAt')), e.value(2024)).toJSON(),
      ],
    }),
    note: 'year() over the TIMESTAMP field createdAt crossed with tier: only silver customers onboarded in 2024 (2,5,7,10) qualify; silver Vandelay (12, onboarded 2025) and the 2024 gold/bronze customers are the near-miss distractors.',
  },
  {
    id: 'filter-paid-eur-gold-cross',
    category: 'filter',
    request: 'List the id of every sales order that is PAID, was placed in EUR, AND belongs to a gold-tier customer.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON(), as: 'id' }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [
        e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON(),
        e.eq(e.path('salesOrder', 'currencyCode', 'code'), e.value('EUR')).toJSON(),
        e.eq(e.path('salesOrder', 'customerId', 'tier'), e.value('gold')).toJSON(),
      ],
    }),
    note: 'Status×currency×tier triple cross across two relation hops: only orders 9 and 10 (Umbrella, gold, EUR, paid) survive; the other paid EUR orders 15 & 20 belong to silver customers — dropping the tier hop wrongly keeps them.',
  },
];
