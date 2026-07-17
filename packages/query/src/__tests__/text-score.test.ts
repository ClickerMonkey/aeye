/**
 * TextScoreExpr — the NUMERIC full-text relevance SCORE (the ranking
 * counterpart of the `text-search` predicate). Covers, across BOTH dialects +
 * the in-memory runtime:
 *  - EXACT `ts_rank` SQL (postgres) over a conceptual column, a hidden
 *    `vectorField`, and a boolean `sql` override lifted to a numeric 0/1;
 *  - the base (ANSI) numeric degrade `CASE WHEN <LIKE> THEN 1 ELSE 0 END`;
 *  - a sensitive field degrading to a numeric `LIKE` match (both dialects);
 *  - `ORDER BY score DESC LIMIT 10` (exact SQL) + a runtime top-N run;
 *  - the runtime relevance (token fraction), the `run` override (1/0), the
 *    hidden-field text path, correlation fallback, empty query, missing record;
 *  - every validation Problem code; capability gating; the `e.textScore`
 *    builder; toSchema; toJSON / clone / toCode round-trip; forEachChild; cost.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { RuntimeContext } from '../runtime/context';
import { SqlText } from '../sql/emit';
import { buildSchemas } from '../llm/schemas';
import { TextScoreExpr } from '../exprs/text-score';
import { e } from '../builder';
import { cctx, lit, param } from './_utils';
import type { QueryScope } from '../scope';
import type { TypeDef, SelectDef, ExprDef, QueryDef, TypeBacking } from '../schema';
import type { SourceRecord } from '../runtime/row';
import type { Problems } from '../problem';

function codes(p: Problems): string[] {
  return p.list.map((x) => x.code);
}
const bothSQL = (engine: QueryEngine, def: QueryDef): { base: string; pg: string } => ({
  base: engine.toSQL(def, 'base').sql,
  pg: engine.toSQL(def, 'postgres').sql,
});

// ─── Types ─────────────────────────────────────────────────────────────────────

/** `plain` — searchable text (`title`) + a case-sensitive `code`; NO backing. */
const plainDef: TypeDef = {
  name: 'plain',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text', search: true } },
    { name: 'code', type: { kind: 'text', search: true, sensitive: true } },
    { name: 'note', type: { kind: 'text' } },
    { name: 'qty', type: { kind: 'number' } },
  ],
  count: 100,
  bytes: 64,
};
/** `art` — a hidden `search_tsv` tsvector backing + per-field run / sql overrides. */
const artDef: TypeDef = {
  name: 'art',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text', search: true } },
    { name: 'code', type: { kind: 'text', search: true } },
    { name: 'ovr', type: { kind: 'text', search: true } },
    { name: 'ovrF', type: { kind: 'text', search: true } },
  ],
  count: 100,
  bytes: 64,
};
const artBacking: TypeBacking = {
  search: { vectorField: 'search_tsv', language: 'english' },
  fields: {
    code: { search: { sql: (a) => SqlText.raw(`${a}_ovr`) } },
    ovr: { search: { run: () => true } },
    ovrF: { search: { run: () => false } },
  },
};
/** `nosrch` — NO searchable field (gates `text-score` OUT). */
const nosrchDef: TypeDef = {
  name: 'nosrch',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'label', type: { kind: 'text' } },
  ],
  count: 10,
  bytes: 16,
};

function makeEngine(opts?: { rows?: boolean }): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(plainDef));
  registry.registerType(registry.parseType(artDef), artBacking);
  registry.finalize();
  return new QueryEngine(registry, {
    executors: opts?.rows
      ? {
          plain: arrayExecutor([
            { id: 1, title: 'search ranking basics', code: 'ABC', note: '' },
            { id: 2, title: 'unrelated notes', code: 'XYZ', note: '' },
          ] as SourceRecord[]),
          art: arrayExecutor([
            { id: 1, title: 'x', code: 'C', ovr: 'o', ovrF: 'o', search_tsv: 'search ranking basics full text' },
          ] as SourceRecord[]),
        }
      : {},
  });
}

