/**
 * Set-operation cases: UNION / UNION ALL / INTERSECT / EXCEPT over two SELECT
 * arms, plus a set-level ORDER BY + LIMIT. The correct answer is the SET
 * COMBINATION of the two arms (a single-arm query, or the wrong operator,
 * diverges). Structure: the matching `a.setOp(op)` + RESULT.
 */
import { e } from '../model';
import { a } from './assert';
import type { EvalCase } from './types';
import type { QueryDef } from '../../src/index';

/** SELECT customer.id AS id WHERE <pred>. */
const custIdsWhere = (pred: ReturnType<typeof e.eq>): QueryDef => ({
  kind: 'select',
  fields: [{ expr: e.ref('customer', 'id').toJSON(), as: 'id' }],
  from: { kind: 'type', type: 'customer' },
  where: [pred.toJSON()],
});

/** The customer ids that appear as a customer on some sales order. */
const customersWithOrders: QueryDef = {
  kind: 'select',
  fields: [{ expr: e.path('salesOrder', 'customer', 'id').toJSON(), as: 'id' }],
  from: { kind: 'type', type: 'salesOrder' },
};

const goldCustomers = custIdsWhere(e.eq(e.ref('customer', 'tier'), e.value('gold')));
const euCustomers = custIdsWhere(e.eq(e.ref('customer', 'region'), e.value('EU')));
const eastCustomers = custIdsWhere(e.eq(e.ref('customer', 'region'), e.value('East')));

export const setopCases: EvalCase[] = [
  {
    id: 'set-intersect-east-with-orders',
    category: 'set-op',
    request:
      'List the id of every customer that is BOTH in the East region AND has placed at least one sales order.',
    note: 'INTERSECT of East customers {2,6,8,12} with order-placing customers — Vandelay (12, East, no orders) drops out; a plain region filter would keep it.',
    assert: [
      a.setOp('intersect'),
      a.resultOf(() => ({ kind: 'intersect', left: eastCustomers, right: customersWithOrders })),
    ],
  },
  {
    id: 'set-except-east-without-orders',
    category: 'set-op',
    request: 'Which East-region customers have NEVER placed a sales order? Return the customer id.',
    note: 'EXCEPT (set difference) East − order-placers leaves only Vandelay (12); using the wrong operator (INTERSECT) or dropping an arm returns the opposite set.',
    assert: [
      a.setOp('except'),
      a.resultOf(() => ({ kind: 'except', left: eastCustomers, right: customersWithOrders })),
    ],
  },
  {
    id: 'set-union-gold-or-eu',
    category: 'set-op',
    request: 'List the distinct id of every customer that is gold tier or in the EU region (no duplicates).',
    note: 'UNION dedupes: Umbrella (4) is gold AND EU, so it must appear once; UNION ALL would list it twice — the dedup is the discriminator.',
    assert: [
      a.setOp('union'),
      a.resultOf(() => ({ kind: 'union', left: goldCustomers, right: euCustomers })),
    ],
  },
  {
    id: 'set-union-all-gold-eu-keepdupes',
    category: 'set-op',
    request:
      'Concatenate, keeping duplicates, the ids of gold-tier customers and the ids of EU-region customers into one list.',
    note: 'UNION ALL keeps the overlap: Umbrella (4) is both gold and EU, so it appears twice (7 rows vs the 6 a de-duplicating UNION returns).',
    assert: [
      a.setOp('union'),
      a.resultOf(() => ({ kind: 'union', left: goldCustomers, right: euCustomers, all: true })),
    ],
  },
  {
    id: 'set-union-orderlimit-smallest3',
    category: 'set-op',
    request: 'Of the customers that are gold tier or in the EU region, return the 3 smallest ids in ascending order.',
    note: 'A set-level ORDER BY + LIMIT applies to the COMBINED, de-duplicated rows: [1,4,6]; ordering/limiting a single arm before the union gives a different top-3.',
    assert: [
      a.setOp('union'),
      a.orderBy({ dir: 'asc' }),
      a.limit(3),
      a.resultOf(
        () => ({
          kind: 'union',
          left: goldCustomers,
          right: euCustomers,
          order: [{ expr: e.ref('result', 'id').toJSON(), dir: 'asc' }],
          limit: 3,
        }),
        { match: 'ordered' },
      ),
    ],
  },
];
