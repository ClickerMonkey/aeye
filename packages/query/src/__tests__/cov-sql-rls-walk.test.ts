/**
 * Coverage: RLS `allow` / `noop` backing-access branches.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { TypeBacking } from '../backing';
import type { TypeDef, SelectDef } from '../schema';

const accountDef: TypeDef = {
  name: 'account',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'owner', type: { kind: 'number', whole: true } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'account', field: 'id' }, count: 1 }] }],
  count: 10,
  bytes: 16,
};

function accountFixture(backing: TypeBacking) {
  const registry = createRegistry();
  const account = registry.parseType(accountDef);
  registry.registerType(account, backing);
  registry.finalize();
  return new QueryEngine(registry);
}

const selectId: SelectDef = {
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'account', field: 'id' }, as: 'id' }],
  from: { kind: 'type', type: 'account' },
};

describe('cov rls: allow / noop backing access', () => {
  it('a static ALLOW (true) access adds no predicate (no WHERE)', () => {
    const engine = accountFixture({ access: { expr: () => true } });
    const { sql } = engine.toSQL(selectId, 'base');
    expect(sql).toBe('SELECT "account"."id" AS "id" FROM "account" AS "account"');
    expect(sql).not.toContain('WHERE');
  });

  it('a NOOP (undefined) access adds no predicate (no WHERE)', () => {
    const engine = accountFixture({ access: { expr: () => undefined } });
    const { sql } = engine.toSQL(selectId, 'base');
    expect(sql).not.toContain('WHERE');
  });

  it('provider predicate AND backing predicate are ANDed together', () => {
    const registry = createRegistry();
    const account = registry.parseType(accountDef);
    registry.registerType(account, {
      access: { expr: (alias) => registry.parseExpr({ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: alias, field: 'owner' }, right: { kind: 'literal', value: 1 } }) },
    });
    registry.finalize();
    const engine = new QueryEngine(registry);
    const provider = {
      predicateFor(typeName: string, alias: string) {
        return typeName === 'account'
          ? ({ kind: 'comparison', op: '>', left: { kind: 'field-ref', source: alias, field: 'id' }, right: { kind: 'literal', value: 0 } } as const)
          : undefined;
      },
    };
    const { sql } = engine.toSQL(selectId, 'base', { rls: provider });
    // both the provider predicate and the backing RLS predicate appear, ANDed.
    expect(sql).toContain('"account"."id" > ');
    expect(sql).toContain('"account"."owner" = ');
    expect(sql).toMatch(/WHERE .+ AND .+/);
  });
});

