/**
 * Operator / expression cases: `IN (list)`, `BETWEEN`, case-sensitive `LIKE`,
 * `IS NULL`, `DISTINCT` (count-distinct), and a bucketing `CASE`. Each trap is a
 * boundary or a distractor the corresponding wrong operator mishandles.
 */
import { e } from '../model';
import type { EvalCase } from './types';

export const operatorCases: EvalCase[] = [
  {
    id: 'op-in-status',
    category: 'operator',
    request: 'List the id and status of sales orders whose status is either cancelled or refunded.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'status').toJSON() }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.inList(e.ref('salesOrder', 'status'), ['cancelled', 'refunded']).toJSON()],
    }),
    note: 'IN over two statuses — orders 3,16 (cancelled) and 8,24 (refunded); paid/open/draft orders are distractors.',
  },
  {
    id: 'op-between-total',
    category: 'operator',
    request: 'List the id and total of sales orders whose total is between 1000 and 2000 inclusive.',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('salesOrder', 'id').toJSON() }, { expr: e.ref('salesOrder', 'total').toJSON() }],
      from: { kind: 'type', type: 'salesOrder' },
      where: [e.between(e.ref('salesOrder', 'total'), e.value(1000), e.value(2000)).toJSON()],
    }),
    note: 'BETWEEN is inclusive: order 22 (1000) and order 6 (2000) are on the boundaries (in); order 23 (2200) is just out.',
  },
  {
    id: 'op-like-sku-laptop',
    category: 'operator',
    request: "List the id and sku of products whose sku starts with 'SKU-L'.",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'sku').toJSON() }],
      from: { kind: 'type', type: 'product' },
      where: [e.like(e.ref('product', 'sku'), e.value('SKU-L%')).toJSON()],
    }),
    note: "Case-sensitive LIKE prefix — SKU-L1 (1) and SKU-L2 (7); SKU-P/S/O/etc. are distractors.",
  },
  {
    id: 'op-isnull-unshipped',
    category: 'is-null',
    request: 'List the id of every shipment that has not shipped yet (no shipped date).',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('shipment', 'id').toJSON() }],
      from: { kind: 'type', type: 'shipment' },
      where: [e.isNull(e.ref('shipment', 'shippedAt')).toJSON()],
    }),
    note: 'IS NULL on the nullable shippedAt — pending shipments (4,5,9,10,14,17,18); shipped/delivered rows have a date and are excluded.',
  },
  {
    id: 'op-distinct-regions',
    category: 'distinct',
    request: 'How many distinct sales regions do the customers span?',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.agg('count', { value: e.ref('customer', 'region') }, true).toJSON(), as: 'regionCount' }],
      from: { kind: 'type', type: 'customer' },
    }),
    note: 'COUNT(DISTINCT region) = 3 (West/East/EU); a plain count(*) would wrongly return 12 (the row count).',
  },
  {
    id: 'op-distinct-products-ordered',
    category: 'distinct',
    request: 'How many distinct products appear across all sales order lines?',
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.agg('count', { value: e.path('salesOrderLine', 'productId', 'id') }, true).toJSON(), as: 'productCount' }],
      from: { kind: 'type', type: 'salesOrderLine' },
    }),
    note: 'COUNT(DISTINCT product) across 48 lines = 12; counting rows (or non-distinct) inflates it to the line count.',
  },
  {
    id: 'op-case-price-band',
    category: 'case',
    request:
      "Bucket every product by list price into 'premium' (>= 1000), 'mid' (>= 300), or 'budget', and return each band with its product count.",
    oracle: () => {
      const band = e.case(
        [
          e.when(e.gte(e.ref('product', 'price'), e.value(1000)), e.value('premium')),
          e.when(e.gte(e.ref('product', 'price'), e.value(300)), e.value('mid')),
        ],
        e.value('budget'),
      );
      return {
        kind: 'select',
        fields: [{ expr: band.toJSON(), as: 'band' }, { expr: e.countStar().toJSON(), as: 'productCount' }],
        from: { kind: 'type', type: 'product' },
        groupBy: [band.toJSON()],
      };
    },
    note: 'CASE thresholds are ordered and inclusive: premium=2, mid=6, budget=4; a wrong boundary (e.g. > vs >=) reshuffles the buckets.',
  },
];
