/**
 * Proving test for ALIAS-CORRECTNESS of the Type-backing layer.
 *
 * Every backing factory (`Access` / `Computed` / `JoinBacking`, in all of its
 * `expr` / `sql` / `run` variants) is handed the ALIAS the Type is bound under
 * for THIS occurrence and MUST use it for every reference — never a hardcoded
 * type name. This test binds ONE backed Type (`proj`) TWICE in a single query
 * (a relation self-join: `FROM proj JOIN proj.parent AS p2`), so two instances
 * coexist under different aliases (`proj` and `p2`). It then asserts:
 *   - `engine.run` resolves each backing against the correct aliased source, so
 *     per-instance values DIFFER (each reads its own row), covering the
 *     `compute.expr`, `compute.run`, `compute.sql`(→ stored), FLS `access.expr`,
 *     named-join `expr` (relation) and named-join `run` (attach) paths; and
 *   - `engine.toSQL(..., 'base' | 'postgres')` emits every backing referencing
 *     the correct ALIAS (`"p2"."balance"`, the FLS `CASE` on `"p2"."owner"`, the
 *     RLS `WHERE` / join-`ON` on `"p2"."orgId"`, `joinAlias('p2','owner')`),
 *     NOT the bare type name.
 *
 * Under the pre-fix `run` signature (which received no alias) a runtime backing
 * was forced to hardcode `row['proj']`, so the `p2` instance would read the
 * WRONG row — the guarantee this test protects.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { SqlText } from '../sql/emit';
import { Value } from '../runtime/value';
import { joinAlias } from '../backing';
import { ref, lit, cmp } from './_utils';
import type { Registry } from '../registry';
import type { TypeBacking } from '../backing';
import type { TypeDef, SelectDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

/** A minimal `user` Type — the `owner` relation target. */
const userDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: ref('user', 'id'), count: 1 }] }],
  count: 10,
  bytes: 16,
};

/**
 * The conceptual `proj` Type. `orgId` / `owner` / `parent` are stored FKs; the
 * rest of the interesting surface is BACKED. `parent` is a self belongs-to used
 * to bind a SECOND `proj` instance under a non-default alias.
 */
const projDef: TypeDef = {
  name: 'proj',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'orgId', type: { kind: 'number', whole: true } },
    { name: 'balance', type: { kind: 'number', whole: true } },
    { name: 'secret', type: { kind: 'text' }, nullable: true },
    { name: 'owner', type: { kind: 'relation', to: 'user', count: 1 } },
    { name: 'parent', type: { kind: 'relation', to: 'proj', count: 1 }, nullable: true },
    // Backed (computed / joined / gated):
    { name: 'dbl', type: { kind: 'number' }, nullable: true },
    { name: 'label', type: { kind: 'text' }, nullable: true },
    { name: 'ownerName', type: { kind: 'text' }, nullable: true },
    { name: 'runMark', type: { kind: 'number' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: ref('proj', 'id'), count: 1 }] }],
  count: 100,
  bytes: 64,
};

const userRows: SourceRecord[] = [
  { id: 10, name: 'Ann' },
  { id: 20, name: 'Bob' },
];
const projRows: SourceRecord[] = [
  { id: 1, orgId: 1, balance: 100, secret: 's1', owner: 10, parent: 2 },
  { id: 2, orgId: 1, balance: 50, secret: 's2', owner: 20, parent: null },
];

/**
 * The backing — every factory references the passed `alias`, never `'proj'`.
 *  - RLS `access.expr`         gates on `<alias>.orgId`.
 *  - `dbl`  `compute.expr`     reads `<alias>.balance * 2` (dual: run + SQL).
 *  - `label` `compute.sql/run` formats `<alias>.balance` per mode.
 *  - `secret` FLS `access.expr` gates on `<alias>.owner`.
 *  - `owner` join `expr`       relation join off `<alias>`; `ownerName` reads it.
 *  - `runJoin` join `run`      attaches a record derived from `outer[<alias>]`;
 *    `runMark` `compute.run` reads it back off `joinAlias(alias,'runJoin')`.
 */
const backing = (r: Registry): TypeBacking => ({
  name: 'projects',
  access: {
    expr: (alias) => r.parseExpr(cmp('=', ref(alias, 'orgId'), lit(1))),
  },
  joins: {
    owner: {
      expr: (alias) => ({ kind: 'relation', source: alias, relation: 'owner' }),
    },
    runJoin: {
      // Runtime-only attach: correlate via the OUTER row's `alias` key. Reading
      // `outer[alias]` (never a hardcoded key) is what makes two instances read
      // their OWN outer row.
      run: (alias) => ({
        alias: joinAlias(alias, 'runJoin'),
        attach: (outer) => {
          const rec = outer[alias];
          const id = typeof rec?.['id'] === 'number' ? rec['id'] : 0;
          return { mark: id * 10 };
        },
      }),
    },
  },
  fields: {
    dbl: {
      compute: {
        expr: (alias) => r.parseExpr({ kind: 'binary', op: '*', left: ref(alias, 'balance'), right: lit(2) }),
      },
    },
    label: {
      compute: {
        sql: (alias, ctx) => SqlText.concat([SqlText.raw("'$' || "), ctx.dialect.field(alias, 'balance')]),
        run: (alias, row) => Value.of(`$${row[alias]?.['balance'] ?? 0}`),
      },
    },
    ownerName: {
      joins: ['owner'],
      compute: { expr: (alias) => r.parseExpr(ref(joinAlias(alias, 'owner'), 'name')) },
    },
    secret: {
      access: { expr: (alias) => r.parseExpr(cmp('=', ref(alias, 'owner'), lit(20))) },
    },
    runMark: {
      joins: ['runJoin'],
      compute: {
        run: (alias, row) => {
          const rec = row[joinAlias(alias, 'runJoin')];
          const mark = typeof rec?.['mark'] === 'number' ? rec['mark'] : null;
          return Value.of(mark);
        },
      },
    },
  },
});

