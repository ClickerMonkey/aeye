/**
 * A4 — identity is DECLARABLE, so index ORDER stops deciding what a row is.
 *
 * Without a declaration, identity is inferred as "the first single-part unique
 * index, else the field named `id`". A Type declaring `id` AND a unique `email`
 * with the email index listed first therefore identifies by EMAIL — and every
 * belongs-to into it resolves as `<other>.<rel> = <type>.email`, joining a
 * stored id against an email address. Zero rows, forever, with no error.
 *
 * The product's own convention (append indexes, never prepend) works for the
 * path it controls, but an installed package's indexes are parsed verbatim, so
 * the discipline does not reach every boundary. Declaring it does.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { QueryTypeError } from '../problem';
import type { TypeDef, SelectDef } from '../schema';

/** `account` with the EMAIL unique index listed FIRST — the hijack shape. */
function accountDef(identity?: string | string[]): TypeDef {
  return {
    name: 'account',
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'email', type: { kind: 'text' } },
    ],
    indexes: [
      { exprs: [{ expr: { kind: 'field-ref', source: 'account', field: 'email' }, count: 1 }] },
      { exprs: [{ expr: { kind: 'field-ref', source: 'account', field: 'id' }, count: 1 }] },
    ],
    identity,
    count: 100,
    bytes: 48,
  };
}

const ticketDef: TypeDef = {
  name: 'ticket',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'account', type: { kind: 'relation', to: 'account', count: 1 } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, count: 1 }] }],
  count: 500,
  bytes: 32,
};

const accountRows = [
  { id: 1, email: 'ada@example.com' },
  { id: 2, email: 'bob@example.com' },
];
const ticketRows = [
  { id: 90, account: 1 },
  { id: 91, account: 2 },
];

function engineOf(identity?: string | string[]): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(accountDef(identity)));
  registry.registerType(registry.parseType(ticketDef));
  registry.finalize();
  return new QueryEngine(registry, {
    executors: { account: arrayExecutor(accountRows), ticket: arrayExecutor(ticketRows) },
  });
}

/** `SELECT ticket.id, a.email FROM ticket JOIN ticket.account AS a`. */
const joinDef: SelectDef = {
  kind: 'select',
  fields: [
    { expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, as: 'id' },
    { expr: { kind: 'field-ref', source: 'a', field: 'email' }, as: 'email' },
  ],
  from: { kind: 'type', type: 'ticket' },
  joins: [{ on: { kind: 'relation', source: 'ticket', field: 'account', as: 'a' } }],
  order: [{ expr: { kind: 'field-ref', source: 'ticket', field: 'id' }, dir: 'asc' }],
};

describe('A4 — declared identity', () => {
  it('index ORDER still decides identity when nothing is declared (the hazard)', async () => {
    const engine = engineOf(undefined);
    // Pinning the CURRENT inferred rule, so a future change to it is visible.
    expect(engine.type('account')!.identityField().name).toBe('email');
    expect(engine.type('account')!.primaryKey().map((f) => f.name)).toEqual(['email']);
    // …and the resulting join compares a stored id against an email ⇒ no rows.
    const rows = (await engine.run(joinDef)).rows;
    expect(rows.every((r) => r['email'] === null)).toBe(true);
  });

  it('a declared identity wins over index order, and the join then resolves', async () => {
    const engine = engineOf('id');
    expect(engine.type('account')!.identityField().name).toBe('id');
    expect(engine.type('account')!.primaryKey().map((f) => f.name)).toEqual(['id']);
    expect((await engine.run(joinDef)).rows).toEqual([
      { id: 90, email: 'ada@example.com' },
      { id: 91, email: 'bob@example.com' },
    ]);
    expect(engine.toSQL(joinDef, 'postgres').sql).toContain('"ticket"."account" = "a"."id"');
  });

  it('a COMPOSITE declared identity answers primaryKey in key order and has no single field', () => {
    const registry = createRegistry();
    const def: TypeDef = {
      name: 'membership',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'tenantId', type: { kind: 'number', whole: true } },
        { name: 'userId', type: { kind: 'number', whole: true } },
      ],
      // `id` exists and would otherwise be the fallback identity.
      identity: ['tenantId', 'userId'],
      count: 10,
      bytes: 24,
    };
    registry.registerType(registry.parseType(def));
    registry.finalize();
    const type = new QueryEngine(registry).type('membership')!;
    expect(type.primaryKey().map((f) => f.name)).toEqual(['tenantId', 'userId']);
    // There is no SINGLE identity field, so the single-field accessor refuses
    // rather than silently picking one of the two.
    expect(() => type.identityField()).toThrow(QueryTypeError);
  });

  it('round-trips through JSON, normalizing a one-element list to a bare name', () => {
    const registry = createRegistry();
    const single = registry.parseType(accountDef(['id']));
    expect(single.toJSON().identity).toBe('id');
    expect(single.clone().identityField().name).toBe('id');
    const none = registry.parseType(accountDef(undefined));
    expect(none.toJSON().identity).toBeUndefined();
    const composite = registry.parseType({ ...accountDef(['id', 'email']) });
    expect(composite.toJSON().identity).toEqual(['id', 'email']);
  });

  it('a declared identity naming a field the Type does not have is an ERROR, not a fallback', () => {
    const registry = createRegistry();
    const type = registry.parseType(accountDef('emial'));
    // Silently falling back to the inferred rule would reintroduce the very
    // index-order dependence the declaration exists to remove — invisibly.
    expect(() => type.identityField()).toThrow(/type\.identity-unknown-field|does not have/);
    expect(() => type.primaryKey()).toThrow(/'emial'/);
  });

  it('a unique index on another column stays JUST a unique index', () => {
    const engine = engineOf('id');
    const account = engine.type('account')!;
    // The email index is still unique (and still usable for cost) — it simply no
    // longer decides what a row IS.
    expect(account.indexes[0]!.unique).toBe(true);
    expect(account.identityField().name).toBe('id');
  });
});
