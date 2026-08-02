/**
 * A8 — a relation's VALUE is its IDENTITY, read off the caller's OWN row.
 *
 * Before this, a bare relation field-ref was refused everywhere except an FK
 * comparison, so the only way to read who a row pointed AT was to JOIN the
 * target and project its id. That join is RLS-scoped, and the scope hides the
 * id along with the rest of the row — so an audit column like `createdBy` read
 * `null` for a row created by someone the reader cannot see, making UNSET
 * indistinguishable from HIDDEN, in exactly the case audit columns exist for.
 *
 * The value is a KEYED OBJECT (`{ id: 'userB' }`, `{ tenantId: 3, userId: 1 }`),
 * keyed by the target's identity field names — not a positional tuple, whose
 * meaning would depend on index order.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import type { TypeDef, SelectDef, QueryDef } from '../schema';
import type { TypeBacking as Backing } from '../backing';

const userDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'text' } },
    { name: 'name', type: { kind: 'text' } },
  ],
  identity: 'id',
  count: 100,
  bytes: 32,
};

const noteDef: TypeDef = {
  name: 'note',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } },
    // The audit column this ask exists for.
    { name: 'author', type: { kind: 'relation', to: 'user', count: 1, inverseRelation: 'notes' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 48,
};

const userRows = [
  { id: 'userA', name: 'Ada' },
  { id: 'userB', name: 'Bob' },
];
const noteRows = [
  { id: 1, title: 'first', author: 'userA' },
  { id: 2, title: 'second', author: 'userB' },
  { id: 3, title: 'orphan', author: null },
];

function engineOf(backing?: Backing): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(userDef));
  registry.registerType(registry.parseType(noteDef), backing);
  registry.finalize();
  return new QueryEngine(registry, {
    executors: { user: arrayExecutor(userRows), note: arrayExecutor(noteRows) },
  });
}

/** `SELECT note.id, note.author FROM note` — a bare relation projection. */
const projectAuthor: SelectDef = {
  kind: 'select',
  fields: [
    { expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' },
    { expr: { kind: 'field-ref', source: 'note', field: 'author' }, as: 'author' },
  ],
  from: { kind: 'type', type: 'note' },
  order: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, dir: 'asc' }],
};

// ─── Half 1: projectable without a join ──────────────────────────────────────

