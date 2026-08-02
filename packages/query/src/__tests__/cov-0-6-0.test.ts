/**
 * Coverage completion for the 0.6.0 items — the edges the behavioural tests do
 * not reach: the default `eqSelectivity` seam, `renameJson`'s array branch, an
 * output ref that resolves to nothing, both directions of the closed-set
 * selectivity fold, FLS on a projected relation identity in its ALLOW /
 * PREDICATE shapes, the composite-key `IN`-subquery refusal, DML `RETURNING`
 * validation, and `drillDownInto`'s non-bindable shapes.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { BoolFieldType, TextFieldType } from '../field-types/index';
import { renameSource } from '../index-spec';
import { drillDownInto } from '../transforms/index';
import { cctx } from './_utils';
import type { TypeDef, SelectDef, QueryDef, ExprDef } from '../schema';
import type { TypeBacking } from '../backing';

const statusValues = [{ value: 'open' }, { value: 'closed' }] as const;

/** `ticket.status` and `ticket.tier` both carry closed sets (of different sizes). */
const ticketDef: TypeDef = {
  name: 'ticket',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'status', type: { kind: 'text', values: [...statusValues] } },
    { name: 'tier', type: { kind: 'text', values: [{ value: 'a' }, { value: 'b' }, { value: 'c' }, { value: 'd' }] } },
    { name: 'owner', type: { kind: 'relation', to: 'person', count: 1 }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 32,
};

const personDef: TypeDef = {
  name: 'person',
  fields: [{ name: 'id', type: { kind: 'number', whole: true } }, { name: 'name', type: { kind: 'text' } }],
  identity: 'id',
  count: 100,
  bytes: 24,
};

/** The identity projection's OWN `CASE WHEN` (unset ⇒ NULL) — not an FLS wrapper. */
const IDENTITY_CASE = 'CASE WHEN "ticket"."owner" IS NULL THEN NULL ELSE';

/** How many `CASE WHEN`s the emitted SQL contains (an FLS wrapper adds a second). */
function caseCount(sql: string): number {
  return sql.split('CASE WHEN').length - 1;
}

function engineOf(backing?: TypeBacking): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(personDef));
  registry.registerType(registry.parseType(ticketDef), backing);
  registry.finalize();
  return new QueryEngine(registry, {
    executors: {
      person: arrayExecutor([{ id: 1, name: 'Ada' }]),
      ticket: arrayExecutor([{ id: 10, status: 'open', tier: 'a', owner: 1 }]),
    },
  });
}

