/**
 * A9 — a write cell can carry a `json` / `array` VALUE.
 *
 * Before 0.6.1 it could not, by four separate roads, and the last one is why
 * this is a P1 rather than a missing feature:
 *  - a RAW document (`{}` / `['x']`) was refused by the write parser, though
 *    `WriteValueDef` has always been documented as `JsonValue | ExprDef` — the
 *    TYPE and the PARSER disagreed;
 *  - OMITTING the cell instead is `insert.missing-required` on a non-nullable
 *    column;
 *  - no EXPRESSION could carry one (`LiteralExpr` took only a scalar);
 *  - and the `param` road PARSED and then bound SQL `NULL`: the write SUCCEEDED
 *    and the value was silently dropped.
 *
 * The assertions with teeth here are the ROUND TRIPS — write a document, read
 * the same document back out — plus the emitted SQL and its BOUND PARAMS, since
 * "it parsed" is exactly what the broken param road already did.
 *
 * A12 (0.6.2) closes the other half: the cast was decided by the VALUE's shape,
 * so a JSON *scalar* bound to a `json` column emitted uncast SQL that Postgres
 * rejects. The COLUMN decides now — see the A12 block below.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { buildSchemas } from '../llm/schemas';
import type { TypeDef, SelectDef, InsertDef, UpdateDef, ExprDef, JsonValue } from '../schema';

/** A Type shaped like the ones this ask came from: a settings blob + a tag list. */
const widgetDef: TypeDef = {
  name: 'widget',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    // NON-nullable on purpose: omitting the cell is `insert.missing-required`,
    // so "just leave it out" was never an escape from the old refusal.
    { name: 'settings', type: { kind: 'json' } },
    { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
    { name: 'blobs', type: { kind: 'array' }, nullable: true },
    // A native array whose ELEMENTS are documents — the one shape that makes
    // `Dialect.jsonValue` recurse into itself (see the emission block below).
    { name: 'docs', type: { kind: 'array', item: { kind: 'json' } }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'widget', field: 'id' }, count: 1 }] }],
  count: 100,
  bytes: 64,
};

const SETTINGS: JsonValue = { theme: 'dark', limits: { max: 5, tags: ['a', 'b'] }, enabled: true };

function engineOf(rows: readonly Record<string, JsonValue>[] = []): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(widgetDef));
  registry.finalize();
  return new QueryEngine(registry, { executors: { widget: arrayExecutor(rows) } });
}

/** The `id` / `settings` / `tags` projection, shared by RETURNING and SELECT. */
const readBackColumns = [
  { expr: { kind: 'field-ref', source: 'widget', field: 'id' }, as: 'id' },
  { expr: { kind: 'field-ref', source: 'widget', field: 'settings' }, as: 'settings' },
  { expr: { kind: 'field-ref', source: 'widget', field: 'tags' }, as: 'tags' },
] as const satisfies SelectDef['fields'];

/** `SELECT id, settings, tags FROM widget` — reads the stored documents back. */
const readBack: SelectDef = {
  kind: 'select',
  fields: [...readBackColumns],
  from: { kind: 'type', type: 'widget' },
  order: [{ expr: { kind: 'field-ref', source: 'widget', field: 'id' }, dir: 'asc' }],
};

// ─── The RAW document road ───────────────────────────────────────────────────

