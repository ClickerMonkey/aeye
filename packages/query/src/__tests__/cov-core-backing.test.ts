/**
 * Coverage: backing Access resolution via `sql` / `run` overrides + empty
 * Access noop, plus Backing.rls(). SQL-side interpretAccessSql is exercised
 * through engine.toSQL with `access.sql` overrides.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { RuntimeContext } from '../runtime/context';
import { resolveAccessRun } from '../backing';
import { SqlText } from '../sql/emit';
import type { Registry } from '../registry';
import type { TypeBacking, Access } from '../backing';
import type { TypeDef, SelectDef } from '../schema';
import type { SourceRow } from '../runtime/row';

const acctDef: TypeDef = {
  name: 'acct',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'owner', type: { kind: 'number', whole: true } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'acct', field: 'id' }, count: 1 }] }],
  count: 10,
  bytes: 16,
};
const rows = [{ id: 1, owner: 1 }, { id: 2, owner: 2 }];

function fx(backing: (r: Registry) => TypeBacking) {
  const registry = createRegistry();
  const acct = registry.parseType(acctDef);
  registry.registerType(acct, backing(registry));
  registry.finalize();
  const engine = new QueryEngine(registry, { executors: { acct: arrayExecutor(rows) } });
  return { registry, engine, acct };
}

const selId: SelectDef = {
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'acct', field: 'id' }, as: 'id' }],
  from: { kind: 'type', type: 'acct' },
  order: [{ expr: { kind: 'field-ref', source: 'acct', field: 'id' }, dir: 'asc' }],
};

describe('backing Access SQL resolution via `sql` override (interpretAccessSql)', () => {
  it('a raw SqlText predicate ANDs into WHERE', () => {
    const f = fx(() => ({ access: { sql: (alias) => SqlText.raw(`"${alias}"."owner" = 1`) } }));
    expect(f.engine.toSQL(selId, 'base').sql).toContain('"acct"."owner" = 1');
  });
  it('a static false denies (WHERE FALSE)', () => {
    const f = fx(() => ({ access: { sql: () => false } }));
    expect(f.engine.toSQL(selId, 'base').sql).toContain('WHERE FALSE');
  });
  it('a static true allows (no RLS predicate)', () => {
    const f = fx(() => ({ access: { sql: () => true } }));
    const sql = f.engine.toSQL(selId, 'base').sql;
    expect(sql).not.toContain('FALSE');
  });
  it('undefined is a noop', () => {
    const f = fx(() => ({ access: { sql: () => undefined } }));
    expect(f.engine.toSQL(selId, 'base').sql).toContain('FROM "acct"');
  });
  it('an empty Access (no sql/expr) resolves to noop', () => {
    const f = fx(() => ({ access: {} }));
    expect(f.engine.toSQL(selId, 'base').sql).toContain('FROM "acct"');
  });
});

describe('backing Access runtime resolution', () => {
  const engine = fx(() => ({})).engine;
  const ctx = new RuntimeContext(engine);
  const row: SourceRow = { acct: { id: 1, owner: 1 } };

  it('run override → visible boolean, or noop for undefined', async () => {
    const yes: Access = { run: () => true };
    expect(await resolveAccessRun(yes, 'acct', row, ctx)).toEqual({ kind: 'visible', visible: true });
    const noop: Access = { run: () => undefined };
    expect(await resolveAccessRun(noop, 'acct', row, ctx)).toEqual({ kind: 'noop' });
  });

  it('empty Access (no run/expr) → noop', async () => {
    expect(await resolveAccessRun({}, 'acct', row, ctx)).toEqual({ kind: 'noop' });
  });
});

describe('Backing.rls()', () => {
  it('returns the Type-level access, else undefined', () => {
    const withRls = fx(() => ({ access: { expr: () => true } }));
    expect(withRls.engine.backing('acct')!.rls()).toBeDefined();
    const none = fx(() => ({}));
    expect(none.engine.backing('acct')!.rls()).toBeUndefined();
  });
});

describe('backing runtime RLS via run override drops rows', () => {
  it('keeps only rows the run predicate admits', async () => {
    const f = fx(() => ({ access: { run: (r) => (r['acct']!['owner'] === 1) } }));
    const result = await f.engine.run(selId);
    expect(result.rows.map((x) => x['id'])).toEqual([1]);
  });
});