function fixture() {
  const registry = createRegistry();
  const proj = registry.parseType(projDef);
  registry.registerType(registry.parseType(userDef));
  registry.registerType(proj, backing(registry));
  registry.finalize();
  const engine = new QueryEngine(registry, {
    executors: { proj: arrayExecutor(projRows), user: arrayExecutor(userRows) },
  });
  return { registry, engine };
}

/**
 * FROM proj (alias `proj`) INNER JOIN proj.parent AS `p2` — two instances of the
 * SAME backed Type coexist, so every projected backing must resolve against its
 * own alias.
 */
const select: SelectDef = {
  kind: 'select',
  fields: [
    { expr: ref('proj', 'id'), as: 'id' },
    { expr: ref('proj', 'dbl'), as: 'dbl' },
    { expr: ref('p2', 'id'), as: 'p2id' },
    { expr: ref('p2', 'dbl'), as: 'p2dbl' },
    { expr: ref('p2', 'label'), as: 'p2label' },
    { expr: ref('p2', 'ownerName'), as: 'p2owner' },
    { expr: ref('p2', 'secret'), as: 'p2secret' },
    { expr: ref('proj', 'runMark'), as: 'projMark' },
    { expr: ref('p2', 'runMark'), as: 'p2Mark' },
  ],
  from: { kind: 'type', type: 'proj' },
  joins: [{ on: { source: 'proj', field: 'parent' }, as: 'p2', joinType: 'inner' }],
  order: [{ expr: ref('proj', 'id'), dir: 'asc' }],
};

describe('backing alias-correctness: two instances of one backed Type', () => {
  it('run() resolves each backing against its own aliased source', async () => {
    const { engine } = fixture();
    const result = await engine.run(select);
    // Only proj id=1 has a (visible) parent (id=2); id=2's parent is NULL ⇒ the
    // INNER self-join yields a single row.
    expect(result.rows.length).toBe(1);
    const row = result.rows[0]!;
    expect(row['id']).toBe(1);
    expect(row['p2id']).toBe(2);
    // compute.expr (balance*2) resolves per instance: proj=100*2, p2=50*2.
    expect(row['dbl']).toBe(200);
    expect(row['p2dbl']).toBe(100);
    // compute.run reads row[alias].balance ⇒ the p2 row's own balance.
    expect(row['p2label']).toBe('$50');
    // named-join expr (owner relation) resolves off p2 ⇒ user 20's name.
    expect(row['p2owner']).toBe('Bob');
    // FLS access.expr gates on p2.owner (=20) ⇒ visible.
    expect(row['p2secret']).toBe('s2');
    // JoinBacking.run + compute.run: the attach reads outer[alias].id, so the
    // two instances produce DIFFERENT marks (proj.id*10 vs p2.id*10).
    expect(row['projMark']).toBe(10);
    expect(row['p2Mark']).toBe(20);
  });

  it('toSQL emits every backing referencing the correct alias (base + postgres)', () => {
    const { engine } = fixture();
    for (const dialect of ['base', 'postgres'] as const) {
      const { sql } = engine.toSQL(select, dialect);
      // Real source table, aliased to the Type name for the FROM instance.
      expect(sql).toContain('FROM "projects" AS "proj"');
      // compute.expr lowered against BOTH aliases.
      expect(sql).toContain('"proj"."balance" * ');
      expect(sql).toContain('"p2"."balance" * ');
      // compute.sql (label) formats the p2 alias's column.
      expect(sql).toContain('"p2"."balance"');
      // named-join expr ⇒ owner join under joinAlias('p2','owner').
      expect(sql).toContain(`"${joinAlias('p2', 'owner')}"."name" AS "p2owner"`);
      // FLS CASE gating the p2 instance on its own alias.
      expect(sql).toContain('CASE WHEN');
      expect(sql).toContain('"p2"."owner" = ');
      expect(sql).toContain('ELSE NULL END');
      // RLS references the correct alias for BOTH occurrences (FROM WHERE + join ON).
      expect(sql).toContain('"proj"."orgId" = ');
      expect(sql).toContain('"p2"."orgId" = ');
    }
  });
});
