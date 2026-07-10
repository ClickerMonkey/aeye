/**
 * Coverage driver for the reference / placeholder exprs:
 *   field-ref.ts, subquery.ts, filters.ts, _shared.ts, index.ts
 *
 * Exercises every public method across BOTH execution modes (runtime evaluate +
 * SQL emit in `base` and `postgres`), every Problem code / branch, cost, the
 * serialization surface (toJSON / clone / toCode / forEachChild), the named-join
 * / compute / FLS backing branches of `field-ref`, and the shared `_shared`
 * helpers + the folded `exprDefSchema`.
 */
import { describe, it, expect } from 'vitest';
import {
  fixture,
  typeScope,
  runtimeFixture,
  lit,
  ref,
  cmp,
  userTypeDef,
  orderTypeDef,
  userRows,
  orderRows,
} from './_utils';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { RuntimeContext } from '../runtime/context';
import { FieldRefExpr } from '../exprs/field-ref';
import { SubqueryExpr } from '../exprs/subquery';
import { FiltersExpr } from '../exprs/filters';
import { exprDefSchema, BUILTIN_EXPRS } from '../exprs/index';
import {
  computed,
  boolResult,
  numberResult,
  textResult,
  gatherSources,
  anyNullable,
  anyAggregate,
  categoryOf,
  looseExprSchema,
  childExprSchema,
  childQuerySchema,
} from '../exprs/_shared';
import { asFieldType } from '../resolved-type';
import { NumberFieldType } from '../field-types/index';
import { SqlText } from '../sql/emit';
import { joinAlias } from '../backing';
import { Value } from '../runtime/value';
import type { Registry } from '../registry';
import type { TypeBacking } from '../backing';
import type { ExprDef, QueryDef, SelectDef, TypeDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

// ─── field-ref.ts ────────────────────────────────────────────────────────────

describe('field-ref: resolve / validate / cost / serialization', () => {
  const fx = fixture();
  const scope = typeScope(fx);

  it('resolves a known field, an unknown source, and an unknown field', () => {
    const ok = fx.engine.resolveExpr(ref('u', 'name'), scope);
    expect(ok.kind).toBe('field');
    if (ok.kind === 'field') {
      expect(ok.field.name).toBe('name');
      expect(ok.nullable).toBe(false);
    }
    // unknown source ⇒ nullable text placeholder
    expect(fx.engine.resolveExpr(ref('nope', 'x'), scope).kind).toBe('computed');
    // known source, unknown field ⇒ placeholder
    expect(fx.engine.resolveExpr(ref('u', 'nope'), scope).kind).toBe('computed');
  });

  it('resolve falls back to a placeholder when the bound source is not a type', () => {
    const s = fx.engine.globalScope();
    s.bind('c', { kind: 'computed', fieldType: new NumberFieldType(), sources: [], nullable: false, aggregate: false });
    expect(fx.engine.resolveExpr(ref('c', 'x'), s).kind).toBe('computed');
  });

  it('validateWalk reports unknown-source / not-a-type / unknown-field, and passes a good ref', () => {
    expect(fx.engine.validateExpr(ref('nope', 'x'), scope).list.some((p) => p.code === 'ref.unknown-source')).toBe(true);

    const s = fx.engine.globalScope();
    s.bind('c', { kind: 'computed', fieldType: new NumberFieldType(), sources: [], nullable: false, aggregate: false });
    expect(fx.engine.validateExpr(ref('c', 'x'), s).list.some((p) => p.code === 'ref.not-a-type')).toBe(true);

    expect(fx.engine.validateExpr(ref('u', 'nope'), scope).list.some((p) => p.code === 'ref.unknown-field')).toBe(true);
    expect(fx.engine.validateExpr(ref('u', 'name'), scope).hasErrors).toBe(false);
  });

  it('cost is zero rows + the field byte size; serialization round-trips', () => {
    const e = fx.engine.parse(ref('u', 'name'));
    const c = e.cost(fx.engine, scope);
    expect(c.rows).toBe(0);
    expect(c.bytes).toBeGreaterThanOrEqual(0);
    expect(e.toJSON()).toEqual({ kind: 'field-ref', source: 'u', field: 'name' });
    expect(e.clone().toJSON()).toEqual(e.toJSON());
    expect(e.toCode()).toBe('u.name');
    let n = 0;
    e.forEachChild(() => n++);
    expect(n).toBe(0);
  });

  it('static `from` rejects a mismatched kind', () => {
    expect(() => FieldRefExpr.from(lit(1), fx.registry)).toThrow(/expected 'field-ref'/);
  });

  it('evaluate returns NULL for a null row, a missing source, and reads a plain field', async () => {
    const rfx = runtimeFixture();
    const ctx = new RuntimeContext(rfx.engine);
    expect((await rfx.engine.parse(ref('user', 'name')).evaluate(ctx, null)).isNull()).toBe(true);
    // a row that does not contain the source ⇒ NULL (no type metadata path)
    const missing = await rfx.engine.parse(ref('u', 'name')).evaluate(ctx, { other: { id: 1 } });
    expect(missing.isNull()).toBe(true);
    // a present plain field
    const v = await rfx.engine.parse(ref('user', 'name')).evaluate(ctx, { user: { id: 1, name: 'Ada' } });
    expect(v.raw).toBe('Ada');
  });
});

// ─── field-ref.ts — backing branches (compute / access / named joins) ────────

/** Conceptual `org` Type (relation target). */
const orgDef: TypeDef = {
  name: 'org',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'tier', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: ref('org', 'id'), count: 1 }] }],
  count: 10,
  bytes: 32,
};

