/**
 * Coverage driver for the two search expression kinds:
 *   - exprs/text-search.ts
 *   - exprs/semantic.ts
 *
 * Exercises every public method across BOTH SQL dialects, every validation
 * Problem code/branch, the runtime evaluate branches (case-sensitivity, empty
 * tokens, correlation fallback, missing record, embedding cache hit/miss,
 * record-supplied embedding, degenerate cosine), cost, toJSON, clone, toCode,
 * forEachChild, and the private column / sensitivity / query SQL helpers.
 */
import { describe, it, expect } from 'vitest';
import { fixture, typeScope, runtimeFixture, lit, ref, param } from './_utils';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { Embedder } from '../engine';
import type { QueryScope } from '../scope';
import { TextSearchExpr } from '../exprs/text-search';
import { SemanticExpr } from '../exprs/semantic';
import { RuntimeContext } from '../runtime/context';
import { SqlContext } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import type { Dialect } from '../sql/dialect';
import type { ExprDef, SelectDef, QueryDef, TypeDef } from '../schema';
import type { Problems } from '../problem';

const fx = fixture();

function codes(p: Problems): string[] {
  return p.list.map((x) => x.code);
}

const bothSQL = (engine: QueryEngine, def: QueryDef): { base: string; pg: string } => ({
  base: engine.toSQL(def, 'base').sql,
  pg: engine.toSQL(def, 'postgres').sql,
});

// ─── Custom fixture: types tailored to the search/semantic branch matrix ──────

interface CustomFx {
  registry: ReturnType<typeof createRegistry>;
  engine: QueryEngine;
}

const itemTypeDef: TypeDef = {
  name: 'item',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // First full-text-searchable text field ⇒ drives `column()`'s searchable pick.
    { name: 'title', type: { kind: 'text', search: true } },
    // Plain (non-search/non-semantic) text ⇒ `field-not-semantic` + non-text-less.
    { name: 'plain', type: { kind: 'text' } },
    // Case-sensitive searchable text ⇒ drives the `sensitive` branches.
    { name: 'code', type: { kind: 'text', search: true, sensitive: true } },
  ],
  count: 100,
  bytes: 64,
};

// Not searchable, not semantic (no search/semantic text field, no relation).
const plainTypeDef: TypeDef = {
  name: 'plainType',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'label', type: { kind: 'text' } },
  ],
  count: 10,
  bytes: 32,
};

// No text field at all ⇒ drives `column()`'s `search` pseudo-column fallback.
const numericTypeDef: TypeDef = {
  name: 'numericType',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'qty', type: { kind: 'number' } },
  ],
  count: 10,
  bytes: 16,
};

function customFx(): CustomFx {
  const registry = createRegistry();
  for (const def of [itemTypeDef, plainTypeDef, numericTypeDef]) {
    registry.registerType(registry.parseType(def));
  }
  registry.finalize();
  const engine = new QueryEngine(registry);
  return { registry, engine };
}

const cfx = customFx();

/** A scope binding the custom types (and a non-type computed `c`). */
function customScope(): QueryScope {
  const scope = cfx.engine.globalScope();
  scope.bind('item', { kind: 'type', type: cfx.engine.type('item')!, source: 'item', synthetic: false });
  scope.bind('plainType', { kind: 'type', type: cfx.engine.type('plainType')!, source: 'plainType', synthetic: false });
  scope.bind('numericType', { kind: 'type', type: cfx.engine.type('numericType')!, source: 'numericType', synthetic: false });
  // A non-type binding (computed number) ⇒ the `bound.kind !== 'type'` arms.
  scope.bind('c', cfx.engine.resolveExpr(lit(1), scope));
  return scope;
}

/** A base-dialect SqlContext over a given scope (for direct toSQL of helpers). */
function baseCtx(scope: QueryScope): { dialect: Dialect; ctx: SqlContext } {
  const dialect = cfx.registry.dialect('base');
  if (!dialect) throw new Error('base dialect missing');
  const planner = new JoinCtePlanner(dialect, cfx.engine, undefined);
  return { dialect, ctx: new SqlContext(dialect, cfx.engine, scope, planner, undefined) };
}

