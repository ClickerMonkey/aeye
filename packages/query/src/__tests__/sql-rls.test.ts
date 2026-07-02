/**
 * RLS injection: a per-Type predicate is ANDed into EVERY occurrence of the
 * Type — top-level WHERE, planned joins, aggregate CTEs, and subqueries.
 */
import { describe, it, expect } from 'vitest';
import type { QueryDef, SelectDef } from '../schema';
import { fixture } from './_utils';
import type { RlsProvider } from '../sql/index';

/** Tenant/org scoping for `order` / `user`, qualified by the occurrence alias. */
const rls: RlsProvider = {
  predicateFor(typeName, alias) {
    if (typeName === 'order') {
      return { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: alias, field: 'tenantId' }, right: { kind: 'param', name: 'tenant' } };
    }
    if (typeName === 'user') {
      return { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: alias, field: 'orgId' }, right: { kind: 'param', name: 'org' } };
    }
    return undefined;
  },
};

describe('SQL — RLS injection', () => {
  const fx = fixture();
  const emit = (q: QueryDef) =>
    fx.engine.toSQL(q, 'base', { rls, params: { tenant: 'T1', org: 'O1' } });

  it('injects into the top-level FROM WHERE', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'order' },
    };
    const out = emit(def);
    // tenantId/orgId are undeclared placeholder (text) fields and the bind param
    // defaults to text, so the comparison case-folds in BOTH runtime and SQL
    // (the package's text default is case-INSENSITIVE) — P0-4 alignment.
    expect(out.sql).toContain('WHERE LOWER("order"."tenantId") = LOWER(?)');
    expect(out.params).toEqual(['T1']);
  });

  it('injects into a planned (hidden) join ON', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'relation-path', source: 'order', path: ['userId', 'name'] }, as: 'cust' }],
      from: { kind: 'type', type: 'order' },
    };
    const out = emit(def);
    // the user-side RLS rides along in the join ON for alias `order_userId`...
    expect(out.sql).toContain('"order"."userId" = "order_userId"."id" AND LOWER("order_userId"."orgId") = LOWER(?)');
    // ...and the order-side RLS still appears in the top-level WHERE.
    expect(out.sql).toContain('WHERE LOWER("order"."tenantId") = LOWER(?)');
  });

  it('injects into an aggregate CTE inner WHERE', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' },
        { expr: { kind: 'aggregate', function: 'sum', args: { value: { kind: 'relation-path', source: 'user', path: ['orders', 'total'] } } }, as: 'spent' },
      ],
      from: { kind: 'type', type: 'user' },
    };
    const out = emit(def);
    // the CTE over `order` carries the order RLS in its inner WHERE.
    expect(out.sql).toContain('FROM "order" AS "t" WHERE LOWER("t"."tenantId") = LOWER(?) GROUP BY "t"."userId"');
    // the top-level user RLS is also present.
    expect(out.sql).toContain('WHERE LOWER("user"."orgId") = LOWER(?)');
  });

  it('injects into a subquery for the same Type', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'user' },
      where: [
        {
          kind: 'in',
          value: { kind: 'field-ref', source: 'user', field: 'id' },
          in: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'order', field: 'userId' }, as: 'uid' }],
            from: { kind: 'type', type: 'order' },
          },
        },
      ],
    };
    const out = emit(def);
    // outer user RLS + inner order RLS both present.
    expect(out.sql).toContain('LOWER("user"."orgId") = LOWER(?)');
    expect(out.sql).toContain('WHERE LOWER("order"."tenantId") = LOWER(?))');
  });
});