describe('A8 — a relation projects its identity, with no join', () => {
  it('validates, where it used to be `ref.relation-not-value`', () => {
    const engine = engineOf();
    const codes = engine.validateQuery(projectAuthor).list.map((p) => p.code);
    expect(codes).not.toContain('ref.relation-not-value');
    expect(codes).toEqual([]);
  });

  it('yields a keyed OBJECT at runtime, and NULL when the relation is unset', async () => {
    const engine = engineOf();
    expect((await engine.run(projectAuthor)).rows).toEqual([
      { id: 1, author: { id: 'userA' } },
      { id: 2, author: { id: 'userB' } },
      // Unset is NULL, not `{ id: null }` — which is what keeps "nobody set it"
      // distinguishable from "someone you cannot see set it".
      { id: 3, author: null },
    ]);
  });

  it('reports the projected column as a nullable json value, not a whole Type', () => {
    const engine = engineOf();
    const fields = engine.parseQuery(projectAuthor).outputFields(engine, engine.globalScope());
    const author = fields.find((f) => f.name === 'author')!;
    expect(author.fieldType).toBe('json');
    expect(author.nullable).toBe(true);
  });

  it('emits the identity object from the LOCAL column, planning NO join', () => {
    const engine = engineOf();
    const { sql } = engine.toSQL(projectAuthor, 'postgres');
    expect(sql).toContain(`jsonb_build_object('id', "note"."author")`);
    expect(sql).toContain('CASE WHEN "note"."author" IS NULL THEN NULL');
    // The whole point: no join to `user`, so an RLS scope on `user` cannot null
    // the value. The FK is data the reader's own row holds.
    expect(sql).not.toContain('JOIN');
    // The JSON KEY is a literal, not a bind param — it is structure, not data.
    expect(engine.toSQL(projectAuthor, 'postgres').params).toEqual([]);
  });

  it('the base dialect emits the portable json_build_object form', () => {
    const engine = engineOf();
    expect(engine.toSQL(projectAuthor, 'base').sql).toContain(`json_build_object('id', "note"."author")`);
  });

  it('a COMPOSITE key projects every part, keyed by the target identity field names', async () => {
    const registry = createRegistry();
    registry.registerType(
      registry.parseType({
        name: 'tenantUser',
        fields: [
          { name: 'tenantId', type: { kind: 'number', whole: true } },
          { name: 'userId', type: { kind: 'number', whole: true } },
        ],
        identity: ['tenantId', 'userId'],
        count: 50,
        bytes: 16,
      }),
    );
    registry.registerType(
      registry.parseType({
        name: 'task',
        fields: [
          { name: 'id', type: { kind: 'number', whole: true } },
          { name: 'ownerTenant', type: { kind: 'number', whole: true } },
          { name: 'ownerUser', type: { kind: 'number', whole: true } },
          { name: 'owner', type: { kind: 'relation', to: 'tenantUser', count: 1 } },
        ],
        count: 100,
        bytes: 32,
      }),
      {
        fields: {
          owner: { relation: { keys: [{ local: 'ownerTenant', foreign: 'tenantId' }, { local: 'ownerUser', foreign: 'userId' }] } },
        },
      },
    );
    registry.finalize();
    const engine = new QueryEngine(registry, {
      executors: {
        tenantUser: arrayExecutor([{ tenantId: 3, userId: 1 }]),
        task: arrayExecutor([
          { id: 1, ownerTenant: 3, ownerUser: 1 },
          // A HALF-set composite key cannot join, so it is unset ⇒ NULL.
          { id: 2, ownerTenant: 3, ownerUser: null },
        ]),
      },
    });
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'task', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'task', field: 'owner' }, as: 'owner' },
      ],
      from: { kind: 'type', type: 'task' },
      order: [{ expr: { kind: 'field-ref', source: 'task', field: 'id' }, dir: 'asc' }],
    };
    expect((await engine.run(def)).rows).toEqual([
      { id: 1, owner: { tenantId: 3, userId: 1 } },
      { id: 2, owner: null },
    ]);
    const sql = engine.toSQL(def, 'postgres').sql;
    expect(sql).toContain(`jsonb_build_object('tenantId', "task"."ownerTenant", 'userId', "task"."ownerUser")`);
  });

  it('field-level security still nulls a denied relation identity', async () => {
    // A static deny on BOTH paths: the identity must be secured by the same rule
    // as any other column, since it bypasses the stored/compute resolution.
    const backing: Backing = { fields: { author: { access: { run: () => false, sql: () => false } } } };
    const engine = engineOf(backing);
    const rows = (await engine.run(projectAuthor)).rows;
    expect(rows.map((r) => r['author'])).toEqual([null, null, null]);
    expect(engine.toSQL(projectAuthor, 'postgres').sql).toContain('NULL AS "author"');
  });

  it('reads the OUTER row relation from inside a correlated subquery', async () => {
    const engine = engineOf();
    // The subquery binds `user`, so `note.author` is not on its row — it comes
    // from the CORRELATION, exactly as a correlated scalar column would.
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' },
        {
          expr: {
            kind: 'subquery',
            query: {
              kind: 'select',
              fields: [{ expr: { kind: 'field-ref', source: 'note', field: 'author' } }],
              from: { kind: 'type', type: 'user' },
              limit: 1,
            },
          },
          as: 'outerAuthor',
        },
      ],
      from: { kind: 'type', type: 'note' },
      order: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, dir: 'asc' }],
    };
    expect((await engine.run(def)).rows).toEqual([
      { id: 1, outerAuthor: { id: 'userA' } },
      { id: 2, outerAuthor: { id: 'userB' } },
      { id: 3, outerAuthor: null },
    ]);
  });

  it('a RETURNING column projects the identity too (the DELETE undo case)', async () => {
    const engine = engineOf();
    const del: QueryDef = {
      kind: 'delete',
      from: 'note',
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'note', field: 'id' }, right: { kind: 'literal', value: 2 } }],
      returning: [
        { expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'note', field: 'author' }, as: 'author' },
      ],
    } as QueryDef;
    expect(engine.validateQuery(del).list.map((p) => p.code)).toEqual([]);
    // The FK value IS the prior state an undo restores from.
    expect((await engine.run(del)).rows).toEqual([{ id: 2, author: { id: 'userB' } }]);
  });
});

// ─── Half 2: comparable, orderable, groupable — and refused where undefined ──