/** Conceptual `order` Type (lateral source). */
const ordDef: TypeDef = {
  name: 'order',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'accountId', type: { kind: 'number', whole: true } },
    { name: 'total', type: { kind: 'money', currency: 'USD' } },
  ],
  indexes: [{ exprs: [{ expr: ref('order', 'id'), count: 1 }] }],
  count: 100,
  bytes: 32,
};

/** Conceptual `widget` Type — REGISTERED but given NO executor in `backedFixture`. */
const widgetDef: TypeDef = {
  name: 'widget',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: ref('widget', 'id'), count: 1 }] }],
  count: 5,
  bytes: 16,
};

/** Conceptual `account` Type with every flavor of backed field. */
const accountDef: TypeDef = {
  name: 'account',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'owner', type: { kind: 'number', whole: true } },
    { name: 'balance', type: { kind: 'money', currency: 'USD' }, nullable: true },
    { name: 'note', type: { kind: 'text' }, nullable: true },
    { name: 'org', type: { kind: 'relation', to: 'org', count: 1 } },
    // a relation to an UNREGISTERED type (drives the target-undefined guards)
    { name: 'ghostRel', type: { kind: 'relation', to: 'ghosttype', count: 1 } },
    // computed
    { name: 'doubled', type: { kind: 'number' }, nullable: true },
    { name: 'runOnly', type: { kind: 'number' }, nullable: true },
    { name: 'sqlOnly', type: { kind: 'text' }, nullable: true },
    { name: 'legacyNote', type: { kind: 'text' }, nullable: true },
    // FLS
    { name: 'accPred', type: { kind: 'text' }, nullable: true },
    { name: 'accDeny', type: { kind: 'text' }, nullable: true },
    { name: 'accAllow', type: { kind: 'text' }, nullable: true },
    { name: 'accNoop', type: { kind: 'text' }, nullable: true },
    // named joins
    { name: 'orgName', type: { kind: 'text' }, nullable: true },
    { name: 'topPick', type: { kind: 'number' }, nullable: true },
    { name: 'sqlJoinField', type: { kind: 'text' }, nullable: true },
    { name: 'runJoinField', type: { kind: 'text' }, nullable: true },
    { name: 'missingJoinField', type: { kind: 'text' }, nullable: true },
    { name: 'relNoRelField', type: { kind: 'text' }, nullable: true },
    { name: 'relNoSrcField', type: { kind: 'text' }, nullable: true },
    { name: 'relNoTargetField', type: { kind: 'text' }, nullable: true },
    // added (coverage gaps): a relation to a registered-but-no-executor Type, a
    // field reading it, and a field opting into a lateral that omits `joinType`.
    { name: 'widget', type: { kind: 'relation', to: 'widget', count: 1 }, nullable: true },
    { name: 'widgetField', type: { kind: 'text' }, nullable: true },
    { name: 'latNoTypeField', type: { kind: 'number' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: ref('account', 'id'), count: 1 }] }],
  count: 100,
  bytes: 64,
};