describe('0.6.0 — edges', () => {
  it('the default eqSelectivity seam answers "no better estimate"', () => {
    // Only the value-set-carrying scalars override it; every other kind falls
    // back to the package-wide fixed guess.
    expect(new BoolFieldType().eqSelectivity()).toBeUndefined();
  });

  it('renameSource recurses through ARRAYS as well as objects', () => {
    const expr: ExprDef = {
      kind: 'in',
      value: { kind: 'field-ref', source: 't', field: 'status' },
      in: [{ kind: 'field-ref', source: 't', field: 'tier' }, { kind: 'literal', value: 'x' }],
    };
    expect(renameSource(expr, 't', 'ticket')).toEqual({
      kind: 'in',
      value: { kind: 'field-ref', source: 'ticket', field: 'status' },
      in: [{ kind: 'field-ref', source: 'ticket', field: 'tier' }, { kind: 'literal', value: 'x' }],
    });
  });

  it('closed-set selectivity folds from EITHER operand, tightening when both declare one', () => {
    const engine = engineOf();
    const scope = engine.globalScope();
    const rows = (left: ExprDef, right: ExprDef): number =>
      engine
        .parseQuery({
          kind: 'select',
          fields: [{ expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, as: 'id' }],
          from: { kind: 'type', type: 'ticket' },
          where: [{ kind: 'comparison', op: '=', left, right }],
        } as SelectDef)
        .cost(cctx(engine), scope).rows;
    const status: ExprDef = { kind: 'field-ref', source: 'ticket', field: 'status' };
    const tier: ExprDef = { kind: 'field-ref', source: 'ticket', field: 'tier' };
    // Left declares a set, right does not — and the mirror image.
    expect(rows(status, { kind: 'literal', value: 'open' })).toBe(500);
    expect(rows({ kind: 'literal', value: 'open' }, status)).toBe(500);
    // BOTH declare one ⇒ the tighter (4-member) estimate wins.
    expect(rows(status, tier)).toBe(250);
  });

  it('a TEXT field type with a value set deep-clones its members', () => {
    const withValues = new TextFieldType({ values: [{ value: 'a', label: 'A' }] });
    const copy = withValues.clone();
    copy.options.values![0]!.label = 'CHANGED';
    expect(withValues.options.values![0]!.label).toBe('A');
    // …and one WITHOUT a set clones to no set at all.
    expect(new TextFieldType({ minLength: 1 }).clone().options.values).toBeUndefined();
  });

  it('an UNBOUND output ref in GROUP BY falls back to emitting itself', () => {
    const engine = engineOf();
    // `toSQL` without validating first: the output name does not exist, so the
    // relation-key expansion has nothing to see through to.
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'ticket' },
      groupBy: [{ kind: 'output', name: 'nope' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('GROUP BY NULL');
  });

  it('an ALLOWING field access leaves the projected identity untouched', async () => {
    const allow: TypeBacking = { fields: { owner: { access: { run: () => true, sql: () => true } } } };
    const engine = engineOf(allow);
    const sql = engine.toSQL(projectOwner, 'postgres').sql;
    expect(sql).toContain(IDENTITY_CASE);
    // Only the identity's own null test — no FLS wrapper around it.
    expect(caseCount(sql)).toBe(1);
    expect((await engine.run(projectOwner)).rows).toEqual([{ id: 10, owner: { id: 1 } }]);
  });

  it('a NO-OP field access (no decision either way) leaves the identity untouched', () => {
    const noop: TypeBacking = { fields: { owner: { access: { sql: () => undefined } } } };
    const sql = engineOf(noop).toSQL(projectOwner, 'postgres').sql;
    expect(sql).toContain(IDENTITY_CASE);
    expect(caseCount(sql)).toBe(1);
  });

  it('a PREDICATE field access wraps the projected identity, and a visible run keeps it', async () => {
    const registry = createRegistry();
    const backing: TypeBacking = {
      fields: {
        owner: {
          access: {
            expr: (alias) =>
              registry.parseExpr({
                kind: 'comparison',
                op: '=',
                left: { kind: 'field-ref', source: alias, field: 'id' },
                right: { kind: 'literal', value: 10 },
              }),
          },
        },
      },
    };
    registry.registerType(registry.parseType(personDef));
    registry.registerType(registry.parseType(ticketDef), backing);
    registry.finalize();
    const engine = new QueryEngine(registry, {
      executors: {
        person: arrayExecutor([{ id: 1, name: 'Ada' }]),
        ticket: arrayExecutor([{ id: 10, status: 'open', tier: 'a', owner: 1 }]),
      },
    });
    // The dual `expr` path resolves to a PREDICATE in SQL — the identity's own
    // null test PLUS the access wrapper around it.
    const sql = engine.toSQL(projectOwner, 'postgres').sql;
    expect(caseCount(sql)).toBe(2);
    expect(sql).toContain('THEN CASE WHEN "ticket"."owner" IS NULL');
    // …and to a VISIBLE decision at runtime, which keeps the identity.
    expect((await engine.run(projectOwner)).rows).toEqual([{ id: 10, owner: { id: 1 } }]);
  });

  it('a COMPOSITE-key relation cannot be matched by a one-field IN subquery', () => {
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'tenantUser',
        fields: [
          { name: 'tenantId', type: { kind: 'number', whole: true } },
          { name: 'userId', type: { kind: 'number', whole: true } },
        ],
        identity: ['tenantId', 'userId'],
        count: 10,
        bytes: 16,
      }),
    );
    registry.registerType(
      registry.parseType({
        name: 'task',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'ot', type: { kind: 'number', whole: true } },
          { name: 'ou', type: { kind: 'number', whole: true } },
          { name: 'owner', type: { kind: 'relation', to: 'tenantUser', count: 1 } },
        ],
        count: 10,
        bytes: 16,
      }),
      { fields: { owner: { relation: { keys: [{ local: 'ot', foreign: 'tenantId' }, { local: 'ou', foreign: 'userId' }] } } } },
    );
    registry.finalize();
    const engine = new QueryEngine(registry);
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'task', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'task' },
      where: [
        {
          kind: 'in',
          value: { kind: 'field-ref', source: 'task', field: 'owner' },
          in: {
            kind: 'select',
            fields: [{ expr: { kind: 'field-ref', source: 'tu', field: 'tenantId' } }],
            from: { kind: 'aliased', type: 'tenantUser', as: 'tu' },
          },
        },
      ],
    };
    const problem = engine.validateQuery(def).list.find((p) => p.code === 'in.relation-composite');
    expect(problem).toBeDefined();
    expect(problem!.message).toContain('tenantId, userId');
  });

  it('INSERT / UPDATE RETURNING columns are validated (and may be relation identities)', () => {
    const engine = engineOf();
    const insert: QueryDef = {
      kind: 'insert',
      into: 'ticket',
      rows: [{ id: { kind: 'literal', value: 11 }, status: { kind: 'literal', value: 'open' }, tier: { kind: 'literal', value: 'a' }, owner: { kind: 'literal', value: 1 } }],
      returning: [
        { expr: { kind: 'field-ref', source: 'ticket', field: 'owner' }, as: 'owner' },
        { expr: { kind: 'field-ref', source: 'ticket', field: 'nope' }, as: 'bad' },
      ],
    } as QueryDef;
    expect(engine.validateQuery(insert).list.map((p) => p.code)).toEqual(['ref.unknown-field']);

    const update: QueryDef = {
      kind: 'update',
      type: 'ticket',
      set: { status: { kind: 'literal', value: 'closed' } },
      returning: [
        { expr: { kind: 'field-ref', source: 'ticket', field: 'owner' }, as: 'owner' },
        { expr: { kind: 'field-ref', source: 'ticket', field: 'nope' }, as: 'bad' },
      ],
    } as QueryDef;
    expect(engine.validateQuery(update).list.map((p) => p.code)).toEqual(['ref.unknown-field']);
  });

  it('drillDownInto refuses a group value that is not a scalar or a flat key object', async () => {
    const engine = engineOf();
    const aggregated: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'ticket', field: 'status' }, as: 'status' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'ticket' },
      groupBy: [{ kind: 'field-ref', source: 'ticket', field: 'status' }],
    };
    // An ARRAY is not a key — neither a scalar nor an identity object.
    const arrayValue = drillDownInto(aggregated, { status: ['open'] }, engine);
    expect('error' in arrayValue).toBe(true);
    // A NESTED object is not a flat key set either.
    const nested = drillDownInto(aggregated, { status: { a: { b: 1 } } }, engine);
    expect('error' in nested).toBe(true);
    // A flat key object IS bindable.
    const flat = drillDownInto(aggregated, { status: { id: 'open' } }, engine);
    expect('query' in flat).toBe(true);
  });
});

/** `SELECT ticket.id, ticket.owner FROM ticket` — the relation projection. */
const projectOwner: SelectDef = {
  kind: 'select',
  fields: [
    { expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, as: 'id' },
    { expr: { kind: 'field-ref', source: 'ticket', field: 'owner' }, as: 'owner' },
  ],
  from: { kind: 'type', type: 'ticket' },
};
