/**
 * Default conditions — a SOFT, suppressible default scope on a Type (archived /
 * soft-delete filtering). While ACTIVE the condition's `where` is ANDed into a
 * row-filtering op's WHERE, per bound source; it LIFTS for a source the moment a
 * CONDITION-position clause (WHERE / HAVING / a JOIN `and`) references one of its
 * `without` fields on that source. RLS (`access`) is separate and never lifts.
 *
 * The `file` fixture models archived-file filtering: rows carry a nullable
 * `archivedAt`, and the default condition keeps only `archivedAt IS NULL`.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { RuntimeContext } from '../runtime/context';
import { arrayExecutor } from '../runtime/executor';
import { SqlText } from '../sql/emit';
import { describeType } from '../llm/describe';
import { isNull, ref, eq, lit } from '../builder';
import type { TypeBacking } from '../backing';
import type { ExprDef, TypeDef, SelectDef, UpdateDef, DeleteDef, InsertDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

/** Conceptual `file` Type: archivable, owned, self-parenting (for self-joins). */
const fileDef: TypeDef = {
  name: 'file',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'ownerId', type: { kind: 'number', whole: true } },
    { name: 'archivedAt', type: { kind: 'timestamp' }, nullable: true },
    // Self belongs-to, so a query can self-join `file` under a second alias.
    { name: 'parentId', type: { kind: 'relation', to: 'file', count: 1 }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'file', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 64,
};

/** ids 2 & 4 are archived; owner 1 owns 1 & 2, owner 2 owns 3 & 4. */
const fileRows: SourceRecord[] = [
  { id: 1, name: 'a', ownerId: 1, archivedAt: null, parentId: null },
  { id: 2, name: 'b', ownerId: 1, archivedAt: '2020-01-01T00:00:00', parentId: 1 },
  { id: 3, name: 'c', ownerId: 2, archivedAt: null, parentId: 2 },
  { id: 4, name: 'd', ownerId: 2, archivedAt: '2021-01-01T00:00:00', parentId: 3 },
];

/** Build a registry + engine over `file` with the given backing. */
function fileFixture(backing: TypeBacking) {
  const registry = createRegistry();
  const file = registry.parseType(fileDef);
  registry.registerType(file, backing);
  registry.finalize();
  const engine = new QueryEngine(registry, { executors: { file: arrayExecutor(fileRows) } });
  return { registry, engine, file };
}

/** The canonical archived-filtering condition, deriving `without` from its predicate. */
const archivedBacking: TypeBacking = {
  defaultConditions: [{ where: { expr: (a) => isNull(ref(a, 'archivedAt')) } }],
};

/** SELECT id FROM file [WHERE …]. */
function selectIds(where?: SelectDef['where']): SelectDef {
  const def: SelectDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'file', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'file' },
  };
  if (where) def.where = where;
  return def;
}

/** The `id` values a run returns, sorted. */
async function runIds(engine: QueryEngine, def: SelectDef): Promise<number[]> {
  const res = await engine.run(def);
  return res.rows.map((r) => Number(r['id'])).sort((x, y) => x - y);
}