describe('A8 — identity as an operand', () => {
  it('IS NULL / IS NOT NULL test the KEY COLUMNS (unset, not a constructed object)', async () => {
    const engine = engineOf();
    const where = (not: boolean): SelectDef => ({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'note' },
      where: [{ kind: 'is-null', value: { kind: 'field-ref', source: 'note', field: 'author' }, not }],
      order: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, dir: 'asc' }],
    });
    expect(engine.validateQuery(where(false)).list.map((p) => p.code)).toEqual([]);
    expect((await engine.run(where(false))).rows).toEqual([{ id: 3 }]);
    expect((await engine.run(where(true))).rows).toEqual([{ id: 1 }, { id: 2 }]);
    // `jsonb_build_object(...) IS NULL` would be a constant false, so the SQL
    // tests the columns — which also keeps the predicate index-usable.
    expect(engine.toSQL(where(false), 'postgres').sql).toContain('("note"."author" IS NULL)');
    expect(engine.toSQL(where(true), 'postgres').sql).toContain('("note"."author" IS NOT NULL)');
  });

  it('ORDER BY an identity sorts by the key columns, not by the JSON encoding', async () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'note' },
      order: [
        { expr: { kind: 'field-ref', source: 'note', field: 'author' }, dir: 'desc', nulls: 'last' },
        { expr: { kind: 'field-ref', source: 'note', field: 'id' }, dir: 'asc' },
      ],
    };
    expect(engine.validateQuery(def).list.map((p) => p.code)).toEqual([]);
    expect((await engine.run(def)).rows).toEqual([{ id: 2 }, { id: 1 }, { id: 3 }]);
    // One ORDER BY clause per key column, each inheriting dir + NULLs placement.
    expect(engine.toSQL(def, 'postgres').sql).toContain('ORDER BY "note"."author" DESC NULLS LAST');
  });

  it('GROUP BY an identity groups structurally, on the key columns', async () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'note', field: 'author' }, as: 'author' },
        { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'n' },
      ],
      from: { kind: 'type', type: 'note' },
      groupBy: [{ kind: 'field-ref', source: 'note', field: 'author' }],
      order: [{ expr: { kind: 'field-ref', source: 'note', field: 'author' }, dir: 'asc' }],
    };
    expect(engine.validateQuery(def).list.map((p) => p.code)).toEqual([]);
    expect((await engine.run(def)).rows).toEqual([
      { author: null, n: 1 },
      { author: { id: 'userA' }, n: 1 },
      { author: { id: 'userB' }, n: 1 },
    ]);
    // Grouping the assembled object would need an equality operator the JSON
    // type does not have in most dialects.
    expect(engine.toSQL(def, 'postgres').sql).toContain('GROUP BY "note"."author"');
  });

  it('AGGREGATING an identity is refused, and the message says why', () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'aggregate', function: 'max', args: { value: { kind: 'field-ref', source: 'note', field: 'author' } } }, as: 'm' }],
      from: { kind: 'type', type: 'note' },
    };
    const problem = engine.validateQuery(def).list.find((p) => p.code === 'ref.relation-aggregate');
    expect(problem).toBeDefined();
    expect(problem!.message).toContain('IDENTITY, which cannot be aggregated');
    // Grouping / ordering are offered as the defined alternatives.
    expect(problem!.message).toContain('Group BY it');
  });

  it('a HAS-MANY is refused with a STATEABLE reason, not the blanket one', () => {
    const engine = engineOf();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'notes' }, as: 'n' }],
      from: { kind: 'type', type: 'user' },
    };
    const codes = engine.validateQuery(def).list.map((p) => p.code);
    expect(codes).toContain('ref.relation-has-many');
    expect(codes).not.toContain('ref.relation-not-value');
    const message = engine.validateQuery(def).list.find((p) => p.code === 'ref.relation-has-many')!.message;
    expect(message).toContain('no key on this row');
    expect(message).toContain("lives on 'note'");
  });

  it('positions where a relation is not a value at all still refuse with the join-it hint', () => {
    const engine = engineOf();
    // Arithmetic over an identity has no meaning under any representation.
    const def: SelectDef = {
      kind: 'select',
      fields: [
        {
          expr: { kind: 'binary', op: '+', left: { kind: 'field-ref', source: 'note', field: 'author' }, right: { kind: 'literal', value: 1 } },
          as: 'x',
        },
      ],
      from: { kind: 'type', type: 'note' },
    };
    expect(engine.validateQuery(def).list.map((p) => p.code)).toContain('compare.relation-vs-value');
  });

  it('= / <> against an identity object and a bare scalar both still work', async () => {
    const engine = engineOf();
    const eq = (value: unknown): SelectDef => ({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'note' },
      where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'note', field: 'author' }, right: { kind: 'param', name: 'a' } }],
      order: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, dir: 'asc' }],
      // `value` is bound below; kept out of the def so both forms share it.
      ...(value === undefined ? {} : {}),
    });
    // The identity object round-trips: what a projection RETURNS is what a
    // comparison ACCEPTS.
    expect((await engine.run(eq(null), { params: { a: { id: 'userA' } } })).rows).toEqual([{ id: 1 }]);
    // The single-key shorthand is unchanged.
    expect((await engine.run(eq(null), { params: { a: 'userA' } })).rows).toEqual([{ id: 1 }]);
  });
});