describe('A9 — a RAW document is a legal write value', () => {
  it('round-trips an INSERTed json document and text array unchanged', async () => {
    const engine = engineOf();
    const insert: InsertDef = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: 1, name: 'w', settings: SETTINGS, tags: ['x', 'y'] }],
      returning: [...readBackColumns],
    };
    expect(engine.validateQuery(insert).list.map((p) => p.code)).toEqual([]);
    // THE assertion: RETURNING reads the STORED row, so the same document comes
    // back out — not a null, and not a stringified approximation of it. (A write
    // is transactional per `run`, so RETURNING is how one call sees its own
    // write; a second `run` reloads from the executor.)
    expect((await engine.run(insert)).rows).toEqual([
      { id: 1, settings: SETTINGS, tags: ['x', 'y'] },
    ]);
  });

  it('round-trips an UPDATE that replaces a document', async () => {
    const engine = engineOf([{ id: 1, name: 'w', settings: { theme: 'light' }, tags: ['old'] }]);
    const update: UpdateDef = {
      kind: 'update',
      type: 'widget',
      set: { settings: SETTINGS, tags: ['new'] },
      returning: [...readBackColumns],
    };
    expect(engine.validateQuery(update).list.map((p) => p.code)).toEqual([]);
    expect((await engine.run(update)).rows).toEqual([{ id: 1, settings: SETTINGS, tags: ['new'] }]);
  });

  it('a SELECT reads a stored document back as itself', async () => {
    const engine = engineOf([{ id: 1, name: 'w', settings: SETTINGS, tags: ['x', 'y'] }]);
    expect((await engine.run(readBack)).rows).toEqual([{ id: 1, settings: SETTINGS, tags: ['x', 'y'] }]);
  });

  it('parses to a literal carrying the document (the def round-trips)', () => {
    const engine = engineOf();
    const insert: InsertDef = { kind: 'insert', into: 'widget', rows: [{ id: 1, name: 'w', settings: SETTINGS }] };
    expect(engine.parseQuery(insert).toJSON()).toEqual({
      kind: 'insert',
      into: 'widget',
      rows: [
        {
          id: { kind: 'literal', value: 1 },
          name: { kind: 'literal', value: 'w' },
          settings: { kind: 'literal', value: SETTINGS },
        },
      ],
    });
  });
});

// ─── The SQL side: ONE bound parameter, cast to the COLUMN's type ────────────

describe('A9 — a document binds as one parameter, cast to the column type', () => {
  const insert: InsertDef = {
    kind: 'insert',
    into: 'widget',
    rows: [{ id: 1, name: 'w', settings: SETTINGS, tags: ['x', 'y'] }],
  };

  it('Postgres casts a json column to jsonb and CONSTRUCTS a native text[]', () => {
    const { sql, params } = engineOf().toSQL(insert, 'postgres');
    // The document travels as ONE bound parameter — never interpolated.
    expect(sql).toContain('CAST($3 AS jsonb)');
    expect(params[2]).toBe(JSON.stringify(SETTINGS));
    // A NATIVE array column cannot take JSON text (`CAST('["x"]' AS text[])` is
    // a syntax error), so it is constructed from per-element binds instead.
    expect(sql).toContain('ARRAY[$4, $5]::text[]');
    expect(params.slice(3)).toEqual(['x', 'y']);
    // Nothing was string-interpolated into the statement.
    expect(sql).not.toContain('theme');
  });

  it('a heterogeneous array (no declared item type) stays jsonb', () => {
    const withBlobs: InsertDef = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: 1, name: 'w', settings: {}, blobs: [{ a: 1 }, 2] }],
    };
    const { sql, params } = engineOf().toSQL(withBlobs, 'postgres');
    expect(sql).toContain('CAST($4 AS jsonb)');
    expect(params[3]).toBe(JSON.stringify([{ a: 1 }, 2]));
    expect(sql).not.toContain('ARRAY[');
  });

  it('an empty native array emits the typed empty ARRAY Postgres accepts', () => {
    const empty: InsertDef = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: 1, name: 'w', settings: {}, tags: [] }],
    };
    expect(engineOf().toSQL(empty, 'postgres').sql).toContain('ARRAY[]::text[]');
  });

  it('the base dialect casts to its own portable json type', () => {
    const { sql, params } = engineOf().toSQL(insert, 'base');
    expect(sql).toContain('CAST(? AS json)');
    expect(params).toContain(JSON.stringify(SETTINGS));
  });

  it('an UPDATE SET emits the same cast against the column type', () => {
    const update: UpdateDef = { kind: 'update', type: 'widget', set: { settings: SETTINGS, tags: ['n'] } };
    const { sql } = engineOf().toSQL(update, 'postgres');
    expect(sql).toContain('"settings" = CAST($1 AS jsonb)');
    expect(sql).toContain('"tags" = ARRAY[$2]::text[]');
  });

  it('an array of DOCUMENTS binds each element as its own cast document', () => {
    // The element binding recurses: a native `jsonb[]` is CONSTRUCTED like any
    // other native array, but each element is itself a document and so takes the
    // same encode-and-cast treatment rather than being bound raw.
    const docs: InsertDef = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: 1, name: 'w', settings: {}, docs: [{ a: 1 }, { b: 2 }] }],
    };
    const { sql, params } = engineOf().toSQL(docs, 'postgres');
    expect(sql).toContain('ARRAY[CAST($4 AS jsonb), CAST($5 AS jsonb)]::jsonb[]');
    expect(params.slice(3)).toEqual(['{"a":1}', '{"b":2}']);
  });

  /** `SELECT id FROM widget WHERE settings = <right>` — a document OUTSIDE a write cell. */
  const whereSettings = (right: ExprDef): SelectDef => ({
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'widget', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'widget' },
    where: [{
      kind: 'comparison',
      op: '=',
      left: { kind: 'field-ref', source: 'widget', field: 'settings' },
      right,
    }],
  });

  it("a document with NO target column falls back to the dialect's own json type", () => {
    // Outside a write cell nothing supplies a target column — a document literal
    // in a WHERE knows only its own shape — so the cast names the DIALECT's json
    // type. The base dialect's is portable `json`; Postgres overrides to `jsonb`.
    const select = whereSettings({ kind: 'literal', value: SETTINGS });
    expect(engineOf().validateQuery(select).list.map((p) => p.code)).toEqual([]);
    expect(engineOf().toSQL(select, 'base').sql).toContain('= CAST(? AS json)');
    expect(engineOf().toSQL(select, 'postgres').sql).toContain('= CAST($1 AS jsonb)');
  });

  it('a PARAM bound to a document outside a write cell binds the same way', () => {
    // The write path routes through `writeCellSql`; every other position falls
    // back to `ParamExpr.toSQL`, which must bind the document rather than
    // collapse it to NULL — the A9 failure, in the one position A9's tests did
    // not reach.
    const select = whereSettings({ kind: 'param', name: 'cfg' });
    const { sql, params } = engineOf().toSQL(select, 'postgres', { params: { cfg: SETTINGS } });
    expect(sql).toContain('= CAST($1 AS jsonb)');
    expect(params).toEqual([JSON.stringify(SETTINGS)]);
  });
});