/** Select over `item` projecting id, filtered by a predicate. */
function itemWhere(where: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: ref('item', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'item' },
    where: [where],
  };
}

/** Select over a named type projecting a single value expr. */
function selValue(type: string, expr: ExprDef): SelectDef {
  return { kind: 'select', fields: [{ expr, as: 's' }], from: { kind: 'type', type } };
}

// ─── A deterministic fake embedder ───────────────────────────────────────────

const fakeEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    // A 'zero'-bearing text embeds to the zero vector ⇒ degenerate cosine.
    if (text.includes('zero')) return [0, 0, 0];
    return [text.length, text.split(/\s+/).filter((t) => t.length > 0).length, 1];
  },
};

// ════════════════════════════════════════════════════════════════════════════
// TextSearchExpr
// ════════════════════════════════════════════════════════════════════════════

describe('TextSearchExpr', () => {
  it('static from: wrong kind throws; param-query parses; non-param query throws', () => {
    expect(() => TextSearchExpr.from(lit(1), fx.registry)).toThrow(/expected 'text-search'/);

    const paramDef: ExprDef = { kind: 'text-search', source: 'user', query: param('q') } as ExprDef;
    const parsed = TextSearchExpr.from(paramDef, fx.registry);
    expect(parsed.query.kind).toBe('param');

    // A non-param expr def as the query ⇒ parseQuery rejects it.
    const bad = JSON.parse(
      '{"kind":"text-search","source":"user","query":{"kind":"literal","value":1}}',
    ) as ExprDef;
    expect(() => TextSearchExpr.from(bad, fx.registry)).toThrow(/expected a param query/);
  });

  it('toSchema parses a text-search def (bare opts and an explicit depth)', () => {
    expect(TextSearchExpr.toSchema({}).safeParse({ kind: 'text-search', source: 'u', query: 'foo' }).success).toBe(true);
    // Explicit `types` + `depth` exercise the `??` left operands on the schema call.
    const withDepth = TextSearchExpr.toSchema({
      types: [],
      depth: { refs: 'open', typeNames: 'open', functions: 'names', filters: 'open' },
    });
    expect(withDepth.safeParse({ kind: 'text-search', source: 'u', query: 'foo' }).success).toBe(true);
  });

  it('resolve yields a non-nullable bool', () => {
    const r = fx.engine.resolveExpr({ kind: 'text-search', source: 'u', query: 'x' }, typeScope(fx));
    expect(r.kind === 'computed' && r.fieldType.resolve()).toBe('bool');
    expect(r.kind === 'computed' && r.nullable).toBe(false);
  });

  it('forEachChild visits the param (and nothing for a text query)', () => {
    let n = 0;
    fx.engine.parse({ kind: 'text-search', source: 'u', query: param('q') }).forEachChild(() => n++);
    expect(n).toBe(1);
    let m = 0;
    fx.engine.parse({ kind: 'text-search', source: 'u', query: 'x' }).forEachChild(() => m++);
    expect(m).toBe(0);
  });

  it('validateWalk reports every Problem code (and a clean searchable case)', () => {
    const scope = customScope();
    // unknown-source
    expect(codes(cfx.engine.validateExpr({ kind: 'text-search', source: 'nope', query: 'x' }, scope))).toContain(
      'text-search.unknown-source',
    );
    // not-a-type (a non-type binding)
    expect(codes(cfx.engine.validateExpr({ kind: 'text-search', source: 'c', query: 'x' }, scope))).toContain(
      'text-search.not-a-type',
    );
    // not-searchable (whole-source on a non-searchable type)
    expect(codes(cfx.engine.validateExpr({ kind: 'text-search', source: 'plainType', query: 'x' }, scope))).toContain(
      'text-search.not-searchable',
    );
    // unknown-field (field-narrowed, missing field)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'text-search', source: 'item', field: 'nope', query: 'x' }, scope)),
    ).toContain('text-search.unknown-field');
    // non-text (field-narrowed, non-text field)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'text-search', source: 'item', field: 'id', query: 'x' }, scope)),
    ).toContain('text-search.non-text');
    // A whole-source search on a searchable type ⇒ clean (no text-search errors).
    const ok = codes(cfx.engine.validateExpr({ kind: 'text-search', source: 'item', query: 'x' }, customScope()));
    expect(ok.filter((c) => c.startsWith('text-search.'))).toEqual([]);
    // A field-narrowed search on a text field ⇒ clean.
    const okField = codes(
      cfx.engine.validateExpr({ kind: 'text-search', source: 'item', field: 'title', query: 'x' }, customScope()),
    );
    expect(okField.filter((c) => c.startsWith('text-search.'))).toEqual([]);
  });

  it('validateWalk observes a param query', () => {
    const scope = customScope();
    // The param-query branch runs param.validateWalk; no text-search error arises.
    const c = codes(cfx.engine.validateExpr({ kind: 'text-search', source: 'item', query: param('q') }, scope));
    expect(c.filter((x) => x.startsWith('text-search.'))).toEqual([]);
  });

  it('cost adds the per-row scan penalty (text and param queries)', () => {
    const scope = typeScope(fx);
    const textCost = fx.engine.parse({ kind: 'text-search', source: 'u', query: 'x' }).cost(fx.engine, scope);
    expect(textCost.bytes).toBeGreaterThan(0);
    const paramCost = fx.engine.parse({ kind: 'text-search', source: 'u', query: param('q') }).cost(fx.engine, scope);
    expect(paramCost.bytes).toBeGreaterThanOrEqual(textCost.bytes);
  });

  it('toSQL: named field, whole-source searchable/first-text, both dialects', () => {
    // Named field on `item.title` (non-sensitive ⇒ LOWER / tsvector forms).
    const named = bothSQL(cfx.engine, itemWhere({ kind: 'text-search', source: 'item', field: 'title', query: 'foo' }));
    expect(named.base).toContain('LOWER(');
    expect(named.base).toContain('LIKE');
    expect(named.pg).toContain('to_tsvector(');
    expect(named.pg).toContain('plainto_tsquery(');

    // Whole-source over `item` ⇒ first searchable field (`title`).
    const whole = cfx.engine.toSQL(itemWhere({ kind: 'text-search', source: 'item', query: 'foo' }), 'base').sql;
    expect(whole).toContain('"item"."title"');

    // Whole-source over `plainType` ⇒ no searchable field, first text field (`label`).
    const firstText = cfx.engine
      .toSQL(
        {
          kind: 'select',
          fields: [{ expr: ref('plainType', 'id'), as: 'id' }],
          from: { kind: 'type', type: 'plainType' },
          where: [{ kind: 'text-search', source: 'plainType', query: 'foo' }],
        },
        'base',
      )
      .sql;
    expect(firstText).toContain('"plainType"."label"');
  });

  it('toSQL: sensitive field emits a plain LIKE (no LOWER), both dialects', () => {
    const sensitive = bothSQL(cfx.engine, itemWhere({ kind: 'text-search', source: 'item', field: 'code', query: 'X' }));
    expect(sensitive.base).toContain('LIKE');
    expect(sensitive.base).not.toContain('LOWER(');
    expect(sensitive.pg).toContain('LIKE');
    expect(sensitive.pg).not.toContain('to_tsvector(');
  });

  it('toSQL column(): pseudo-column fallback for unbound / non-type / no-text sources', () => {
    const { dialect, ctx } = baseCtx(customScope());
    // Unbound source ⇒ fallback `"ghost"."search"`.
    const ghost = new TextSearchExpr('ghost', undefined, { kind: 'text', text: 'x' });
    expect(ghost.toSQL(dialect, ctx).render(dialect).sql).toContain('"ghost"."search"');
    // Non-type binding `c` ⇒ fallback.
    const nonType = new TextSearchExpr('c', undefined, { kind: 'text', text: 'x' });
    expect(nonType.toSQL(dialect, ctx).render(dialect).sql).toContain('"c"."search"');
    // A bound type with no text field ⇒ fallback.
    const noText = new TextSearchExpr('numericType', undefined, { kind: 'text', text: 'x' });
    expect(noText.toSQL(dialect, ctx).render(dialect).sql).toContain('"numericType"."search"');
  });

  it('toSQL sensitiveColumn(): unbound / non-type / missing-field named sources are non-sensitive', () => {
    const { dialect, ctx } = baseCtx(customScope());
    // Named field on an UNBOUND source ⇒ sensitiveColumn !bound ⇒ false (LOWER form).
    const unbound = new TextSearchExpr('ghost', 'title', { kind: 'text', text: 'x' });
    expect(unbound.toSQL(dialect, ctx).render(dialect).sql).toContain('LOWER(');
    // Named field on a non-type binding ⇒ false.
    const nonType = new TextSearchExpr('c', 'title', { kind: 'text', text: 'x' });
    expect(nonType.toSQL(dialect, ctx).render(dialect).sql).toContain('LOWER(');
    // Named field that does not exist on the bound type ⇒ `?? false`.
    const missing = new TextSearchExpr('item', 'nope', { kind: 'text', text: 'x' });
    expect(missing.toSQL(dialect, ctx).render(dialect).sql).toContain('LOWER(');
  });

  it('toSQL querySQLText: param value present vs absent in ctx.params', () => {
    const def = itemWhere({ kind: 'text-search', source: 'item', field: 'title', query: param('q') });
    const present = cfx.engine.toSQL(def, 'base', { params: { q: 'foo' } });
    expect(present.params.some((v) => String(v).includes('foo'))).toBe(true);
    const absent = cfx.engine.toSQL(def, 'base');
    expect(absent.params.some((v) => String(v).includes('foo'))).toBe(false);
    expect(absent.params.some((v) => v === '%%')).toBe(true);
  });

  it('evaluateBool: whole-source case-insensitive match / no-match / empty tokens / missing record', async () => {
    const rfx = runtimeFixture();
    const ctx = new RuntimeContext(rfx.engine);
    const e = rfx.engine.parse({ kind: 'text-search', source: 'user', query: 'ADA' });
    // Case-insensitive by default ⇒ 'ADA' matches the 'Ada' record.
    expect(await (e as TextSearchExpr).evaluateBool(ctx, { user: { id: 1, name: 'Ada', email: 'ada@x.com' } })).toBe(
      true,
    );
    // No match.
    expect(
      await (e as TextSearchExpr).evaluateBool(ctx, { user: { id: 2, name: 'Bob', email: 'bob@x.com' } }),
    ).toBe(false);
    // Empty query ⇒ no tokens ⇒ false.
    const empty = rfx.engine.parse({ kind: 'text-search', source: 'user', query: '   ' });
    expect(await (empty as TextSearchExpr).evaluateBool(ctx, { user: { name: 'Ada' } })).toBe(false);
    // Missing record (no row entry, no correlation) ⇒ false.
    expect(await (e as TextSearchExpr).evaluateBool(ctx, {})).toBe(false);
  });

  it('evaluateBool: correlation fallback supplies the record', async () => {
    const rfx = runtimeFixture();
    const ctx = new RuntimeContext(rfx.engine);
    ctx.correlation = { user: { name: 'Cleo', email: 'cleo@x.com' } };
    const e = rfx.engine.parse({ kind: 'text-search', source: 'user', query: 'cleo' });
    expect(await (e as TextSearchExpr).evaluateBool(ctx, {})).toBe(true);
  });

  it('evaluateBool: param query text, field-narrowed string / non-string / null haystack', async () => {
    const ctx = new RuntimeContext(cfx.engine, { params: { q: 'spark' } });
    // Param query, field-narrowed text on `title`.
    const e = cfx.engine.parse({ kind: 'text-search', source: 'item', field: 'title', query: param('q') });
    expect(await (e as TextSearchExpr).evaluateBool(ctx, { item: { id: 1, title: 'a SPARK plug' } })).toBe(true);

    // Non-string field value ⇒ String(v) haystack (search id '5').
    const onId = cfx.engine.parse({ kind: 'text-search', source: 'item', field: 'id', query: '5' });
    const idCtx = new RuntimeContext(cfx.engine);
    expect(await (onId as TextSearchExpr).evaluateBool(idCtx, { item: { id: 5 } })).toBe(true);

    // Null field value ⇒ '' haystack ⇒ no match.
    const onPlain = cfx.engine.parse({ kind: 'text-search', source: 'item', field: 'plain', query: 'x' });
    expect(await (onPlain as TextSearchExpr).evaluateBool(idCtx, { item: { id: 1, plain: null } })).toBe(false);
  });

  it('evaluateBool: sensitivity defaults to false when the type/field is unknown', async () => {
    // Source is not a registered type ⇒ boundType undefined ⇒ `?? false`.
    const ctx = new RuntimeContext(cfx.engine);
    const ghost = new TextSearchExpr('ghost', 'f', { kind: 'text', text: 'hi' });
    expect(await ghost.evaluateBool(ctx, { ghost: { f: 'say hi' } })).toBe(true);
    // Field is unknown on a known type ⇒ `type.field(...)` undefined ⇒ `?? false`.
    const missing = new TextSearchExpr('item', 'nope', { kind: 'text', text: 'x' });
    expect(await missing.evaluateBool(ctx, { item: { id: 1, title: 'x' } })).toBe(false);
  });

  it('evaluateBool: a case-sensitive field matches only the exact case', async () => {
    const ctx = new RuntimeContext(cfx.engine);
    const e = cfx.engine.parse({ kind: 'text-search', source: 'item', field: 'code', query: 'abc' });
    // sensitive ⇒ no case folding ⇒ 'abc' does NOT match 'ABC'.
    expect(await (e as TextSearchExpr).evaluateBool(ctx, { item: { id: 1, code: 'ABC' } })).toBe(false);
    const exact = cfx.engine.parse({ kind: 'text-search', source: 'item', field: 'code', query: 'ABC' });
    expect(await (exact as TextSearchExpr).evaluateBool(ctx, { item: { id: 1, code: 'ABC zone' } })).toBe(true);
  });

  it('toJSON / clone / toCode for text + param queries, with and without field', () => {
    // Text query, no field.
    const textDef: ExprDef = { kind: 'text-search', source: 'u', query: 'hello' };
    const text = fx.engine.parse(textDef);
    expect(text.toJSON()).toEqual(textDef);
    expect(text.clone().toJSON()).toEqual(textDef);
    expect(text.clone()).not.toBe(text);
    expect(text.toCode()).toBe('search(u, "hello")');

    // Text query, with field.
    const fieldDef: ExprDef = { kind: 'text-search', source: 'u', field: 'name', query: 'hi' };
    const field = fx.engine.parse(fieldDef);
    expect(field.toJSON()).toEqual(fieldDef);
    expect(field.toCode()).toBe('search(u.name, "hi")');

    // Param query (deep clone of the param).
    const paramDef: ExprDef = { kind: 'text-search', source: 'u', query: param('q') };
    const p = fx.engine.parse(paramDef);
    expect(p.toJSON()).toEqual(paramDef);
    const pc = p.clone();
    expect(pc.toJSON()).toEqual(paramDef);
    expect((pc as TextSearchExpr).query).not.toBe((p as TextSearchExpr).query);
    expect(p.toCode()).toBe('search(u, :q)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SemanticExpr
// ════════════════════════════════════════════════════════════════════════════

describe('SemanticExpr', () => {
  it('static from: wrong kind throws; param-query parses; typeField parses; non-param throws', () => {
    expect(() => SemanticExpr.from(lit(1), fx.registry)).toThrow(/expected 'semantic'/);

    const paramDef: ExprDef = { kind: 'semantic', source: 'user', query: param('q') } as ExprDef;
    expect(SemanticExpr.from(paramDef, fx.registry).query.kind).toBe('param');

    const tfDef: ExprDef = { kind: 'semantic', source: 'user', query: { type: 'user', field: 'email' } } as ExprDef;
    expect(SemanticExpr.from(tfDef, fx.registry).query.kind).toBe('typeField');

    const bad = JSON.parse(
      '{"kind":"semantic","source":"user","query":{"kind":"literal","value":1}}',
    ) as ExprDef;
    expect(() => SemanticExpr.from(bad, fx.registry)).toThrow(/expected a param query/);
  });

  it('toSchema parses a semantic def (bare opts and an explicit depth)', () => {
    expect(SemanticExpr.toSchema({}).safeParse({ kind: 'semantic', source: 'u', query: 'foo' }).success).toBe(true);
    const withDepth = SemanticExpr.toSchema({
      types: [],
      depth: { refs: 'open', typeNames: 'open', functions: 'names', filters: 'open' },
    });
    expect(withDepth.safeParse({ kind: 'semantic', source: 'u', query: 'foo' }).success).toBe(true);
  });

  it('resolve yields a non-nullable number', () => {
    const r = fx.engine.resolveExpr({ kind: 'semantic', source: 'u', query: 'x' }, typeScope(fx));
    expect(r.kind === 'computed' && r.fieldType.resolve()).toBe('number');
    expect(r.kind === 'computed' && r.nullable).toBe(false);
  });

  it('forEachChild visits the param (and nothing for text / typeField)', () => {
    let n = 0;
    fx.engine.parse({ kind: 'semantic', source: 'u', query: param('q') }).forEachChild(() => n++);
    expect(n).toBe(1);
    let m = 0;
    fx.engine.parse({ kind: 'semantic', source: 'u', query: 'x' }).forEachChild(() => m++);
    expect(m).toBe(0);
  });

  it('validateWalk reports every Problem code (and clean cases)', () => {
    // unknown-source
    expect(codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'nope', query: 'x' }, customScope()))).toContain(
      'semantic.unknown-source',
    );
    // not-eligible (a non-semantic type)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'plainType', query: 'x' }, customScope())),
    ).toContain('semantic.not-eligible');
    // unknown-field
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', field: 'nope', query: 'x' }, customScope())),
    ).toContain('semantic.unknown-field');
    // field-not-semantic (a plain text field)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', field: 'plain', query: 'x' }, customScope())),
    ).toContain('semantic.field-not-semantic');
    // A semantic field ⇒ clean.
    const okField = codes(
      cfx.engine.validateExpr({ kind: 'semantic', source: 'item', field: 'title', query: 'x' }, customScope()),
    );
    expect(okField.filter((c) => c.startsWith('semantic.'))).toEqual([]);
  });

  it('validateWalk: pairing query codes (unbound / unknown-field / not-semantic) + valid self-pair; param observation', () => {
    const scope = () => customScope();
    // query-unbound (a `{ type }` referencing a Type not bound in scope)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: { type: 'nope', field: 'x' } }, scope())),
    ).toContain('semantic.query-unbound');
    // query-unbound (a `{ source }` naming an unbound source)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: { source: 'ghost', field: 'x' } }, scope())),
    ).toContain('semantic.query-unbound');
    // query-unbound (a `{ source }` naming a NON-type binding)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: { source: 'c', field: 'x' } }, scope())),
    ).toContain('semantic.query-unbound');
    // unknown-query-field (bound Type, missing field)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: { type: 'item', field: 'nope' } }, scope())),
    ).toContain('semantic.unknown-query-field');
    // query-not-semantic (plain text field)
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: { type: 'item', field: 'plain' } }, scope())),
    ).toContain('semantic.query-not-semantic');
    // A well-formed self-pairing (`item` bound once) ⇒ clean.
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: { type: 'item', field: 'title' } }, scope()))
        .filter((x) => x.startsWith('semantic.')),
    ).toEqual([]);
    // The `{ source, field }` form over a bound semantic source ⇒ clean.
    expect(
      codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: { source: 'item', field: 'title' } }, scope()))
        .filter((x) => x.startsWith('semantic.')),
    ).toEqual([]);
    // Param query observation ⇒ no semantic error.
    const c = codes(cfx.engine.validateExpr({ kind: 'semantic', source: 'item', query: param('q') }, scope()));
    expect(c.filter((x) => x.startsWith('semantic.'))).toEqual([]);
  });

  it('cost is a per-row embedding penalty', () => {
    const c = fx.engine.parse({ kind: 'semantic', source: 'u', query: 'x' }).cost(fx.engine, typeScope(fx));
    expect(c.rows).toBe(0);
    expect(c.bytes).toBeGreaterThan(0);
  });

  it('evaluate: no embedder ⇒ 0; null row ⇒ 0', async () => {
    // No embedder configured.
    const noEmb = new RuntimeContext(cfx.engine);
    const e = cfx.engine.parse({ kind: 'semantic', source: 'item', query: 'cat' });
    expect((await e.evaluate(noEmb, { item: { id: 1, title: 'cat' } })).raw).toBe(0);
    // Embedder present but a null row.
    const ctx = new RuntimeContext(cfx.engine, { embedder: fakeEmbedder });
    expect((await e.evaluate(ctx, null)).raw).toBe(0);
  });

  it('evaluate: empty param query vector ⇒ 0; pairing with an absent query source ⇒ 0', async () => {
    // Param query whose bound value is empty ⇒ queryVector null ⇒ 0.
    const emptyParam = new RuntimeContext(cfx.engine, { embedder: fakeEmbedder, params: { q: '' } });
    const ep = cfx.engine.parse({ kind: 'semantic', source: 'item', query: param('q') });
    expect((await ep.evaluate(emptyParam, { item: { id: 1, title: 'cat' } })).raw).toBe(0);
    // A `{ type }` pairing whose paired Type is NOT present in the row ⇒ 0.
    const ctx = new RuntimeContext(cfx.engine, { embedder: fakeEmbedder });
    const tf = SemanticExpr.from(
      { kind: 'semantic', source: 'item', query: { type: 'plainType', field: 'title' } } as ExprDef,
      cfx.registry,
    );
    expect((await tf.evaluate(ctx, { item: { id: 1, title: 'cat' } })).raw).toBe(0);
    // A `{ source }` pairing whose paired source is absent from the row ⇒ 0.
    const sf = SemanticExpr.from(
      { kind: 'semantic', source: 'item', query: { source: 'gone', field: 'title' } } as ExprDef,
      cfx.registry,
    );
    expect((await sf.evaluate(ctx, { item: { id: 1, title: 'cat' } })).raw).toBe(0);
  });

  it('evaluate: missing record ⇒ 0; correlation fallback supplies the record', async () => {
    const ctx = new RuntimeContext(cfx.engine, { embedder: fakeEmbedder, params: { q: 'cat' } });
    const e = cfx.engine.parse({ kind: 'semantic', source: 'item', query: param('q') });
    // No record under `item`, no correlation ⇒ 0.
    expect((await e.evaluate(ctx, {})).raw).toBe(0);
    // Correlation supplies the record.
    ctx.correlation = { item: { id: 7, title: 'cat nap' } };
    const v = await e.evaluate(ctx, {});
    expect(typeof v.raw).toBe('number');
  });

  it('evaluate: record-supplied embedding via embeddingOf (cosine of two vectors)', async () => {
    const ctx = new RuntimeContext(cfx.engine, {
      embedder: fakeEmbedder,
      // The record vector equals the query embedding ⇒ cosine ≈ 1.
      recordEmbedding: async () => fakeEmbedder.embed('hello'),
    });
    const e = cfx.engine.parse({ kind: 'semantic', source: 'item', query: 'hello' });
    const v = await e.evaluate(ctx, { item: { id: 1, title: 'unused' } });
    expect(v.raw).toBeCloseTo(1, 6);
  });

  it('evaluate: embedding-from-text miss then cache hit; whole-record vs field-narrowed; empty text ⇒ 0', async () => {
    // Miss: no recordEmbedding ⇒ embed the whole-record text and cache it.
    const ctx = new RuntimeContext(cfx.engine, { embedder: fakeEmbedder });
    const whole = cfx.engine.parse({ kind: 'semantic', source: 'item', query: 'hello' });
    const miss = await whole.evaluate(ctx, { item: { id: 1, title: 'a cat' } });
    expect(typeof miss.raw).toBe('number');
    expect(ctx.embeddingCache.has('embed:item:1')).toBe(true);

    // Hit: a pre-seeded cache entry is reused (id present ⇒ cache key uses id).
    const hitCtx = new RuntimeContext(cfx.engine, { embedder: fakeEmbedder });
    hitCtx.embeddingCache.set('embed:item:9', [3, 1, 1]);
    const hit = await whole.evaluate(hitCtx, { item: { id: 9, title: 'whatever' } });
    expect(typeof hit.raw).toBe('number');

    // id-less record ⇒ cache key falls back to the record signature.
    const sigCtx = new RuntimeContext(cfx.engine, { embedder: fakeEmbedder });
    const sig = await whole.evaluate(sigCtx, { item: { title: 'no id here' } });
    expect(typeof sig.raw).toBe('number');

    // Field-narrowed text path.
    const field = cfx.engine.parse({ kind: 'semantic', source: 'item', field: 'title', query: 'hello' });
    const fv = await field.evaluate(new RuntimeContext(cfx.engine, { embedder: fakeEmbedder }), {
      item: { id: 2, title: 'a dog' },
    });
    expect(typeof fv.raw).toBe('number');

    // Empty text (field value missing) ⇒ 0.
    const emptyText = await field.evaluate(new RuntimeContext(cfx.engine, { embedder: fakeEmbedder }), {
      item: { id: 3 },
    });
    expect(emptyText.raw).toBe(0);
  });

  it('evaluate: a degenerate (zero-norm) vector yields cosine 0', async () => {
    const ctx = new RuntimeContext(cfx.engine, {
      embedder: fakeEmbedder,
      recordEmbedding: async () => [0, 0, 0],
    });
    const e = cfx.engine.parse({ kind: 'semantic', source: 'item', query: 'hello' });
    expect((await e.evaluate(ctx, { item: { id: 1, title: 'x' } })).raw).toBe(0);
  });

  it('toSQL: text + param queries degrade to 0 (base) and emit cosine (postgres)', () => {
    const text = bothSQL(cfx.engine, selValue('item', { kind: 'semantic', source: 'item', query: 'cat' }));
    expect(text.base).toContain('0');
    expect(text.pg).toContain('<=>');
    expect(text.pg).toContain('"item"."embedding"');

    const par = bothSQL(cfx.engine, selValue('item', { kind: 'semantic', source: 'item', query: param('q') }));
    expect(par.pg).toContain('<=>');
  });

  it('toSQL: a typeField pairing query pairs both bound sides (self-pair over the single bound source)', () => {
    const def = selValue('item', { kind: 'semantic', source: 'item', query: { type: 'item', field: 'title' } });
    const base = cfx.engine.toSQL(def, 'base').sql;
    const pg = cfx.engine.toSQL(def, 'postgres').sql;
    // Base similarity degrades to a constant 0.
    expect(base).toContain('0 AS "s"');
    // Postgres pairs the single bound source's vector against itself.
    expect(pg).toContain('(1 - ("item"."embedding" <=> "item"."embedding"))');
  });

  it('toJSON / clone / toCode for text, param, and typeField queries (with/without field)', () => {
    // Text query, no field.
    const textDef: ExprDef = { kind: 'semantic', source: 'u', query: 'hi there' };
    const text = fx.engine.parse(textDef);
    expect(text.toJSON()).toEqual(textDef);
    expect(text.clone().toJSON()).toEqual(textDef);
    expect(text.clone()).not.toBe(text);
    expect(text.toCode()).toBe('semantic(u, "hi there")');

    // Param query, with field (deep clone of param).
    const paramDef: ExprDef = { kind: 'semantic', source: 'u', field: 'email', query: param('q') };
    const p = fx.engine.parse(paramDef);
    expect(p.toJSON()).toEqual(paramDef);
    const pc = p.clone();
    expect(pc.toJSON()).toEqual(paramDef);
    expect((pc as SemanticExpr).query).not.toBe((p as SemanticExpr).query);
    expect(p.toCode()).toBe('semantic(u.email, :q)');

    // typeField query.
    const tfDef: ExprDef = { kind: 'semantic', source: 'u', query: { type: 'user', field: 'email' } } as ExprDef;
    const tf = fx.engine.parse(tfDef);
    expect(tf.toJSON()).toEqual(tfDef);
    expect(tf.clone().toJSON()).toEqual(tfDef);
    expect(tf.toCode()).toBe('semantic(u, user.email)');
  });
});