describe('default conditions — SELECT scoping (SQL + runtime)', () => {
  it('a plain query is scoped in BOTH dialects (archivedAt IS NULL ANDed)', () => {
    const { engine } = fileFixture(archivedBacking);
    for (const dialect of ['base', 'postgres'] as const) {
      const out = engine.toSQL(selectIds(), dialect);
      expect(out.sql).toContain('"archivedAt" IS NULL');
    }
  });

  it('a plain query filters archived rows at runtime', async () => {
    const { engine } = fileFixture(archivedBacking);
    expect(await runIds(engine, selectIds())).toEqual([1, 3]);
  });

  it('a condition-position ref to `archivedAt` LIFTS the scope (sees archived)', async () => {
    const { engine } = fileFixture(archivedBacking);
    const notNullWhere: SelectDef['where'] = [
      { kind: 'is-null', not: true, value: { kind: 'field-ref', source: 'file', field: 'archivedAt' } },
    ];
    const out = engine.toSQL(selectIds(notNullWhere), 'base');
    // Only the authored `IS NOT NULL` remains — the default `IS NULL` is lifted.
    expect(out.sql).toContain('IS NOT NULL');
    expect(out.sql).not.toContain('IS NULL');
    expect(await runIds(engine, selectIds(notNullWhere))).toEqual([2, 4]);
  });

  it('a NON-`without` condition ref keeps the scope (WHERE name = …)', async () => {
    const { engine } = fileFixture(archivedBacking);
    const where: SelectDef['where'] = [
      { kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'file', field: 'name' }, right: { kind: 'literal', value: 'b' } },
    ];
    // `b` (id 2) IS archived, so the still-active scope filters it out ⇒ no rows.
    expect(await runIds(engine, selectIds(where))).toEqual([]);
    expect(engine.toSQL(selectIds(where), 'base').sql).toContain('"archivedAt" IS NULL');
  });

  it('a SELECT-item / ORDER-BY ref does NOT lift it (filter-position only)', async () => {
    const { engine } = fileFixture(archivedBacking);
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'file', field: 'id' }, as: 'id' },
        { expr: { kind: 'field-ref', source: 'file', field: 'archivedAt' }, as: 'archivedAt' },
      ],
      from: { kind: 'type', type: 'file' },
      order: [{ expr: { kind: 'field-ref', source: 'file', field: 'archivedAt' }, dir: 'asc' }],
    };
    expect(engine.toSQL(def, 'base').sql).toContain('"archivedAt" IS NULL');
    const res = await engine.run(def);
    expect(res.rows.map((r) => r['id']).sort()).toEqual([1, 3]);
  });
});

describe('default conditions — ops (UPDATE / DELETE / INSERT)', () => {
  it('UPDATE and DELETE are scoped by default (archived rows untouched)', async () => {
    const upd: UpdateDef = {
      kind: 'update',
      type: 'file',
      set: { name: { kind: 'literal', value: 'x' } },
    };
    const del: DeleteDef = { kind: 'delete', from: 'file' };

    const u = fileFixture(archivedBacking);
    expect((await u.engine.run(upd)).affected).toBe(2); // only the 2 non-archived
    expect(u.engine.toSQL(upd, 'base').sql).toContain('"archivedAt" IS NULL');

    const d = fileFixture(archivedBacking);
    expect((await d.engine.run(del)).affected).toBe(2);
    expect(d.engine.toSQL(del, 'base').sql).toContain('"archivedAt" IS NULL');
  });

  it("a `select`-only `ops` leaves UPDATE / DELETE unscoped", async () => {
    const selectOnly: TypeBacking = {
      defaultConditions: [{ where: { expr: (a) => isNull(ref(a, 'archivedAt')) }, ops: ['select'] }],
    };
    const upd: UpdateDef = { kind: 'update', type: 'file', set: { name: { kind: 'literal', value: 'x' } } };
    const fx = fileFixture(selectOnly);
    expect((await fx.engine.run(upd)).affected).toBe(4); // all rows — unscoped
    expect(fx.engine.toSQL(upd, 'base').sql).not.toContain('"archivedAt" IS NULL');
    // …but SELECT is still scoped.
    expect(await runIds(fx.engine, selectIds())).toEqual([1, 3]);
  });

  it('INSERT is never scoped (an archived row inserts, then SELECT hides it)', async () => {
    const { engine } = fileFixture(archivedBacking);
    const ctx = new RuntimeContext(engine);
    const ins: InsertDef = {
      kind: 'insert',
      into: 'file',
      rows: [{
        id: { kind: 'literal', value: 5 },
        name: { kind: 'literal', value: 'e' },
        ownerId: { kind: 'literal', value: 1 },
        archivedAt: { kind: 'literal', value: '2022-01-01T00:00:00' },
      }],
    };
    expect((await engine.parseQuery(ins).execute(ctx)).affected).toBe(1); // not blocked
    // The freshly inserted archived row is scoped OUT of a plain select…
    const scoped = await engine.parseQuery(selectIds()).execute(ctx);
    expect(scoped.rows.map((r) => r['id'])).not.toContain(5);
    // …but visible once the scope is lifted.
    const lifted = await engine.parseQuery(
      selectIds([{ kind: 'is-null', not: true, value: { kind: 'field-ref', source: 'file', field: 'archivedAt' } }]),
    ).execute(ctx);
    expect(lifted.rows.map((r) => r['id'])).toContain(5);
  });
});

