/**
 * Array-predicate cases: `contains` / `containsAny` / `containsAll` over the
 * `product.tags` and `employee.skills` array fields. The trap is the difference
 * between "has this element", "overlaps any of", and "has all of". Structure:
 * FROM the right Type + a condition on the array field.
 */
import { e } from '../model';
import { a } from './assert';
import type { EvalCase } from './types';

export const arrayCases: EvalCase[] = [
  {
    id: 'arr-contains-portable',
    category: 'array',
    request: "List the id and name of products whose tags include 'portable'.",
    note: "Only the two 'Aurora Laptop' rows (1, 7) carry the 'portable' tag; other electronics (e.g. Nimbus Phone) tagged 'mobile' are distractors.",
    assert: [
      a.from('product'),
      a.filtersOn('tags'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
        from: { kind: 'type', type: 'product' },
        where: [e.contains(e.ref('product', 'tags'), e.value('portable')).toJSON()],
      })),
    ],
  },
  {
    id: 'arr-containsany-furniture-lighting',
    category: 'array',
    request: "Which products are tagged with either 'furniture' or 'lighting'? Return id and name.",
    note: "containsAny (overlap) — matches furniture items (3,4,11) plus the 'lighting' Desk Lamp (12); office-only products (5,6) are distractors.",
    assert: [
      a.from('product'),
      a.filtersOn('tags'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
        from: { kind: 'type', type: 'product' },
        where: [e.containsAny(e.ref('product', 'tags'), [e.value('furniture'), e.value('lighting')]).toJSON()],
      })),
    ],
  },
  {
    id: 'arr-containsall-electronics-portable',
    category: 'array',
    request: "List the id and name of products tagged with BOTH 'electronics' and 'portable'.",
    note: "containsAll — only ids 1 & 7 have both; Nimbus Phone (2) is 'electronics','mobile' so a containsAny would wrongly include it.",
    assert: [
      a.from('product'),
      a.filtersOn('tags'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
        from: { kind: 'type', type: 'product' },
        where: [e.containsAll(e.ref('product', 'tags'), [e.value('electronics'), e.value('portable')]).toJSON()],
      })),
    ],
  },
  {
    id: 'arr-skills-sql',
    category: 'array',
    request: "Which employees have 'sql' among their skills? Return id and name.",
    note: "Engineers 4, 5, 12 list 'sql'; sales/support staff with 'crm' are distractors an unfiltered scan includes.",
    assert: [
      a.from('employee'),
      a.filtersOn('skills'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('employee', 'id').toJSON() }, { expr: e.ref('employee', 'name').toJSON() }],
        from: { kind: 'type', type: 'employee' },
        where: [e.contains(e.ref('employee', 'skills'), e.value('sql')).toJSON()],
      })),
    ],
  },
  {
    id: 'arr-skills-crm-leadership',
    category: 'array',
    request: "List the id and name of employees who have BOTH 'crm' and 'leadership' skills.",
    note: "Only Carol White (3) has both; the many 'crm'-only reps (1,2,7,11) are distractors a containsAny would return.",
    assert: [
      a.from('employee'),
      a.filtersOn('skills'),
      a.resultOf(() => ({
        kind: 'select',
        fields: [{ expr: e.ref('employee', 'id').toJSON() }, { expr: e.ref('employee', 'name').toJSON() }],
        from: { kind: 'type', type: 'employee' },
        where: [e.containsAll(e.ref('employee', 'skills'), [e.value('crm'), e.value('leadership')]).toJSON()],
      })),
    ],
  },
];