const orgRows: SourceRecord[] = [
  { id: 1, name: 'Acme', tier: 'gold' },
  { id: 2, name: 'Beta', tier: 'silver' },
];
const accountRows: SourceRecord[] = [
  { id: 1, owner: 1, balance: 100, note: 'n1', org: 1, sqlJoinField: 'sj1', runJoinField: 'rj1' },
  { id: 2, owner: 2, balance: 50, note: 'n2', org: 2, sqlJoinField: 'sj2', runJoinField: 'rj2' },
  // added (coverage gaps): a DANGLING org FK (no matching org ⇒ relation match miss)
  // and NO orders at all (⇒ the `lat` lateral returns zero rows for this outer row).
  { id: 3, owner: 3, balance: 0, note: 'n3', org: 999, sqlJoinField: 'sj3', runJoinField: 'rj3' },
];
const ordRows: SourceRecord[] = [
  { id: 10, accountId: 1, total: 30 },
  { id: 11, accountId: 1, total: 70 },
  { id: 12, accountId: 2, total: 200 },
];

/** The rich backing exercising compute / FLS / named-join branches. */
const richBacking = (r: Registry): TypeBacking => ({
  joins: {
    orgJoin: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'org' }) },
    lat: {
      expr: () => ({
        kind: 'lateral',
        pick: 'total',
        joinType: 'left',
        query: (outer) => ({
          kind: 'select',
          fields: [{ expr: ref('order', 'total'), as: 'total' }],
          from: { kind: 'type', type: 'order' },
          where: [cmp('=', ref('order', 'accountId'), ref(outer, 'id'))],
          order: [{ expr: ref('order', 'total'), dir: 'desc' }],
          limit: 1,
        }),
      }),
    },
    // a raw-SQL-only join: SQL ⇒ requireRawJoin; runtime ⇒ 'none' (no run/expr)
    sqlJoin: {
      sql: () =>
        SqlText.raw('LEFT JOIN "org" AS "account__sqlJoin" ON "account"."org" = "account__sqlJoin"."id"'),
    },
    // a run-only join: runtime ⇒ 'attach'; SQL ⇒ 'none' (no sql/expr)
    runJoin: {
      run: (alias) => ({
        alias: joinAlias(alias, 'runJoin'),
        attach: () => null,
      }),
    },
    // negative relation specs (defensive early-returns in lower/attach)
    relNoRel: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'nope' }) },
    relNoSrc: { expr: () => ({ kind: 'relation', source: 'ghostsrc', relation: 'org' }) },
    relNoTarget: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'ghostRel' }) },
    // a relation join whose target Type is REGISTERED but has NO executor:
    // `recordsFor` yields an empty list ⇒ no match ⇒ the bound row is `{}`.
    widgetJoin: { expr: (alias) => ({ kind: 'relation', source: alias, relation: 'widget' }) },
    // a lateral join that OMITS `joinType` (SQL lowers it to the default LEFT).
    latNoType: {
      expr: () => ({
        kind: 'lateral',
        pick: 'total',
        query: (outer) => ({
          kind: 'select',
          fields: [{ expr: ref('order', 'total'), as: 'total' }],
          from: { kind: 'type', type: 'order' },
          where: [cmp('=', ref('order', 'accountId'), ref(outer, 'id'))],
          order: [{ expr: ref('order', 'total'), dir: 'desc' }],
          limit: 1,
        }),
      }),
    },
  },
  fields: {
    doubled: { compute: { expr: (alias) => r.parseExpr({ kind: 'binary', op: '*', left: ref(alias, 'balance'), right: lit(2) }) } },
    runOnly: { compute: { run: () => Value.of(7) } },
    sqlOnly: { compute: { sql: () => SqlText.raw("'sqlval'") } },
    legacyNote: { name: 'note' },
    accPred: { name: 'note', access: { expr: (alias) => r.parseExpr(cmp('=', ref(alias, 'owner'), lit(1))) } },
    accDeny: { name: 'note', access: { expr: () => false } },
    accAllow: { name: 'note', access: { expr: () => true } },
    accNoop: { name: 'note', access: { expr: () => undefined } },
    orgName: { joins: ['orgJoin'], compute: { expr: () => r.parseExpr(ref(joinAlias('account', 'orgJoin'), 'name')) } },
    topPick: { joins: ['lat'] },
    sqlJoinField: { joins: ['sqlJoin'] },
    runJoinField: { joins: ['runJoin'] },
    missingJoinField: { joins: ['doesNotExist'] },
    relNoRelField: { joins: ['relNoRel'] },
    relNoSrcField: { joins: ['relNoSrc'] },
    relNoTargetField: { joins: ['relNoTarget'] },
    widgetField: { joins: ['widgetJoin'], compute: { expr: () => r.parseExpr(ref(joinAlias('account', 'widgetJoin'), 'name')) } },
    latNoTypeField: { joins: ['latNoType'] },
  },
});