describe('default conditions — alias / self-join independence', () => {
  /** SELECT f.id FROM file JOIN file AS parent (via parentId) [WHERE …] [join and]. */
  function selfJoin(opts: { where?: SelectDef['where']; and?: ExprDef }): SelectDef {
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'file', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'file' },
      joins: [{ on: { kind: 'relation', source: 'file', field: 'parentId', as: 'parent' }, ...(opts.and ? { and: opts.and } : {}) }],
    };
    if (opts.where) def.where = opts.where;
    return def;
  }

  it('both instances are scoped when neither is referenced in a condition', () => {
    const { engine } = fileFixture(archivedBacking);
    const sql = engine.toSQL(selfJoin({}), 'base').sql;
    expect(sql).toContain('"file"."archivedAt" IS NULL');
    expect(sql).toContain('"parent"."archivedAt" IS NULL');
  });

  it('a WHERE ref to `parent.archivedAt` lifts ONLY `parent` (file stays scoped)', () => {
    const { engine } = fileFixture(archivedBacking);
    const where: SelectDef['where'] = [
      { kind: 'is-null', not: true, value: { kind: 'field-ref', source: 'parent', field: 'archivedAt' } },
    ];
    const sql = engine.toSQL(selfJoin({ where }), 'base').sql;
    expect(sql).toContain('"file"."archivedAt" IS NULL');
    expect(sql).not.toContain('"parent"."archivedAt" IS NULL');
  });

  it('a JOIN `and` ref to `parent.archivedAt` also lifts `parent`', () => {
    const { engine } = fileFixture(archivedBacking);
    const sql = engine.toSQL(
      selfJoin({ and: { kind: 'is-null', not: true, value: { kind: 'field-ref', source: 'parent', field: 'archivedAt' } } }),
      'base',
    ).sql;
    expect(sql).toContain('"file"."archivedAt" IS NULL');
    expect(sql).not.toContain('"parent"."archivedAt" IS NULL');
  });
});

describe('default conditions — compose with RLS (access)', () => {
  /** RLS: only owner 1's rows; PLUS the archived default scope. */
  const rlsBacking: TypeBacking = {
    access: { expr: (a) => eq(ref(a, 'ownerId'), lit(1)) },
    defaultConditions: [{ where: { expr: (a) => isNull(ref(a, 'archivedAt')) } }],
  };

  it('both RLS and the default condition AND into a plain query', async () => {
    const { engine } = fileFixture(rlsBacking);
    const sql = engine.toSQL(selectIds(), 'base').sql;
    expect(sql).toContain('"ownerId"');
    expect(sql).toContain('"archivedAt" IS NULL');
    // Owner-1 rows are 1 & 2; the archived 2 is scoped out ⇒ only 1.
    expect(await runIds(engine, selectIds())).toEqual([1]);
  });

  it('the default condition lifts but RLS does NOT', async () => {
    const { engine } = fileFixture(rlsBacking);
    const where: SelectDef['where'] = [
      { kind: 'is-null', not: true, value: { kind: 'field-ref', source: 'file', field: 'archivedAt' } },
    ];
    const sql = engine.toSQL(selectIds(where), 'base').sql;
    expect(sql).toContain('"ownerId"'); // RLS stays
    expect(sql).not.toContain('IS NULL'); // default lifted (only `IS NOT NULL` remains)
    // Owner-1, archived ⇒ id 2 only.
    expect(await runIds(engine, selectIds(where))).toEqual([2]);
  });
});

