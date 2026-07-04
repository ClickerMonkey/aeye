/**
 * CTE cases: a non-recursive CTE feeding a final query, plus two RECURSIVE CTEs
 * that walk the self-referential `category.parent` tree (descendants and
 * ancestors). The tree is 4 levels deep under Electronics
 * (Electronics → Laptops → Gaming Laptops → RGB Laptops), so a shallow /
 * single-hop query CANNOT reproduce the transitive closure — only the recursion
 * reaches the grandchildren, which is the whole discriminator.
 */
import { e } from '../model';
import type { EvalCase } from './types';
import type { QueryDef } from '../../src/index';

export const cteCases: EvalCase[] = [
  {
    id: 'cte-paid-revenue-over-4000',
    category: 'cte',
    request:
      'Using only paid sales orders, compute each customer’s total paid revenue, then return the customer id and revenue for customers whose paid revenue exceeds 4000.',
    oracle: () => {
      const perCustomer: QueryDef = {
        kind: 'select',
        fields: [
          { expr: e.path('salesOrder', 'customer', 'id').toJSON(), as: 'cid' },
          { expr: e.sum(e.ref('salesOrder', 'total')).toJSON(), as: 'rev' },
        ],
        from: { kind: 'type', type: 'salesOrder' },
        where: [e.eq(e.ref('salesOrder', 'status'), e.value('paid')).toJSON()],
        groupBy: [e.path('salesOrder', 'customer', 'id').toJSON()],
      };
      return {
        kind: 'cte',
        ctes: [{ name: 'custRev', query: perCustomer }],
        final: {
          kind: 'select',
          fields: [
            { expr: e.ref('custRev', 'cid').toJSON(), as: 'cid' },
            { expr: e.ref('custRev', 'rev').toJSON(), as: 'rev' },
          ],
          from: { kind: 'type', type: 'custRev' },
          where: [e.gt(e.ref('custRev', 'rev'), e.value(4000)).toJSON()],
        },
      };
    },
    note: 'The CTE aggregates paid revenue per customer; the final filters it. Customer 4 (4200) and 1 (4250) are just over 4000; non-paid orders must not inflate any total.',
  },
  {
    id: 'cte-recursive-descendants-electronics',
    category: 'cte',
    request:
      'List the id of every category that is a descendant of ‘Electronics’ — its subcategories, their subcategories, and so on, at any depth.',
    oracle: () => {
      const base: QueryDef = {
        kind: 'select',
        fields: [{ expr: e.ref('category', 'id').toJSON(), as: 'id' }],
        from: { kind: 'type', type: 'category' },
        where: [e.eq(e.path('category', 'parent', 'id'), e.value(1)).toJSON()],
      };
      const recursive: QueryDef = {
        kind: 'select',
        fields: [{ expr: e.ref('category', 'id').toJSON(), as: 'id' }],
        from: { kind: 'type', type: 'category' },
        where: [
          e
            .inSubquery(e.path('category', 'parent', 'id'), {
              kind: 'select',
              fields: [{ expr: e.ref('descendants', 'id').toJSON(), as: 'id' }],
              from: { kind: 'type', type: 'descendants' },
            })
            .toJSON(),
        ],
      };
      return {
        kind: 'cte',
        ctes: [{ name: 'descendants', base, recursive }],
        final: {
          kind: 'select',
          fields: [{ expr: e.ref('descendants', 'id').toJSON(), as: 'id' }],
          from: { kind: 'type', type: 'descendants' },
        },
      };
    },
    note: 'Recursive closure over parent — {5,6,9,10,11,12}. A one-hop “children of Electronics” query returns only {5,6}; the grandchildren (9,10,11) and great-grandchild (12) require the recursion.',
  },
  {
    id: 'cte-recursive-ancestors-rgb-laptops',
    category: 'cte',
    request:
      'List the id of every ancestor category of ‘RGB Laptops’ (id 12) — its parent, grandparent, and so on up to the root, excluding the category itself.',
    oracle: () => {
      const base: QueryDef = {
        kind: 'select',
        fields: [
          { expr: e.ref('category', 'id').toJSON(), as: 'id' },
          { expr: e.path('category', 'parent', 'id').toJSON(), as: 'pid' },
        ],
        from: { kind: 'type', type: 'category' },
        where: [e.eq(e.ref('category', 'id'), e.value(12)).toJSON()],
      };
      const recursive: QueryDef = {
        kind: 'select',
        fields: [
          { expr: e.ref('category', 'id').toJSON(), as: 'id' },
          { expr: e.path('category', 'parent', 'id').toJSON(), as: 'pid' },
        ],
        from: { kind: 'type', type: 'category' },
        where: [
          e
            .inSubquery(e.ref('category', 'id'), {
              kind: 'select',
              fields: [{ expr: e.ref('ancestors', 'pid').toJSON(), as: 'pid' }],
              from: { kind: 'type', type: 'ancestors' },
            })
            .toJSON(),
        ],
      };
      return {
        kind: 'cte',
        ctes: [{ name: 'ancestors', base, recursive }],
        final: {
          kind: 'select',
          fields: [{ expr: e.ref('ancestors', 'id').toJSON(), as: 'id' }],
          from: { kind: 'type', type: 'ancestors' },
          where: [e.neq(e.ref('ancestors', 'id'), e.value(12)).toJSON()],
        },
      };
    },
    note: 'Walks parent UPWARD carrying each row’s parent pointer: RGB Laptops(12) → Gaming Laptops(9) → Laptops(5) → Electronics(1). Returning only the direct parent (9) is the wrong, non-recursive answer.',
  },
];