function backedFixture() {
  const registry = createRegistry();
  const account = registry.parseType(accountDef);
  registry.registerType(registry.parseType(orgDef));
  registry.registerType(registry.parseType(ordDef));
  // `widget` is registered but intentionally given NO executor below.
  registry.registerType(registry.parseType(widgetDef));
  registry.registerType(account, richBacking(registry));
  registry.finalize();
  const engine = new QueryEngine(registry, {
    executors: {
      account: arrayExecutor(accountRows),
      org: arrayExecutor(orgRows),
      order: arrayExecutor(ordRows),
    },
  });
  return { registry, engine };
}

/** SELECT <fields...> FROM account. */
function selectAccount(...fields: string[]): SelectDef {
  return {
    kind: 'select',
    fields: fields.map((f) => ({ expr: ref('account', f), as: f })),
    from: { kind: 'type', type: 'account' },
    order: [{ expr: ref('account', 'id'), dir: 'asc' }],
  };
}

describe('field-ref: backing — runtime evaluate', () => {
  const all = [
    'id', 'doubled', 'runOnly', 'sqlOnly', 'legacyNote',
    'accPred', 'accDeny', 'accAllow', 'accNoop',
    'orgName', 'topPick', 'sqlJoinField', 'runJoinField', 'missingJoinField',
    'relNoRelField', 'relNoSrcField', 'relNoTargetField',
  ];

  it('resolves compute / FLS / named joins per-row in memory', async () => {
    const fx = backedFixture();
    const result = await fx.engine.run(selectAccount(...all));
    const r0 = result.rows[0]!;
    const r1 = result.rows[1]!;
    // compute.expr (balance*2), compute.run (7), compute.sql falls back to stored (null)
    expect(r0['doubled']).toBe(200);
    expect(r0['runOnly']).toBe(7);
    expect(r0['sqlOnly']).toBeNull();
    // name-remapped stored read
    expect(r0['legacyNote']).toBe('n1');
    // FLS: predicate visible for owner 1 only; deny always null; allow/noop pass
    expect(r0['accPred']).toBe('n1');
    expect(r1['accPred']).toBeNull();
    expect(r0['accDeny']).toBeNull();
    expect(r0['accAllow']).toBe('n1');
    expect(r0['accNoop']).toBe('n1');
    // relation named join (orgName) + lateral pick (topPick = largest order)
    expect(r0['orgName']).toBe('Acme');
    expect(r0['topPick']).toBe(70);
    expect(r1['topPick']).toBe(200);
    // sql-only join has no runtime attach ⇒ field reads its stored column
    expect(r0['sqlJoinField']).toBe('sj1');
    // run-only join attaches (null ⇒ {}) ; the field has no compute ⇒ stored
    expect(r0['runJoinField']).toBe('rj1');
    // missing + negative-relation joins resolve harmlessly to the stored column
    expect(r0['missingJoinField']).toBeNull();
    expect(r0['relNoRelField']).toBeNull();
  });
});