/** Select one value expr over a named type, projected as `score`. */
function scoreOf(type: string, expr: ExprDef): SelectDef {
  return { kind: 'select', fields: [{ expr, as: 'score' }], from: { kind: 'type', type } };
}

// ════════════════════════════════════════════════════════════════════════════
// SQL emission — exact ts_rank (pg) + base degrade
// ════════════════════════════════════════════════════════════════════════════

describe('TextScoreExpr: SQL', () => {
  const engine = makeEngine();

  it('default conceptual column: pg ts_rank, base numeric match (field + whole-source)', () => {
    const field = bothSQL(engine, scoreOf('plain', { kind: 'text-score', source: 'plain', field: 'title', query: 'ranking' }));
    expect(field.pg).toBe('SELECT ts_rank(to_tsvector("plain"."title"), plainto_tsquery($1)) AS "score" FROM "plain" AS "plain"');
    expect(field.base).toBe('SELECT CASE WHEN LOWER("plain"."title") LIKE LOWER(?) THEN 1 ELSE 0 END AS "score" FROM "plain" AS "plain"');
    // Whole-source ⇒ the first searchable field (`title`).
    const whole = engine.toSQL(scoreOf('plain', { kind: 'text-score', source: 'plain', query: 'ranking' }), 'postgres').sql;
    expect(whole).toContain('ts_rank(to_tsvector("plain"."title")');
  });

  it('a hidden vectorField ranks the precomputed tsvector (pg ts_rank + language; base degrade)', () => {
    const s = bothSQL(engine, scoreOf('art', { kind: 'text-score', source: 'art', query: 'ranking' }));
    expect(s.pg).toContain(`ts_rank("art"."search_tsv", plainto_tsquery('english', $1))`);
    expect(s.base).toContain(`CASE WHEN LOWER("art"."search_tsv") LIKE ('%' || LOWER(?) || '%') THEN 1 ELSE 0 END`);
  });

  it('a boolean sql override is lifted to a numeric 0/1 via matchScore', () => {
    const pg = engine.toSQL(scoreOf('art', { kind: 'text-score', source: 'art', field: 'code', query: 'x' }), 'postgres').sql;
    expect(pg).toContain('CASE WHEN art_ovr THEN 1 ELSE 0 END');
  });

  it('a sensitive field degrades to a numeric LIKE match (both dialects)', () => {
    const s = bothSQL(engine, scoreOf('plain', { kind: 'text-score', source: 'plain', field: 'code', query: 'X' }));
    expect(s.pg).toBe('SELECT CASE WHEN "plain"."code" LIKE $1 THEN 1 ELSE 0 END AS "score" FROM "plain" AS "plain"');
    expect(s.base).toBe('SELECT CASE WHEN "plain"."code" LIKE ? THEN 1 ELSE 0 END AS "score" FROM "plain" AS "plain"');
  });

  it('ORDER BY score DESC LIMIT 10 (exact pg SQL)', () => {
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'plain', field: 'id' }, as: 'id' },
        { expr: { kind: 'text-score', source: 'plain', field: 'title', query: 'ranking' }, as: 'score' },
      ],
      from: { kind: 'type', type: 'plain' },
      order: [{ expr: { kind: 'output', name: 'score' }, dir: 'desc' }],
      limit: 10,
    };
    expect(engine.toSQL(def, 'postgres').sql).toBe(
      'SELECT "plain"."id" AS "id", ts_rank(to_tsvector("plain"."title"), plainto_tsquery($1)) AS "score" ' +
        'FROM "plain" AS "plain" ORDER BY ts_rank(to_tsvector("plain"."title"), plainto_tsquery($2)) DESC LIMIT 10',
    );
  });

  it('a param query threads the bound value (present / absent)', () => {
    const def = scoreOf('plain', { kind: 'text-score', source: 'plain', field: 'title', query: param('q') });
    const present = engine.toSQL(def, 'postgres', { params: { q: 'ranking' } });
    expect(present.params).toContain('ranking');
    const absent = engine.toSQL(def, 'postgres');
    expect(absent.params).toContain('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime
// ════════════════════════════════════════════════════════════════════════════

describe('TextScoreExpr: runtime', () => {
  it('scores the token fraction and orders top-N desc', async () => {
    const engine = makeEngine({ rows: true });
    const def: SelectDef = {
      kind: 'select',
      fields: [
        { expr: { kind: 'field-ref', source: 'plain', field: 'id' }, as: 'id' },
        { expr: { kind: 'text-score', source: 'plain', field: 'title', query: 'ranking basics' }, as: 'score' },
      ],
      from: { kind: 'type', type: 'plain' },
      order: [{ expr: { kind: 'output', name: 'score' }, dir: 'desc' }],
      limit: 10,
    };
    const res = await engine.run(def);
    expect(res.rows.map((r) => [r['id'], r['score']])).toEqual([
      [1, 1], // 'search ranking basics' contains both tokens ⇒ 1
      [2, 0], // 'unrelated notes' contains neither ⇒ 0
    ]);
  });

  it('a partial match yields a fractional score', async () => {
    const engine = makeEngine();
    const ctx = new RuntimeContext(engine);
    const expr = engine.parse({ kind: 'text-score', source: 'plain', field: 'title', query: 'ranking missing' });
    // 1 of 2 tokens present ⇒ 0.5.
    expect((await expr.evaluate(ctx, { plain: { id: 1, title: 'search ranking basics' } })).raw).toBe(0.5);
  });

  it('a run override decides 1 / 0; a hidden vectorField text is scored', async () => {
    const engine = makeEngine();
    const ctx = new RuntimeContext(engine);
    const yes = engine.parse({ kind: 'text-score', source: 'art', field: 'ovr', query: 'anything' });
    expect((await yes.evaluate(ctx, { art: { id: 1, ovr: 'zzz' } })).raw).toBe(1);
    const no = engine.parse({ kind: 'text-score', source: 'art', field: 'ovrF', query: 'anything' });
    expect((await no.evaluate(ctx, { art: { id: 1, ovrF: 'zzz' } })).raw).toBe(0);
    // Whole-type ⇒ the hidden `search_tsv` text is scored (token fraction).
    const vf = engine.parse({ kind: 'text-score', source: 'art', query: 'ranking basics' });
    expect((await vf.evaluate(ctx, { art: { id: 1, search_tsv: 'search ranking basics full text' } })).raw).toBe(1);
  });

  it('null row / missing record ⇒ 0; correlation supplies the record', async () => {
    const engine = makeEngine();
    const ctx = new RuntimeContext(engine);
    const expr = engine.parse({ kind: 'text-score', source: 'plain', field: 'title', query: 'x' });
    expect((await expr.evaluate(ctx, null)).raw).toBe(0);
    expect((await expr.evaluate(ctx, {})).raw).toBe(0);
    ctx.correlation = { plain: { id: 9, title: 'x marks' } };
    expect((await expr.evaluate(ctx, {})).raw).toBe(1);
  });

  it('an unregistered source / missing field defaults case-sensitivity to false', async () => {
    const engine = makeEngine();
    const ctx = new RuntimeContext(engine);
    // Source is not a registered Type ⇒ boundType undefined ⇒ `?? false` + no backing.
    const ghost = new TextScoreExpr('ghost', 'body', { kind: 'text', text: 'hi' });
    expect((await ghost.evaluate(ctx, { ghost: { body: 'say hi' } })).raw).toBe(1);
    // A field unknown on a REAL type ⇒ `type.field(...)` undefined ⇒ `?? false`.
    const missing = new TextScoreExpr('plain', 'zzz', { kind: 'text', text: 'hi' });
    expect((await missing.evaluate(ctx, { plain: { zzz: 'say hi' } })).raw).toBe(1);
  });

  it('empty query ⇒ 0; a sensitive field is case-sensitive; whole-record scoring', async () => {
    const engine = makeEngine();
    const ctx = new RuntimeContext(engine);
    const empty = engine.parse({ kind: 'text-score', source: 'plain', field: 'title', query: '   ' });
    expect((await empty.evaluate(ctx, { plain: { title: 'search ranking' } })).raw).toBe(0);
    // Sensitive `code` ⇒ 'abc' does NOT match 'ABC'.
    const sens = engine.parse({ kind: 'text-score', source: 'plain', field: 'code', query: 'abc' });
    expect((await sens.evaluate(ctx, { plain: { code: 'ABC' } })).raw).toBe(0);
    // Whole-record (no field) ⇒ all string values are the haystack.
    const whole = engine.parse({ kind: 'text-score', source: 'plain', query: 'ranking' });
    expect((await whole.evaluate(ctx, { plain: { title: 'ranking works', code: 'q' } })).raw).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Class conventions — from / toSchema / resolve / validate / cost / JSON
// ════════════════════════════════════════════════════════════════════════════

describe('TextScoreExpr: conventions', () => {
  const engine = makeEngine();

  it('static from: wrong kind throws; text + param parse; non-param throws', () => {
    expect(() => TextScoreExpr.from(lit(1), engine.registry)).toThrow(/expected 'text-score'/);
    const parsed = TextScoreExpr.from({ kind: 'text-score', source: 'plain', query: param('q') } as ExprDef, engine.registry);
    expect(parsed.query.kind).toBe('param');
    const bad = JSON.parse('{"kind":"text-score","source":"plain","query":{"kind":"literal","value":1}}') as ExprDef;
    expect(() => TextScoreExpr.from(bad, engine.registry)).toThrow(/expected a param query/);
  });

  it('toSchema parses a text-score def (bare opts + explicit depth)', () => {
    expect(TextScoreExpr.toSchema({}).safeParse({ kind: 'text-score', source: 'u', query: 'foo' }).success).toBe(true);
    const withDepth = TextScoreExpr.toSchema({
      types: [],
      depth: { refs: 'open', typeNames: 'open', functions: 'names', filters: 'open' },
    });
    expect(withDepth.safeParse({ kind: 'text-score', source: 'u', query: 'foo' }).success).toBe(true);
  });

  it('resolve yields a non-nullable number; forEachChild visits the param only', () => {
    const scope = engine.globalScope();
    scope.bind('plain', { kind: 'type', type: engine.type('plain')!, source: 'plain', synthetic: false });
    const r = engine.resolveExpr({ kind: 'text-score', source: 'plain', query: 'x' }, scope);
    expect(r.kind === 'computed' && r.fieldType.resolve()).toBe('number');
    expect(r.kind === 'computed' && r.nullable).toBe(false);
    let n = 0;
    engine.parse({ kind: 'text-score', source: 'plain', query: param('q') }).forEachChild(() => n++);
    expect(n).toBe(1);
    let m = 0;
    engine.parse({ kind: 'text-score', source: 'plain', query: 'x' }).forEachChild(() => m++);
    expect(m).toBe(0);
  });

  it('validateWalk reports every Problem code (and clean cases)', () => {
    const scope: QueryScope = engine.globalScope();
    scope.bind('plain', { kind: 'type', type: engine.type('plain')!, source: 'plain', synthetic: false });
    scope.bind('c', engine.resolveExpr(lit(1), scope));
    // unknown-source
    expect(codes(engine.validateExpr({ kind: 'text-score', source: 'nope', query: 'x' }, scope))).toContain('text-score.unknown-source');
    // not-a-type
    expect(codes(engine.validateExpr({ kind: 'text-score', source: 'c', query: 'x' }, scope))).toContain('text-score.not-a-type');
    // unknown-field
    expect(codes(engine.validateExpr({ kind: 'text-score', source: 'plain', field: 'zzz', query: 'x' }, scope))).toContain('text-score.unknown-field');
    // non-text (a number field)
    expect(codes(engine.validateExpr({ kind: 'text-score', source: 'plain', field: 'qty', query: 'x' }, scope))).toContain('text-score.non-text');
    // A whole-source score on a searchable type ⇒ clean.
    expect(codes(engine.validateExpr({ kind: 'text-score', source: 'plain', query: 'x' }, scope)).filter((c) => c.startsWith('text-score.'))).toEqual([]);
    // A field-narrowed score on a text field ⇒ clean; a param query is observed.
    expect(codes(engine.validateExpr({ kind: 'text-score', source: 'plain', field: 'title', query: param('q') }, scope)).filter((c) => c.startsWith('text-score.'))).toEqual([]);
  });

  it('not-searchable: a Type with no searchable field is rejected whole-source', () => {
    const registry = createRegistry();
    registry.registerType(registry.parseType(nosrchDef));
    registry.finalize();
    const eng = new QueryEngine(registry);
    const scope = eng.globalScope();
    scope.bind('nosrch', { kind: 'type', type: eng.type('nosrch')!, source: 'nosrch', synthetic: false });
    expect(codes(eng.validateExpr({ kind: 'text-score', source: 'nosrch', query: 'x' }, scope))).toContain('text-score.not-searchable');
  });

  it('exposes a per-row scan penalty via scanRowPenalty', () => {
    const scope = engine.globalScope();
    scope.bind('plain', { kind: 'type', type: engine.type('plain')!, source: 'plain', synthetic: false });
    const e = engine.parse({ kind: 'text-score', source: 'plain', query: 'x' });
    expect(e.cost(cctx(engine), scope).rows).toBe(0);
    expect(e.scanRowPenalty()).toBeGreaterThan(0);
  });

  it('toJSON / clone / toCode round-trip (text + param, with/without field)', () => {
    const textDef: ExprDef = { kind: 'text-score', source: 'plain', query: 'hello' };
    const text = engine.parse(textDef);
    expect(text.toJSON()).toEqual(textDef);
    expect(text.clone().toJSON()).toEqual(textDef);
    expect(text.clone()).not.toBe(text);
    expect(text.toCode()).toBe('textScore(plain, "hello")');

    const fieldDef: ExprDef = { kind: 'text-score', source: 'plain', field: 'title', query: 'hi' };
    expect(engine.parse(fieldDef).toJSON()).toEqual(fieldDef);
    expect(engine.parse(fieldDef).toCode()).toBe('textScore(plain.title, "hi")');

    const paramDef: ExprDef = { kind: 'text-score', source: 'plain', query: param('q') };
    const p = engine.parse(paramDef);
    expect(p.toJSON()).toEqual(paramDef);
    const pc = p.clone();
    expect(pc.toJSON()).toEqual(paramDef);
    expect((pc as TextScoreExpr).query).not.toBe((p as TextScoreExpr).query);
    expect(p.toCode()).toBe('textScore(plain, :q)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Builder + capability gating
// ════════════════════════════════════════════════════════════════════════════

describe('TextScoreExpr: builder + gating', () => {
  it('e.textScore builds a TextScoreExpr (text + param, with/without field)', () => {
    expect(e.textScore('plain', 'ranking').toJSON()).toEqual({ kind: 'text-score', source: 'plain', query: 'ranking' });
    expect(e.textScore('plain', 'ranking', 'title').toJSON()).toEqual({
      kind: 'text-score',
      source: 'plain',
      field: 'title',
      query: 'ranking',
    });
    expect(e.textScore('plain', e.param('q')).toJSON()).toEqual({
      kind: 'text-score',
      source: 'plain',
      query: { kind: 'param', name: 'q' },
    });
  });

  it('appears in the LLM Expr schema only where a searchable field exists', () => {
    const engine = makeEngine();
    const withSearch = buildSchemas(engine, { depth: 'open' });
    expect(withSearch.Expr.safeParse({ kind: 'text-score', source: 'plain', query: 'x' }).success).toBe(true);

    const registry = createRegistry();
    registry.registerType(registry.parseType(nosrchDef));
    registry.finalize();
    const noSearch = buildSchemas(new QueryEngine(registry), { depth: 'open' });
    expect(noSearch.Expr.safeParse({ kind: 'text-score', source: 'nosrch', query: 'x' }).success).toBe(false);
  });
});
