/**
 * Coverage: RLS `allow` / `noop` backing-access branches, and the
 * relation-path → join lowering (`emitRelationPathValue` /
 * `fanoutAggregateInfo`) including the unresolvable / non-relation guards.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { BaseDialect } from '../sql/index';
import { SqlText, SqlContext } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import { emitRelationPathValue, fanoutAggregateInfo } from '../sql/relation-walk';
import { QueryScope } from '../scope';
import type { Registry } from '../registry';
import type { TypeBacking } from '../backing';
import type { TypeDef, SelectDef } from '../schema';
import { fixture } from './_utils';

const dialect = new BaseDialect();

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

/** Build an emit context whose scope binds the fixture's `user` / `order` types. */
function emitCtx() {
  const fx = fixture();
  const scope = new QueryScope();
  scope.bind('user', { kind: 'type', type: fx.user, source: 'user', synthetic: false });
  scope.bind('order', { kind: 'type', type: fx.order, source: 'order', synthetic: false });
  const planner = new JoinCtePlanner(dialect, fx.engine, undefined);
  const ctx = new SqlContext(dialect, fx.engine, scope, planner, undefined);
  return { fx, ctx, planner };
}

const render = (t: SqlText): string => t.render(dialect).sql;

describe('cov relation-walk: emitRelationPathValue', () => {
  it('unresolvable source ⇒ best-effort qualified ref', () => {
    const { ctx } = emitCtx();
    expect(render(emitRelationPathValue(dialect, ctx, 'ghost', ['x']))).toBe('"ghost"."x"');
  });

  it('empty path on a resolvable source ⇒ self-ref fallback', () => {
    const { ctx } = emitCtx();
    expect(render(emitRelationPathValue(dialect, ctx, 'user', []))).toBe('"user"."user"');
  });

  it('scalar first segment ⇒ direct field ref (no join)', () => {
    const { ctx, planner } = emitCtx();
    expect(render(emitRelationPathValue(dialect, ctx, 'user', ['name']))).toBe('"user"."name"');
    expect(planner.emittedJoins().length).toBe(0);
  });

  it('relation hop ending on the relation ⇒ target id', () => {
    const { ctx, planner } = emitCtx();
    expect(render(emitRelationPathValue(dialect, ctx, 'order', ['userId']))).toBe('"order_userId"."id"');
    expect(planner.emittedJoins().length).toBe(1);
  });

  it('relation hop then scalar ⇒ joined column', () => {
    const { ctx, planner } = emitCtx();
    expect(render(emitRelationPathValue(dialect, ctx, 'order', ['userId', 'name']))).toBe('"order_userId"."name"');
    expect(planner.emittedJoins().length).toBe(1);
  });

  it('relation to an UNREGISTERED target ⇒ best-effort ref (no join)', () => {
    const { ctx, planner } = ghostCtx();
    expect(render(emitRelationPathValue(dialect, ctx, 'doc', ['ghost', 'x']))).toBe('"doc"."ghost"');
    expect(planner.emittedJoins().length).toBe(0);
  });
});

describe('cov relation-walk: fanoutAggregateInfo guards', () => {
  it('returns info for a fan-out hop (path length 1 ⇒ argField *)', () => {
    const { ctx } = emitCtx();
    const info = fanoutAggregateInfo(ctx, 'user', ['orders']);
    expect(info).toBeDefined();
    expect(info!.argField).toBe('*');
    expect(info!.targetType.name).toBe('order');
  });

  it('returns info for a fan-out hop ending on a scalar (length 2)', () => {
    const { ctx } = emitCtx();
    const info = fanoutAggregateInfo(ctx, 'user', ['orders', 'total']);
    expect(info!.argField).toBe('total');
  });

  it('undefined for path length 0 or > 2', () => {
    const { ctx } = emitCtx();
    expect(fanoutAggregateInfo(ctx, 'user', [])).toBeUndefined();
    expect(fanoutAggregateInfo(ctx, 'user', ['orders', 'total', 'extra'])).toBeUndefined();
  });

  it('undefined for an unresolvable source', () => {
    const { ctx } = emitCtx();
    expect(fanoutAggregateInfo(ctx, 'ghost', ['orders'])).toBeUndefined();
  });

  it('undefined for an unknown field / a scalar field', () => {
    const { ctx } = emitCtx();
    expect(fanoutAggregateInfo(ctx, 'user', ['nope'])).toBeUndefined();
    expect(fanoutAggregateInfo(ctx, 'user', ['name'])).toBeUndefined();
  });

  it('undefined for a belongs-to (count 1) relation', () => {
    const { ctx } = emitCtx();
    expect(fanoutAggregateInfo(ctx, 'order', ['userId'])).toBeUndefined();
  });

  it('undefined when the fan-out target type is unregistered', () => {
    const { ctx } = ghostCtx();
    expect(fanoutAggregateInfo(ctx, 'doc', ['ghosts'])).toBeUndefined();
  });
});

/** A context whose `doc` type has relations to an UNREGISTERED `missing` type. */
function ghostCtx() {
  const registry: Registry = createRegistry();
  const docDef: TypeDef = {
    name: 'doc',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      // belongs-to a type that is never registered
      { name: 'ghost', type: { kind: 'relation', to: 'missing', count: 1 } },
      // has-many a type that is never registered (fan-out target missing)
      { name: 'ghosts', type: { kind: 'relation', to: 'missing', count: 5 } },
    ],
    indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'doc', field: 'id' }, count: 1 }] }],
    count: 10,
    bytes: 16,
  };
  const doc = registry.parseType(docDef);
  registry.registerType(doc);
  const engine = new QueryEngine(registry);
  const scope = new QueryScope();
  scope.bind('doc', { kind: 'type', type: doc, source: 'doc', synthetic: false });
  const planner = new JoinCtePlanner(dialect, engine, undefined);
  const ctx = new SqlContext(dialect, engine, scope, planner, undefined);
  return { ctx, planner };
}