describe('field-ref: backing — SQL emission (base + postgres)', () => {
  const fields = [
    'doubled', 'runOnly', 'sqlOnly', 'legacyNote',
    'accPred', 'accDeny', 'accAllow', 'accNoop',
    'orgName', 'topPick', 'sqlJoinField', 'runJoinField', 'missingJoinField',
    'relNoRelField', 'relNoSrcField', 'relNoTargetField',
  ];

  it('lowers compute / FLS / joins to SQL in both dialects', () => {
    const fx = backedFixture();
    for (const dialect of ['base', 'postgres'] as const) {
      const { sql } = fx.engine.toSQL(selectAccount(...fields), dialect);
      // compute.expr → arithmetic; compute.sql → raw; compute.run → stored fallback
      expect(sql).toContain('"account"."balance" * ');
      expect(sql).toContain("'sqlval' AS \"sqlOnly\"");
      expect(sql).toContain('"account"."runOnly" AS "runOnly"');
      // name remap
      expect(sql).toContain('"account"."note" AS "legacyNote"');
      // FLS: predicate ⇒ CASE; deny ⇒ NULL; allow/noop ⇒ raw value
      expect(sql).toContain('CASE WHEN');
      expect(sql).toContain('ELSE NULL END');
      expect(sql).toContain('NULL AS "accDeny"');
      // relation join + lateral + raw join
      expect(sql).toContain('"account__orgJoin"."name" AS "orgName"');
      expect(sql).toContain('LEFT JOIN LATERAL (');
      expect(sql).toContain('LEFT JOIN "org" AS "account__sqlJoin"');
    }
  });

  it('postgres lateral uses ON true', () => {
    const fx = backedFixture();
    const { sql } = fx.engine.toSQL(selectAccount('topPick'), 'postgres');
    expect(sql).toContain(') AS "account__lat" ON true');
  });
});

describe('field-ref: backing — coverage gaps (lateral miss / relation miss / no joinType)', () => {
  it('a dangling relation FK and an empty lateral both resolve to NULL', async () => {
    const fx = backedFixture();
    // account id=3 has a dangling org FK (no matching org row) and NO orders.
    const result = await fx.engine.run(selectAccount('id', 'orgName', 'topPick'));
    const r2 = result.rows[2]!;
    expect(r2['id']).toBe(3);
    // relation named-join: no target record matches ⇒ bound row `{}` ⇒ NULL.
    expect(r2['orgName']).toBeNull();
    // lateral: the correlated subquery returns zero rows ⇒ bound row `{}` ⇒ NULL.
    expect(r2['topPick']).toBeNull();
  });

  it('a relation named-join whose target Type has no executor resolves to NULL', async () => {
    const fx = backedFixture();
    // `widget` is registered but has no executor ⇒ recordsFor is empty ⇒ no match.
    const result = await fx.engine.run(selectAccount('id', 'widgetField'));
    expect(result.rows[0]!['widgetField']).toBeNull();
  });

  it('a lateral join spec that omits joinType lowers to LEFT JOIN LATERAL', () => {
    const fx = backedFixture();
    const { sql } = fx.engine.toSQL(selectAccount('latNoTypeField'), 'postgres');
    expect(sql).toContain('LEFT JOIN LATERAL (');
    expect(sql).toContain('AS "account__latNoType"');
  });
});

// ─── subquery.ts ─────────────────────────────────────────────────────────────