// ─── The PARAM road: bound, never silently NULL ──────────────────────────────

describe('A9 — a param bound to a document is BOUND, never silently NULL', () => {
  const insert: InsertDef = {
    kind: 'insert',
    into: 'widget',
    rows: [{ id: 1, name: 'w', settings: { kind: 'param', name: 'cfg' } }],
  };

  it('binds the supplied document instead of NULL (the silent data loss)', () => {
    const { sql, params } = engineOf().toSQL(insert, 'postgres', { params: { cfg: SETTINGS } });
    expect(sql).toContain('CAST($3 AS jsonb)');
    expect(params).toContain(JSON.stringify(SETTINGS));
    // The defect this replaces: the statement SUCCEEDED with a null in the slot.
    expect(params).not.toContain(null);
  });

  it('round-trips the bound document through the runtime', async () => {
    const engine = engineOf();
    const withReturning: InsertDef = { ...insert, returning: [...readBackColumns] };
    expect((await engine.run(withReturning, { params: { cfg: SETTINGS } })).rows).toEqual([
      { id: 1, settings: SETTINGS, tags: null },
    ]);
  });

  it('a write param is TYPED by its COLUMN, so it is no longer `param.untyped`', () => {
    const update: UpdateDef = {
      kind: 'update',
      type: 'widget',
      set: { settings: { kind: 'param', name: 'cfg' } },
    };
    const engine = engineOf();
    const scope = engine.globalScope();
    expect(engine.validateQuery(update, scope).list.map((p) => p.code)).toEqual([]);
    // The column is the ONLY place a write cell's param type can come from —
    // nothing else in the cell observes it, which is why this reported
    // `param.untyped` before.
    expect(scope.params.resolved('cfg')?.resolve()).toBe('json');
  });

  it('an unbound param still binds NULL (nothing was supplied to bind)', () => {
    const { params } = engineOf().toSQL(insert, 'postgres');
    expect(params).toContain(null);
  });
});