describe('default conditions — where variants (derived / explicit / sql / run / deny)', () => {
  it('an EXPLICIT `without` behaves like a derived one', () => {
    const explicit: TypeBacking = {
      defaultConditions: [{ where: { expr: (a) => isNull(ref(a, 'archivedAt')) }, without: ['archivedAt'] }],
    };
    const { engine } = fileFixture(explicit);
    const where: SelectDef['where'] = [
      { kind: 'is-null', not: true, value: { kind: 'field-ref', source: 'file', field: 'archivedAt' } },
    ];
    expect(engine.toSQL(selectIds(), 'base').sql).toContain('"archivedAt" IS NULL');
    expect(engine.toSQL(selectIds(where), 'base').sql).not.toContain('IS NULL');
  });

  it('a SQL-only `where` (explicit `without`) emits in SQL, no-ops at runtime', async () => {
    const sqlOnly: TypeBacking = {
      defaultConditions: [{
        where: { sql: (a, ctx) => SqlText.join([ctx.dialect.field(a, 'archivedAt'), SqlText.raw('IS NULL')], ' ') },
        without: ['archivedAt'],
      }],
    };
    const { engine } = fileFixture(sqlOnly);
    expect(engine.toSQL(selectIds(), 'base').sql).toContain('"archivedAt" IS NULL');
    // No `run`/`expr` ⇒ the runtime cannot apply it ⇒ every row passes.
    expect(await runIds(engine, selectIds())).toEqual([1, 2, 3, 4]);
  });

  it('a RUN-only `where` (explicit `without`) filters at runtime, no-ops in SQL', async () => {
    const runOnly: TypeBacking = {
      defaultConditions: [{
        where: { run: (a, row) => (row[a]?.['archivedAt'] ?? null) === null },
        without: ['archivedAt'],
      }],
    };
    const { engine } = fileFixture(runOnly);
    expect(await runIds(engine, selectIds())).toEqual([1, 3]);
    // No `sql`/`expr` ⇒ nothing to AND into the emitted WHERE.
    expect(engine.toSQL(selectIds(), 'base').sql).not.toContain('IS NULL');
  });

  it('a statically DENYING `where` (⇒ false) emits FALSE / drops all rows', async () => {
    const deny: TypeBacking = { defaultConditions: [{ where: { expr: () => false } }] };
    const { engine } = fileFixture(deny);
    expect(engine.toSQL(selectIds(), 'base').sql).toContain('FALSE');
    expect(await runIds(engine, selectIds())).toEqual([]);
  });

  it('an allowing `where` (⇒ true) adds nothing / keeps all rows', async () => {
    const allow: TypeBacking = { defaultConditions: [{ where: { expr: () => true }, without: [] }] };
    const { engine } = fileFixture(allow);
    expect(engine.toSQL(selectIds(), 'base').sql).not.toContain('WHERE');
    expect(await runIds(engine, selectIds())).toEqual([1, 2, 3, 4]);
  });
});

describe('default conditions — describeType', () => {
  it('auto-summarizes a derived condition (predicate + reveal fields)', () => {
    const { file } = fileFixture(archivedBacking);
    const text = describeType(file, archivedBacking);
    expect(text).toContain('default: file.archivedAt IS NULL (unless a filter references archivedAt)');
  });

  it('uses an explicit `description` when given', () => {
    const backing: TypeBacking = {
      defaultConditions: [{ where: { expr: (a) => isNull(ref(a, 'archivedAt')) }, description: 'hides archived files' }],
    };
    const { file } = fileFixture(backing);
    expect(describeType(file, backing)).toContain('default: hides archived files');
  });

  it("marks an unliftable sql-only condition as always applied", () => {
    const backing: TypeBacking = {
      defaultConditions: [{ where: { sql: () => SqlText.raw('TRUE') } }],
    };
    const { file } = fileFixture(backing);
    expect(describeType(file, backing)).toContain('default: custom scope (always applied)');
  });
});

describe('default conditions — registration validation', () => {
  it('rejects a `without` field that does not exist on the Type', () => {
    const bad: TypeBacking = {
      defaultConditions: [{ where: { run: () => true }, without: ['nope'] }],
    };
    const registry = createRegistry();
    const file = registry.parseType(fileDef);
    expect(() => registry.registerType(file, bad)).toThrow(/'nope' does not exist on Type 'file'/);
  });

  it('accepts an explicit `without` naming a real field', () => {
    const ok: TypeBacking = {
      defaultConditions: [{ where: { run: () => true }, without: ['archivedAt'] }],
    };
    const registry = createRegistry();
    const file = registry.parseType(fileDef);
    expect(() => registry.registerType(file, ok)).not.toThrow();
  });
});