describe('subquery', () => {
  const fx = fixture();
  const scope = typeScope(fx);
  const scalarSub: ExprDef = {
    kind: 'subquery',
    query: { kind: 'select', fields: [{ expr: ref('o', 'total') }], from: { kind: 'type', type: 'order' }, limit: 1 },
  };

  it('resolves a scalar subquery to its single output field type', () => {
    expect(asFieldType(fx.engine.resolveExpr(scalarSub, scope))?.resolve()).toBe('money');
  });

  it('validateWalk infers the output type (no structural error for a scalar select)', () => {
    expect(fx.engine.validateExpr(scalarSub, scope).hasErrors).toBe(false);
  });

  it('cost runs the inner query in a child scope', () => {
    expect(fx.engine.parse(scalarSub).cost(fx.engine, scope).bytes).toBeGreaterThanOrEqual(0);
  });

  it('serialization round-trips; static `from` rejects a mismatched kind', () => {
    const e = fx.engine.parse(scalarSub);
    expect(e.toJSON()).toEqual(scalarSub);
    expect(e.clone().toJSON()).toEqual(scalarSub);
    expect(e.toCode()).toBe('(subquery)');
    expect(() => SubqueryExpr.from(lit(1), fx.registry)).toThrow(/expected 'subquery'/);
  });

  it('evaluates: correlated per-row, non-correlated, and an empty result ⇒ NULL', async () => {
    const rfx = runtimeFixture();
    // correlated: sum of each user's orders (inner WHERE reads the OUTER user.id)
    const correlated: SelectDef = {
      kind: 'select',
      fields: [
        { expr: ref('user', 'id'), as: 'id' },
        {
          expr: {
            kind: 'subquery',
            query: {
              kind: 'select',
              fields: [{ expr: { kind: 'aggregate', function: 'sum', args: { value: ref('order', 'total') } } }],
              from: { kind: 'type', type: 'order' },
              where: [cmp('=', ref('order', 'userId'), ref('user', 'id'))],
            },
          },
          as: 'spent',
        },
      ],
      from: { kind: 'type', type: 'user' },
      order: [{ expr: ref('user', 'id'), dir: 'asc' }],
    };
    const rows = (await rfx.engine.run(correlated)).rows;
    expect(rows[0]).toEqual({ id: 1, spent: 150 });
    expect(rows[2]).toEqual({ id: 3, spent: null }); // Cleo has no orders

    // non-correlated direct evaluate with a null row
    const ctx = new RuntimeContext(rfx.engine);
    const countAll: ExprDef = {
      kind: 'subquery',
      query: { kind: 'select', fields: [{ expr: { kind: 'aggregate', function: 'count', args: {} } }], from: { kind: 'type', type: 'order' } },
    };
    expect((await rfx.engine.parse(countAll).evaluate(ctx, null)).raw).toBe(4);

    // empty result ⇒ NULL
    const empty: ExprDef = {
      kind: 'subquery',
      query: { kind: 'select', fields: [{ expr: ref('order', 'total') }], from: { kind: 'type', type: 'order' }, where: [cmp('=', ref('order', 'id'), lit(-1))] },
    };
    expect((await rfx.engine.parse(empty).evaluate(ctx, null)).isNull()).toBe(true);
  });

  it('emits a parenthesized subquery in both dialects', () => {
    const fx2 = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: scalarSub, as: 'x' }],
      from: { kind: 'type', type: 'user' },
    };
    for (const d of ['base', 'postgres'] as const) {
      const sql = fx2.engine.toSQL(def, d).sql;
      expect(sql).toContain('(SELECT');
    }
  });
});

// ─── filters.ts ──────────────────────────────────────────────────────────────

describe('filters', () => {
  const fx = fixture();
  const scope = typeScope(fx);

  it('resolves to a boolean predicate', () => {
    expect(asFieldType(fx.engine.resolveExpr({ kind: 'filters', source: 'u' }, scope))?.resolve()).toBe('bool');
  });

  it('validateWalk reports unknown-source / unknown-field and passes a clean placeholder', () => {
    expect(fx.engine.validateExpr({ kind: 'filters', source: 'nope' }, scope).list.some((p) => p.code === 'filters.unknown-source')).toBe(true);
    const p = fx.engine.validateExpr({ kind: 'filters', source: 'u', fields: ['nope'] }, scope);
    const prob = p.list.find((x) => x.code === 'filters.unknown-field');
    expect(prob?.path).toEqual(['fields', 0]);
    expect(fx.engine.validateExpr({ kind: 'filters', source: 'u' }, scope).hasErrors).toBe(false);
  });

  it('serialization round-trips (with and without an allowlist); cost; forEachChild', () => {
    const bare = fx.engine.parse({ kind: 'filters', source: 'u' });
    expect(bare.toJSON()).toEqual({ kind: 'filters', source: 'u' });
    expect(bare.clone().toJSON()).toEqual({ kind: 'filters', source: 'u' });
    expect(bare.toCode()).toBe('filters(u)');
    expect(bare.cost(fx.engine, scope).rows).toBe(0);
    let n = 0;
    bare.forEachChild(() => n++);
    expect(n).toBe(0);

    const listed = fx.engine.parse({ kind: 'filters', source: 'u', fields: ['age', 'email'] });
    expect(listed.toJSON()).toEqual({ kind: 'filters', source: 'u', fields: ['age', 'email'] });
    expect(listed.clone().toJSON()).toEqual({ kind: 'filters', source: 'u', fields: ['age', 'email'] });
    expect(listed.toCode()).toBe('filters(u, [age, email])');
  });

  it('static `from` rejects a mismatched kind', () => {
    expect(() => FiltersExpr.from(lit(1), fx.registry)).toThrow(/expected 'filters'/);
  });

  it('evaluates: vacuous TRUE with no filter, a supplied predicate, and a null row ⇒ false', async () => {
    const rfx = runtimeFixture();
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'filters', source: 'user' }],
    };
    expect((await rfx.engine.run(def)).rows.length).toBe(3);
    const filtered = await rfx.engine.run(def, { filters: { user: cmp('>=', ref('user', 'age'), lit(40)) } });
    expect(filtered.rows.map((r) => r['name'])).toEqual(['Bob']);

    // a null row ⇒ the BoolExpr default evaluates to false
    const ctx = new RuntimeContext(rfx.engine);
    expect((await rfx.engine.parse({ kind: 'filters', source: 'user' }).evaluate(ctx, null)).raw).toBe(false);
  });

  it('emits TRUE with no supplied expr, and the expr when supplied (both dialects)', () => {
    const def: QueryDef = {
      kind: 'select',
      fields: [{ expr: ref('user', 'name'), as: 'name' }],
      from: { kind: 'type', type: 'user' },
      where: [{ kind: 'filters', source: 'user' }],
    };
    for (const d of ['base', 'postgres'] as const) {
      expect(fx.engine.toSQL(def, d).sql).toContain('WHERE TRUE');
      const supplied = fx.engine.toSQL(def, d, { filters: { user: cmp('>=', ref('user', 'age'), lit(40)) } }).sql;
      expect(supplied).toContain('"user"."age"');
    }
  });
});