// ─── A12: the CAST is decided by the COLUMN, not by the value's shape ────────

describe('A12 — a json cell is JSON-encoded and cast because the COLUMN is json', () => {
  /** `INSERT … (settings) VALUES (:cfg)` — the only road a scalar reaches a json cell. */
  const insert: InsertDef = {
    kind: 'insert',
    into: 'widget',
    rows: [{ id: 1, name: 'w', settings: { kind: 'param', name: 'cfg' } }],
  };

  it.each([
    ['a bare string', '"a bare string"'],
    [42, '42'],
    [true, 'true'],
  ] as const)('encodes + casts the scalar %j bound to a json param', (value, encoded) => {
    // Until 0.6.2 the routing asked the VALUE ("is it a document?"), so a JSON
    // SCALAR — every one of these a legal value of a `json` column — was bound
    // raw and uncast (`VALUES ($1, $2)`), which Postgres rejects at run time
    // with nothing upstream to catch it.
    const { sql, params } = engineOf().toSQL(insert, 'postgres', { params: { cfg: value } });
    expect(sql).toContain('CAST($3 AS jsonb)');
    // BOTH halves matter: a cast alone would emit `CAST('a bare string' AS jsonb)`,
    // which is invalid JSON input — one run-time error swapped for another.
    expect(params[2]).toBe(encoded);
  });

  it('round-trips a scalar bound to a json column through the runtime', async () => {
    const engine = engineOf();
    const withReturning: InsertDef = { ...insert, returning: [...readBackColumns] };
    expect((await engine.run(withReturning, { params: { cfg: 'a bare string' } })).rows).toEqual([
      { id: 1, settings: 'a bare string', tags: null },
    ]);
  });

  it('a NULL still binds SQL NULL — never the JSON value `null`', () => {
    // The exemption that has to survive the widening: a null literal is the
    // documented (and only) way to write SQL NULL, and an unbound param binds
    // NULL. Routing either through `jsonValue` would emit `CAST('null' AS jsonb)`
    // — the JSON value `null`, which is a different thing in a jsonb column.
    const bound = engineOf().toSQL(insert, 'postgres', { params: { cfg: null } });
    expect(bound.sql).toContain('VALUES ($1, $2, $3)');
    expect(bound.params[2]).toBe(null);
    const nullLiteral: UpdateDef = {
      kind: 'update',
      type: 'widget',
      set: { settings: { kind: 'literal', value: null } },
    };
    expect(engineOf().toSQL(nullLiteral, 'postgres').sql).toContain('"settings" = NULL');
  });

  it('an UPDATE SET casts a scalar the same way', () => {
    const update: UpdateDef = { kind: 'update', type: 'widget', set: { settings: { kind: 'param', name: 'cfg' } } };
    const { sql, params } = engineOf().toSQL(update, 'postgres', { params: { cfg: 7 } });
    expect(sql).toContain('"settings" = CAST($1 AS jsonb)');
    expect(params[0]).toBe('7');
  });

  it('the base dialect casts a scalar to its own portable json type', () => {
    const { sql, params } = engineOf().toSQL(insert, 'base', { params: { cfg: 'x' } });
    expect(sql).toContain('CAST(? AS json)');
    expect(params).toContain('"x"');
  });

  it('a NATIVE array column is left alone — a scalar there has no correct cast', () => {
    // `CAST('x' AS text[])` is a syntax error, and a scalar is not a value of an
    // array column at all. That stays a VALUE problem (`write.type` on the
    // literal road), not something emission can paper over.
    const arrayInsert: InsertDef = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: 1, name: 'w', settings: {}, tags: { kind: 'param', name: 't' } }],
    };
    const { sql } = engineOf().toSQL(arrayInsert, 'postgres', { params: { t: 'x' } });
    expect(sql).toContain('VALUES ($1, $2, CAST($3 AS jsonb), $4)');
  });

  it('a text column is untouched — only a json column encodes', () => {
    const { sql, params } = engineOf().toSQL(
      { kind: 'insert', into: 'widget', rows: [{ id: 1, name: { kind: 'param', name: 'n' }, settings: {} }] },
      'postgres',
      { params: { n: 'w' } },
    );
    expect(sql).toContain('VALUES ($1, $2, CAST($3 AS jsonb))');
    expect(params[1]).toBe('w'); // the raw string, not `"w"`
  });

  it('emission does not assume validation ran — the literal road casts too, and is still refused', () => {
    // A scalar LITERAL into a json column is refused by `write.type`
    // (`JsonFieldType.comparableWith`), which is why only the param road could
    // reach the database. `toSQL` carries no guarantee that validation ran, so
    // it emits the correct statement anyway — without loosening the refusal.
    const literal: InsertDef = { kind: 'insert', into: 'widget', rows: [{ id: 1, name: 'w', settings: 'bare' }] };
    expect(engineOf().validateQuery(literal).list.map((p) => p.code)).toContain('write.type');
    const { sql, params } = engineOf().toSQL(literal, 'postgres');
    expect(sql).toContain('CAST($3 AS jsonb)');
    expect(params[2]).toBe('"bare"');
  });
});

