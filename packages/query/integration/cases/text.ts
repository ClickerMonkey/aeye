/**
 * Text cases: full-text `textSearch` over a search-flagged field, and a
 * case-insensitive `ilike` pattern match.
 */
import { e } from '../model';
import type { EvalCase } from './types';

export const textCases: EvalCase[] = [
  {
    id: 'text-search-product-aurora',
    category: 'text-search',
    request: "Find the id and name of products matching the search term 'aurora'.",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('product', 'id').toJSON() }, { expr: e.ref('product', 'name').toJSON() }],
      from: { kind: 'type', type: 'product' },
      where: [e.textSearch('product', 'aurora', 'name').toJSON()],
    }),
    note: 'Both "Aurora Laptop" rows (ids 1 & 7) match; text search is case-insensitive on the search-flagged name.',
  },
  {
    id: 'text-ilike-acme-customers',
    category: 'text-search',
    request: "Which customers have a name containing 'acme' (case-insensitive)? Return id and name.",
    oracle: () => ({
      kind: 'select',
      fields: [{ expr: e.ref('customer', 'id').toJSON() }, { expr: e.ref('customer', 'name').toJSON() }],
      from: { kind: 'type', type: 'customer' },
      where: [e.ilike(e.ref('customer', 'name'), e.value('%acme%')).toJSON()],
    }),
    note: 'Matches BOTH "Acme Corp" (1) and "Acme Corporation" (7) — the classic same-name-different-id trap.',
  },
];
