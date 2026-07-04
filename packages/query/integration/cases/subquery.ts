/**
 * Subquery cases: IN (subquery), NOT EXISTS (anti-join), and a scalar subquery
 * in a comparison. These exercise correlated + uncorrelated sub-selects.
 */
import { e } from '../model';
import type { EvalCase } from './types';
import type { QueryDef } from '../../src/index';

export const subqueryCases: EvalCase[] = [
  {
    id: 'in-customers-with-orders',
    category: 'subquery',
    request: 'List the id and name of customers who have placed at least one sales order.',
    oracle: () => {
      const placed: QueryDef = {
        kind: 'select',
        fields: [{ expr: e.path('salesOrder', 'customer', 'id').toJSON(), as: 'cid' }],
        from: { kind: 'type', type: 'salesOrder' },
      };
      return {
        kind: 'select',
        fields: [{ expr: e.ref('customer', 'id').toJSON() }, { expr: e.ref('customer', 'name').toJSON() }],
        from: { kind: 'type', type: 'customer' },
        where: [e.inSubquery(e.ref('customer', 'id'), placed).toJSON()],
      };
    },
    note: 'Customer 12 (Vandelay) has no orders and must be excluded — the anti-distractor.',
  },
  {
    id: 'not-exists-customers-without-orders',
    category: 'subquery',
    request: 'Which customers have never placed a sales order? Return their id and name.',
    oracle: () => {
      const correlated: QueryDef = {
        kind: 'select',
        fields: [{ expr: e.value(1).toJSON(), as: 'one' }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.path('salesOrder', 'customer', 'id'), e.ref('customer', 'id')).toJSON()],
      };
      return {
        kind: 'select',
        fields: [{ expr: e.ref('customer', 'id').toJSON() }, { expr: e.ref('customer', 'name').toJSON() }],
        from: { kind: 'type', type: 'customer' },
        where: [e.notExists(correlated).toJSON()],
      };
    },
    note: 'Only customer 12 qualifies; a non-correlated EXISTS would wrongly return everyone or no one.',
  },
  {
    id: 'subquery-above-avg-orders',
    category: 'subquery',
    request:
      'List the id and total of sales orders whose total is greater than the average total of all PAID orders.',
    oracle: () => {
      const avgPaid: QueryDef = {
        kind: 'select',
        fields: [{ expr: e.avg(e.ref('salesOrder', 'total')).toJSON(), as: 'avgTotal' }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
      };
      return {
        kind: 'select',
        fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.gt(e.ref('salesOrder', 'total'), e.subquery(avgPaid)).toJSON()],
      };
    },
    note: 'The scalar subquery must average PAID orders only; the comparison is against that single value.',
  },
  {
    id: 'exists-customers-nonpaid-invoice',
    category: 'subquery',
    request:
      'List the id and name of customers who have at least one invoice that is NOT in the paid status.',
    oracle: () => {
      const correlated: QueryDef = {
        kind: 'select',
        fields: [{ expr: e.value(1).toJSON(), as: 'one' }],
        from: { kind: 'type', type: 'invoice' },
        where: [
          e.eq(e.path('invoice', 'customer', 'id'), e.ref('customer', 'id')).toJSON(),
          e.neq(e.ref('invoice', 'status'), e.value('paid')).toJSON(),
        ],
      };
      return {
        kind: 'select',
        fields: [{ expr: e.ref('customer', 'id').toJSON() }, { expr: e.ref('customer', 'name').toJSON() }],
        from: { kind: 'type', type: 'customer' },
        where: [e.exists(correlated).toJSON()],
      };
    },
    note: 'Correlated EXISTS with an inner status filter: only Globex (2, overdue), Hooli (5, unpaid), Tyrell (11, unpaid) qualify; every other customer has paid invoices only. Dropping the inner correlation returns everyone.',
  },
  {
    id: 'not-in-products-never-purchased',
    category: 'subquery',
    request:
      'List the id and name of products that have never appeared on a purchase-order line (never restocked from a vendor).',
    oracle: () => {
      const purchased: QueryDef = {
        kind: 'select',
        fields: [{ expr: e.path('purchaseOrderLine', 'product', 'id').toJSON(), as: 'pid' }],
        from: { kind: 'type', type: 'purchaseOrderLine' },
      };
      return {
        kind: 'select',
        fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
        from: { kind: 'type', type: 'product' },
        where: [e.notInSubquery(e.ref('product', 'id'), purchased).toJSON()],
      };
    },
    note: 'NOT IN (subquery): products 7,8,9,10 never appear on a PO line; the eight products that DO get purchased are the distractors an IN (or a missing subquery) would return instead.',
  },
  {
    id: 'scalar-select-gold-order-count',
    category: 'subquery',
    request:
      'For each gold-tier customer, return the customer id and the total number of sales orders they have placed (any status).',
    oracle: () => ({
      kind: 'select',
      fields: [
        { expr: e.ref('customer', 'id').toJSON(), as: 'id' },
        {
          expr: e
            .subquery({
              kind: 'select',
              fields: [{ expr: e.countStar().toJSON(), as: 'c' }],
              from: { kind: 'type', type: 'salesOrder' },
              where: [e.eq(e.path('salesOrder', 'customer', 'id'), e.ref('customer', 'id')).toJSON()],
            })
            .toJSON(),
          as: 'orderCount',
        },
      ],
      from: { kind: 'type', type: 'customer' },
      where: [e.eq(e.ref('customer', 'tier'), e.value('gold')).toJSON()],
    }),
    note: 'A correlated scalar subquery in the SELECT list (not WHERE): Acme Corp(1)=6, Umbrella(4)=2, Stark(6)=3, Wayne(8)=2. An uncorrelated count would attach the same global total to every gold customer.',
  },
  {
    id: 'correlated-customer-largest-order',
    category: 'subquery',
    request:
      "Return the id and total of every sales order whose total equals the largest order total that same customer has ever placed (each customer's biggest order).",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [
        e
          .eq(
            e.ref('salesOrder', 'total'),
            e.subquery({
              kind: 'select',
              fields: [{ expr: e.max(e.ref('inner', 'total')).toJSON(), as: 'm' }],
              from: { kind: 'aliased', type: 'salesOrder', as: 'inner' },
              where: [e.eq(e.path('inner', 'customer', 'id'), e.path('salesOrder', 'customer', 'id')).toJSON()],
            }),
          )
          .toJSON(),
      ],
    }),
    note: "Correlated scalar subquery in WHERE using a self-alias: each customer's max is compared per-row, keeping orders 3,6,8,9,12,13,15,17,19,20,21 (incl. cancelled 3, the biggest for customer 1). An uncorrelated global max(6000) would keep only order 17.",
  },
];