// ─── The model-facing SCHEMA and the parser now agree ────────────────────────

describe('A9 — the wire schema and the parser accept the same write values', () => {
  const row = { id: 1, name: 'w', settings: SETTINGS, tags: ['x', 'y'] };

  it("writes:'typed' accepts a RAW document — which it always did, while the parser refused it", () => {
    // `writeValueSchema` has always offered `field.fieldType.toValueSchema()`,
    // so the model was INVITED to emit a document into a json cell and the
    // parser then reported `shape.type`. That was the disagreement.
    const schemas = buildSchemas(engineOf(), { depth: { writes: 'typed' } });
    expect(schemas.Insert.safeParse({ kind: 'insert', into: 'widget', rows: [row] }).success).toBe(true);
  });

  it("writes:'names' accepts the same document as a LITERAL expr", () => {
    const schemas = buildSchemas(engineOf(), { depth: { writes: 'names' } });
    const asLiteral = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: { kind: 'literal', value: 1 }, name: { kind: 'literal', value: 'w' }, settings: { kind: 'literal', value: SETTINGS } }],
    };
    expect(schemas.Insert.safeParse(asLiteral).success).toBe(true);
  });
});

// ─── The value must SUIT the column ──────────────────────────────────────────

describe('A9 — a write value is checked against its column', () => {
  it('refuses a document written to a text column (`write.type`)', () => {
    const engine = engineOf();
    const insert: InsertDef = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: 1, name: { a: 1 }, settings: {} }],
    };
    expect(engine.validateQuery(insert).list.map((p) => p.code)).toContain('write.type');
  });

  it('refuses a text value written to a json column, in an UPDATE too', () => {
    const engine = engineOf();
    const update: UpdateDef = { kind: 'update', type: 'widget', set: { settings: 'not a document' } };
    expect(engine.validateQuery(update).list.map((p) => p.code)).toContain('write.type');
  });

  it('accepts NULL into a nullable column and a scalar into its own kind', () => {
    const engine = engineOf();
    const update: UpdateDef = {
      kind: 'update',
      type: 'widget',
      set: { name: 'ok', tags: { kind: 'literal', value: null } },
    };
    expect(engine.validateQuery(update).list.map((p) => p.code)).toEqual([]);
  });

  it('VALIDATES an INSERT VALUES expr — these were never walked at all', () => {
    // A bad ref inside a VALUES cell used to be accepted silently and only
    // surfaced at emit / run time.
    const engine = engineOf();
    const insert: InsertDef = {
      kind: 'insert',
      into: 'widget',
      rows: [{ id: 1, name: { kind: 'field-ref', source: 'widget', field: 'nope' }, settings: {} }],
    };
    expect(engine.validateQuery(insert).list.map((p) => p.code)).toContain('ref.unknown-field');
  });
});