// ─── _shared.ts ──────────────────────────────────────────────────────────────

describe('_shared helpers', () => {
  const fx = fixture();
  const scope = typeScope(fx);

  it('result builders + source/nullable/aggregate gatherers', () => {
    expect(boolResult([], false).fieldType.resolve()).toBe('bool');
    expect(numberResult([], false).fieldType.resolve()).toBe('number');
    expect(textResult([], true).fieldType.resolve()).toBe('text');
    expect(computed(new NumberFieldType(), [], false, false).kind).toBe('computed');

    const fieldRes = fx.engine.resolveExpr(ref('u', 'name'), scope);
    const ageRes = fx.engine.resolveExpr(ref('u', 'age'), scope);
    const compRes = fx.engine.resolveExpr(cmp('=', ref('u', 'id'), lit(1)), scope);
    const aggRes = fx.engine.resolveExpr({ kind: 'aggregate', function: 'sum', args: { value: ref('o', 'total') } }, scope);

    expect(gatherSources([fieldRes, compRes]).length).toBeGreaterThan(0);
    expect(anyNullable([ageRes])).toBe(true);
    expect(anyNullable([fieldRes])).toBe(false);
    expect(anyAggregate([aggRes])).toBe(true);
    expect(anyAggregate([compRes])).toBe(false);

    // categoryOf over each ResolvedType kind
    expect(categoryOf(fieldRes)).toBe('text'); // field kind
    expect(categoryOf(compRes)).toBe('bool'); // computed kind
  });

  it('loose / child schema slots', () => {
    expect(looseExprSchema().safeParse({ kind: 'x' }).success).toBe(true);
    expect(childExprSchema().safeParse({ kind: 'x' }).success).toBe(true);
    const inner = looseExprSchema();
    expect(childExprSchema(inner)).toBe(inner);
    expect(childQuerySchema().safeParse({ kind: 'x' }).success).toBe(true);
    expect(childQuerySchema(inner)).toBe(inner);
  });
});

// ─── exprs/index.ts ──────────────────────────────────────────────────────────

describe('exprs/index — folded ExprDef schema', () => {
  it('exprDefSchema() folds every builtin; accepts opts; BUILTIN_EXPRS is non-empty', () => {
    expect(BUILTIN_EXPRS.length).toBeGreaterThan(0);
    const bare = exprDefSchema();
    expect(bare.safeParse({ kind: 'field-ref', source: 'u', field: 'name' }).success).toBe(true);
    const withOpts = exprDefSchema({});
    expect(withOpts.safeParse({ kind: 'literal', value: 1 }).success).toBe(true);
  });
});
