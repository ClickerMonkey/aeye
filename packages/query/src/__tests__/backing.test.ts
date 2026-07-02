/**
 * Phase H1 — dev-side Type backing: computed fields, field-level security (FLS),
 * row-level security (RLS), and a real underlying source name.
 *
 * Uses a small local `account` fixture so it doesn't disturb the shared
 * `user`/`order` types. The backing is registered alongside the Type via
 * `registry.registerType(type, backing)`; the JSON `TypeDef` is untouched.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { SqlText } from '../sql/emit';
import { Value } from '../runtime/value';
import type { Registry } from '../registry';
import type { TypeBacking } from '../backing';
import type { TypeDef, SelectDef } from '../schema';
import type { SourceRecord } from '../runtime/row';
import { ref, lit } from './_utils';

/** Conceptual `account` Type: stored + computed + remapped + FLS-gated fields. */
const accountDef: TypeDef = {
  name: 'account',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'owner', type: { kind: 'number', whole: true } },
    { name: 'balance', type: { kind: 'money', currency: 'USD' } },
    // computed (dual expr): balance * 2
    { name: 'doubled', type: { kind: 'number' } },
    // computed (sql + run overrides)
    { name: 'tag', type: { kind: 'text' } },
    { name: 'note', type: { kind: 'text' }, nullable: true },
    // remapped stored field → reads the `note` column
    { name: 'legacyNote', type: { kind: 'text' }, nullable: true },
    // FLS-gated (predicate): only owner 1 sees it
    { name: 'secret', type: { kind: 'text' }, nullable: true },
    // FLS-gated (static deny): always NULL
    { name: 'masked', type: { kind: 'text' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'account', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 64,
};

const accountRows: SourceRecord[] = [
  { id: 1, owner: 1, balance: 100, note: 'n1', secret: 's1' },
  { id: 2, owner: 2, balance: 50, note: 'n2', secret: 's2' },
];

/** Build a registry + engine over `account` with the given (registry-derived) backing. */
function accountFixture(makeBacking: (r: Registry) => TypeBacking) {
  const registry = createRegistry();
  const account = registry.parseType(accountDef);
  registry.registerType(account, makeBacking(registry));
  registry.finalize();
  const engine = new QueryEngine(registry, { executors: { account: arrayExecutor(accountRows) } });
  return { registry, engine, account };
}

/** SELECT <field> AS <as> FROM account. */
function selectField(field: string, as = field): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'account', field }, as }],
    from: { kind: 'type', type: 'account' },
  };
}

/** Field backings (no RLS) exercising compute / remap / FLS. */
const fieldsBacking = (r: Registry): TypeBacking => ({
  fields: {
    doubled: {
      compute: {
        expr: (alias) => r.parseExpr({ kind: 'binary', op: '*', left: ref(alias, 'balance'), right: lit(2) }),
      },
    },
    tag: { compute: { sql: () => SqlText.raw("'sql'"), run: () => Value.of('run') } },
    legacyNote: { name: 'note' },
    secret: {
      access: {
        expr: (alias) => r.parseExpr({ kind: 'comparison', op: '=', left: ref(alias, 'owner'), right: lit(1) }),
      },
    },
    masked: { name: 'secret', access: { expr: () => false } },
  },
});

describe('backing: computed fields', () => {
  it('a dual `compute.expr` resolves the same value in run AND toSQL', async () => {
    const fx = accountFixture(fieldsBacking);
    const result = await fx.engine.run(selectField('doubled'));
    expect(result.rows.map((r) => r['doubled'])).toEqual([200, 100]);

    const { sql } = fx.engine.toSQL(selectField('doubled'), 'base');
    expect(sql).toContain('"account"."balance" * ');
    expect(sql).toContain('AS "doubled"');
  });

  it('a `compute` with both `sql` and `run` uses the right variant per mode', async () => {
    const fx = accountFixture(fieldsBacking);
    const result = await fx.engine.run(selectField('tag'));
    expect(result.rows.map((r) => r['tag'])).toEqual(['run', 'run']);

    const { sql } = fx.engine.toSQL(selectField('tag'), 'base');
    expect(sql).toContain("'sql' AS \"tag\"");
  });

  it('a `name`-remapped field reads the underlying stored column', async () => {
    const fx = accountFixture(fieldsBacking);
    const result = await fx.engine.run(selectField('legacyNote'));
    expect(result.rows.map((r) => r['legacyNote'])).toEqual(['n1', 'n2']);

    const { sql } = fx.engine.toSQL(selectField('legacyNote'), 'base');
    expect(sql).toContain('"account"."note" AS "legacyNote"');
  });
});

describe('backing: field-level security (FLS)', () => {
  it('a predicate `access` emits CASE in SQL and nulls the value in runtime', async () => {
    const fx = accountFixture(fieldsBacking);
    const result = await fx.engine.run(selectField('secret'));
    // owner 1 sees the secret; owner 2 is gated to NULL.
    expect(result.rows.map((r) => r['secret'])).toEqual(['s1', null]);

    const { sql } = fx.engine.toSQL(selectField('secret'), 'base');
    expect(sql).toContain('CASE WHEN');
    expect(sql).toContain('ELSE NULL END');
  });

  it('a static-deny `access` (false) is always NULL', async () => {
    const fx = accountFixture(fieldsBacking);
    const result = await fx.engine.run(selectField('masked'));
    expect(result.rows.map((r) => r['masked'])).toEqual([null, null]);

    const { sql } = fx.engine.toSQL(selectField('masked'), 'base');
    expect(sql).toContain('NULL AS "masked"');
    expect(sql).not.toContain('CASE WHEN');
  });
});

describe('backing: row-level security (RLS) + real source table', () => {
  /** RLS: only rows owned by user 1; real source `accounts_tbl`. */
  const rlsBacking = (r: Registry): TypeBacking => ({
    name: 'accounts_tbl',
    access: {
      expr: (alias) => r.parseExpr({ kind: 'comparison', op: '=', left: ref(alias, 'owner'), right: lit(1) }),
    },
  });

  it('filters rows in run AND appears in the emitted WHERE', async () => {
    const fx = accountFixture(rlsBacking);
    const result = await fx.engine.run(selectField('id'));
    expect(result.rows.map((r) => r['id'])).toEqual([1]);

    const { sql } = fx.engine.toSQL(selectField('id'), 'base');
    expect(sql).toContain('WHERE');
    expect(sql).toContain('"account"."owner" = ');
  });

  it('emits the real source name in FROM, aliased to the Type name', () => {
    const fx = accountFixture(rlsBacking);
    const { sql } = fx.engine.toSQL(selectField('id'), 'base');
    expect(sql).toContain('FROM "accounts_tbl" AS "account"');
  });

  it('a static-deny RLS (false) drops all rows in run and emits WHERE FALSE', async () => {
    const denyBacking = (): TypeBacking => ({ access: { expr: () => false } });
    const fx = accountFixture(denyBacking);
    const result = await fx.engine.run(selectField('id'));
    expect(result.rows.length).toBe(0);

    const { sql } = fx.engine.toSQL(selectField('id'), 'base');
    expect(sql).toContain('WHERE FALSE');
  });

  it('a Type with NO backing behaves exactly as before (plain stored field)', () => {
    const fx = accountFixture(() => ({}));
    const { sql } = fx.engine.toSQL(selectField('balance'), 'base');
    expect(sql).toContain('FROM "account" AS "account"');
    expect(sql).toContain('"account"."balance" AS "balance"');
  });
});
