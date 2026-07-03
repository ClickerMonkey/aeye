/**
 * Cross-source SEMANTIC PAIRING — the `{ source, field }` / `{ type, field }`
 * query forms that score one bound source's row against ANOTHER bound source's
 * embedding, so a query can pair two Types and take the top-N by similarity.
 *
 * Covers, across BOTH dialects + the in-memory runtime:
 *  - EXACT pairing SQL over both bound sides' vectors (a hidden `vectorField`
 *    side + a default `embedding` side), postgres cosine + base degrade;
 *  - a full `FROM … JOIN … ORDER BY score DESC LIMIT 10` query (exact SQL);
 *  - a self-pairing case with two aliases of ONE Type (exact SQL);
 *  - runtime cosine over two bound rows (join), ordered top-N;
 *  - the `sourceField` / `typeField` runtime resolution (row alias / by-Type),
 *    the `vector` producer / `vectorField` / embed-the-text side paths, and the
 *    0-score guards (absent source, empty text, no embedder);
 *  - the unbound / ambiguous / unknown-field / not-semantic Problems;
 *  - the `e.semantic({ source, field })` builder + toJSON / clone round-trip;
 *  - the LLM schema accepting the bound-source query form.
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { Embedder } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { RuntimeContext } from '../runtime/context';
import { SqlContext } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import { SemanticExpr } from '../exprs/semantic';
import { e } from '../builder';
import { buildSchemas } from '../llm/schemas';
import type { QueryScope } from '../scope';
import type { Dialect } from '../sql/dialect';
import type { TypeDef, SelectDef, ExprDef, TypeBacking } from '../schema';
import type { SourceRecord } from '../runtime/row';
import type { Problems } from '../problem';

// ─── A deterministic stub embedder ─────────────────────────────────────────────
const stubEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    if (text === 'ai') return [1, 0, 0];
    if (text === 'db') return [0, 1, 0];
    if (text.length === 0) return [0, 0, 0];
    return [0, 0, 1];
  },
};
// A per-field embedder override (distinct output) for the `embedder` path.
const overrideEmbedder: Embedder = { async embed(): Promise<number[]> { return [2, 2, 2]; } };

// ─── Types ─────────────────────────────────────────────────────────────────────

/** `paper` — semantic (title + a relation), backed by a hidden `emb` pgvector. */
const paperDef: TypeDef = {
  name: 'paper',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text', semantic: true } },
    { name: 'topicId', type: { kind: 'relation', to: 'topic', count: 1, inverseRelation: 'papers' } },
  ],
  count: 100,
  bytes: 64,
};
/** `topic` — semantic (`label`), NO backing ⇒ the default `embedding` fragment. */
const topicDef: TypeDef = {
  name: 'topic',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'label', type: { kind: 'text', semantic: true } },
  ],
  count: 50,
  bytes: 32,
};
/** `doc` — semantic (`body`), NO backing ⇒ used for the two-alias self-pairing. */
const docDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'body', type: { kind: 'text', semantic: true } },
  ],
  count: 10,
  bytes: 32,
};
/** `prod` — semantic, backed by a runtime `vector` PRODUCER. */
const prodDef: TypeDef = {
  name: 'prod',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'body', type: { kind: 'text', semantic: true } },
  ],
  count: 10,
  bytes: 32,
};
/** `embType` — semantic, with a FIELD-level query `embedder` override on `body`. */
const embTypeDef: TypeDef = {
  name: 'embType',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'body', type: { kind: 'text', semantic: true } },
  ],
  count: 10,
  bytes: 32,
};
/** `plain` — semantic (`body`), NO backing ⇒ embed-the-text side. */
const plainDef: TypeDef = {
  name: 'plain',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'body', type: { kind: 'text', semantic: true } },
  ],
  count: 10,
  bytes: 32,
};

const paperBacking: TypeBacking = { semantic: { vectorField: 'emb' } };
const prodBacking: TypeBacking = { semantic: { vector: () => [0, 1, 0] } };
const embBacking: TypeBacking = { fields: { body: { semantic: { embedder: overrideEmbedder } } } };

interface Fx {
  engine: QueryEngine;
  registry: ReturnType<typeof createRegistry>;
}

function makeFx(opts?: { embedder?: Embedder; rows?: boolean }): Fx {
  const registry = createRegistry();
  registry.registerType(registry.parseType(paperDef), paperBacking);
  registry.registerType(registry.parseType(topicDef));
  registry.registerType(registry.parseType(docDef));
  registry.registerType(registry.parseType(prodDef), prodBacking);
  registry.registerType(registry.parseType(embTypeDef), embBacking);
  registry.registerType(registry.parseType(plainDef));
  registry.finalize();
  const engine = new QueryEngine(registry, {
    embedder: opts?.embedder,
    executors: opts?.rows
      ? {
          paper: arrayExecutor([
            { id: 1, title: 'a', topicId: 1, emb: [1, 0, 0] },
            { id: 2, title: 'b', topicId: 2, emb: [1, 1, 0] },
          ] as SourceRecord[]),
          topic: arrayExecutor([
            { id: 1, label: 'ai' },
            { id: 2, label: 'db' },
          ] as SourceRecord[]),
        }
      : {},
  });
  return { engine, registry };
}

function codes(p: Problems): string[] {
  return p.list.map((x) => x.code);
}

/** A SqlContext over a caller-populated scope (for direct `expr.toSQL`). */
function ctxFor(fx: Fx, dialectName: string, scope: QueryScope): { dialect: Dialect; ctx: SqlContext } {
  const dialect = fx.registry.dialect(dialectName);
  if (!dialect) throw new Error(`dialect ${dialectName} missing`);
  const planner = new JoinCtePlanner(dialect, fx.engine, undefined);
  return { dialect, ctx: new SqlContext(dialect, fx.engine, scope, planner, undefined) };
}

// ════════════════════════════════════════════════════════════════════════════
// EXACT pairing SQL — both bound sides' vectors
// ════════════════════════════════════════════════════════════════════════════

describe('semantic pairing: exact SQL', () => {
  const fx = makeFx();

  it('pairs a hidden-vectorField side against a default-embedding side (pg + base)', () => {
    const scope = fx.engine.globalScope();
    scope.bind('paper', { kind: 'type', type: fx.engine.type('paper')!, source: 'paper', synthetic: false });
    scope.bind('topic', { kind: 'type', type: fx.engine.type('topic')!, source: 'topic', synthetic: false });
    const expr = new SemanticExpr('paper', undefined, { kind: 'sourceField', source: 'topic', field: 'label' });

    const pg = ctxFor(fx, 'postgres', scope);
    expect(expr.toSQL(pg.dialect, pg.ctx).render(pg.dialect).sql).toBe(
      '(1 - ("paper"."emb" <=> "topic"."embedding"))',
    );
    const base = ctxFor(fx, 'base', scope);
    // Base has no vector support ⇒ degrades to the constant 0.
    expect(expr.toSQL(base.dialect, base.ctx).render(base.dialect).sql).toBe('0');
  });

  it('self-pairing: two aliases of ONE Type (exact pg SQL over both aliases)', () => {
    const scope = fx.engine.globalScope();
    scope.bind('a', { kind: 'type', type: fx.engine.type('doc')!, source: 'a', synthetic: false });
    scope.bind('b', { kind: 'type', type: fx.engine.type('doc')!, source: 'b', synthetic: false });
    const expr = new SemanticExpr('a', undefined, { kind: 'sourceField', source: 'b', field: 'body' });
    const pg = ctxFor(fx, 'postgres', scope);
    expect(expr.toSQL(pg.dialect, pg.ctx).render(pg.dialect).sql).toBe(
      '(1 - ("a"."embedding" <=> "b"."embedding"))',
    );
  });

  it('a `{ type }` pairing resolves to the single bound source (matches[0])', () => {
    const scope = fx.engine.globalScope();
    scope.bind('paper', { kind: 'type', type: fx.engine.type('paper')!, source: 'paper', synthetic: false });
    scope.bind('topic', { kind: 'type', type: fx.engine.type('topic')!, source: 'topic', synthetic: false });
    const expr = new SemanticExpr('paper', undefined, { kind: 'typeField', type: 'topic', field: 'label' });
    const pg = ctxFor(fx, 'postgres', scope);
    expect(expr.toSQL(pg.dialect, pg.ctx).render(pg.dialect).sql).toBe(
      '(1 - ("paper"."emb" <=> "topic"."embedding"))',
    );
  });

  it('a `{ type }` pairing with NO bound source falls back to the Type name as alias', () => {
    const scope = fx.engine.globalScope();
    scope.bind('paper', { kind: 'type', type: fx.engine.type('paper')!, source: 'paper', synthetic: false });
    const expr = new SemanticExpr('paper', undefined, { kind: 'typeField', type: 'ghostType', field: 'x' });
    const pg = ctxFor(fx, 'postgres', scope);
    // No bound source for `ghostType` ⇒ the Type name is used as the alias, and
    // (unbacked ⇒) the default `embedding` fragment.
    expect(expr.toSQL(pg.dialect, pg.ctx).render(pg.dialect).sql).toBe(
      '(1 - ("paper"."emb" <=> "ghostType"."embedding"))',
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Full pairing query — FROM … JOIN … ORDER BY score DESC LIMIT 10
// ════════════════════════════════════════════════════════════════════════════

/** A pairing SELECT: score each paper against its joined topic, top-10 desc. */
const pairingSelect: SelectDef = {
  kind: 'select',
  fields: [
    { expr: { kind: 'field-ref', source: 'paper', field: 'id' }, as: 'id' },
    { expr: { kind: 'semantic', source: 'paper', query: { source: 'topic', field: 'label' } }, as: 'score' },
  ],
  from: { kind: 'type', type: 'paper' },
  joins: [{ on: { source: 'paper', field: 'topicId' }, as: 'topic', joinType: 'inner' }],
  order: [{ expr: { kind: 'output', name: 'score' }, dir: 'desc' }],
  limit: 10,
};

describe('semantic pairing: full query', () => {
  it('emits the exact SQL (postgres + base): similarity over both aliases, ORDER BY DESC LIMIT 10', () => {
    const fx = makeFx();
    expect(fx.engine.validateQuery(pairingSelect).list.filter((p) => p.severity === 'error')).toEqual([]);
    expect(fx.engine.toSQL(pairingSelect, 'postgres').sql).toBe(
      'SELECT "paper"."id" AS "id", (1 - ("paper"."emb" <=> "topic"."embedding")) AS "score" ' +
        'FROM "paper" AS "paper" INNER JOIN "topic" AS "topic" ON "paper"."topicId" = "topic"."id" ' +
        'ORDER BY (1 - ("paper"."emb" <=> "topic"."embedding")) DESC LIMIT 10',
    );
    expect(fx.engine.toSQL(pairingSelect, 'base').sql).toBe(
      'SELECT "paper"."id" AS "id", 0 AS "score" ' +
        'FROM "paper" AS "paper" INNER JOIN "topic" AS "topic" ON "paper"."topicId" = "topic"."id" ' +
        'ORDER BY 0 DESC LIMIT 10',
    );
  });

  it('runs: cosine over the two bound rows, ordered top-N', async () => {
    const fx = makeFx({ embedder: stubEmbedder, rows: true });
    const res = await fx.engine.run(pairingSelect);
    // paper1.emb [1,0,0] vs topic 'ai' [1,0,0] ⇒ 1; paper2.emb [1,1,0] vs 'db' [0,1,0] ⇒ ~0.707.
    expect(res.rows.map((r) => r['id'])).toEqual([1, 2]);
    expect(res.rows[0]!['score']).toBeCloseTo(1, 6);
    expect(res.rows[1]!['score']).toBeCloseTo(0.7071067811865475, 6);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime side-vector paths + 0-score guards
// ════════════════════════════════════════════════════════════════════════════

describe('semantic pairing: runtime side vectors', () => {
  it('typeField resolves the alias by Type (engine.type), pairing a vector-producer side', async () => {
    const fx = makeFx({ embedder: stubEmbedder });
    const ctx = new RuntimeContext(fx.engine, { embedder: stubEmbedder });
    // Scored `prod` uses its `vector` producer [0,1,0]; the query `prod` (via a
    // second bound alias impossible here) — instead score `paper` vs `prod` by Type.
    const expr = new SemanticExpr('paper', undefined, { kind: 'typeField', type: 'prod', field: 'body' });
    const row = { paper: { id: 1, emb: [0, 1, 0] }, prod: { id: 9, body: 'x' } };
    // query side `prod` ⇒ vector producer [0,1,0]; scored `paper` ⇒ emb [0,1,0] ⇒ cosine 1.
    expect((await expr.evaluate(ctx, row)).raw).toBeCloseTo(1, 6);
  });

  it('field-level query `embedder` override supplies the paired vector', async () => {
    const fx = makeFx({ embedder: stubEmbedder });
    const ctx = new RuntimeContext(fx.engine, { embedder: stubEmbedder });
    // query side embType.body uses the override embedder ⇒ [2,2,2]; scored plain
    // 'body' text embeds to [0,0,1] (non-empty non-ai/db) ⇒ cosine of [2,2,2]·[0,0,1].
    const expr = new SemanticExpr('plain', undefined, { kind: 'sourceField', source: 'embType', field: 'body' });
    const row = { plain: { id: 1, body: 'zzz' }, embType: { id: 2, body: 'anything' } };
    const v = (await expr.evaluate(ctx, row)).raw;
    // [0,0,1] vs [2,2,2] ⇒ 2 / (1 * sqrt(12)) ≈ 0.5773.
    expect(typeof v).toBe('number');
    expect(v).toBeCloseTo(2 / Math.sqrt(12), 6);
  });

  it('embeds each side\'s text: whole-record (scored, no field) vs the named query field', async () => {
    const fx = makeFx({ embedder: stubEmbedder });
    const ctx = new RuntimeContext(fx.engine, { embedder: stubEmbedder });
    // scored plainA whole-record text 'ai' ⇒ [1,0,0]; query plainB.body 'ai' ⇒ [1,0,0] ⇒ 1.
    const expr = new SemanticExpr('plainA', undefined, { kind: 'sourceField', source: 'plainB', field: 'body' });
    const row = { plainA: { ai: 'ai' }, plainB: { body: 'ai' } };
    // Neither alias is a registered Type ⇒ default embed-the-text path both sides.
    expect((await expr.evaluate(ctx, row)).raw).toBeCloseTo(1, 6);
  });

  it('scores 0 when the paired source is absent from the row', async () => {
    const fx = makeFx({ embedder: stubEmbedder });
    const ctx = new RuntimeContext(fx.engine, { embedder: stubEmbedder });
    const expr = new SemanticExpr('plainA', undefined, { kind: 'sourceField', source: 'gone', field: 'body' });
    expect((await expr.evaluate(ctx, { plainA: { body: 'ai' } })).raw).toBe(0);
  });

  it('scores 0 when the SCORED source is absent (query side present)', async () => {
    const fx = makeFx({ embedder: stubEmbedder });
    const ctx = new RuntimeContext(fx.engine, { embedder: stubEmbedder });
    const expr = new SemanticExpr('missing', undefined, { kind: 'sourceField', source: 'plainB', field: 'body' });
    expect((await expr.evaluate(ctx, { plainB: { body: 'ai' } })).raw).toBe(0);
  });

  it('scores 0 for empty query text and 0 with no embedder', async () => {
    const fx = makeFx({ embedder: stubEmbedder });
    // An ABSENT query field (nullish ⇒ '') ⇒ empty text ⇒ null vector ⇒ 0.
    const ctxEmb = new RuntimeContext(fx.engine, { embedder: stubEmbedder });
    const empty = new SemanticExpr('plainA', undefined, { kind: 'sourceField', source: 'plainB', field: 'body' });
    expect((await empty.evaluate(ctxEmb, { plainA: { body: 'ai' }, plainB: {} })).raw).toBe(0);
    // No embedder at all (engine + ctx) ⇒ a default (embed-the-text) side yields null ⇒ 0.
    const fxNoEmb = makeFx();
    const ctxNone = new RuntimeContext(fxNoEmb.engine);
    const noEmb = new SemanticExpr('plainA', undefined, { kind: 'sourceField', source: 'plainB', field: 'body' });
    expect((await noEmb.evaluate(ctxNone, { plainA: { body: 'ai' }, plainB: { body: 'ai' } })).raw).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Validation — unbound / ambiguous / unknown-field / not-semantic
// ════════════════════════════════════════════════════════════════════════════

describe('semantic pairing: validation', () => {
  const fx = makeFx();

  /** A scope binding `paper` + two aliases of `topic` (the ambiguity source). */
  function scopeWithTwoTopics(): QueryScope {
    const scope = fx.engine.globalScope();
    scope.bind('paper', { kind: 'type', type: fx.engine.type('paper')!, source: 'paper', synthetic: false });
    scope.bind('t1', { kind: 'type', type: fx.engine.type('topic')!, source: 't1', synthetic: false });
    scope.bind('t2', { kind: 'type', type: fx.engine.type('topic')!, source: 't2', synthetic: false });
    return scope;
  }

  it('a `{ type }` bound more than once ⇒ semantic.query-ambiguous', () => {
    const def: ExprDef = { kind: 'semantic', source: 'paper', query: { type: 'topic', field: 'label' } };
    expect(codes(fx.engine.validateExpr(def, scopeWithTwoTopics()))).toContain('semantic.query-ambiguous');
  });

  it('a valid pairing over a joined source ⇒ no semantic Problem', () => {
    const problems = fx.engine.validateQuery(pairingSelect);
    expect(codes(problems).filter((c) => c.startsWith('semantic.'))).toEqual([]);
  });

  it('sourcesForType: a child binding SHADOWS a same-named ancestor (reported once)', () => {
    const parent = fx.engine.globalScope();
    parent.bind('x', { kind: 'type', type: fx.engine.type('topic')!, source: 'x', synthetic: false });
    const child = parent.child();
    child.bind('x', { kind: 'type', type: fx.engine.type('topic')!, source: 'x', synthetic: false });
    // The parent's `x` is skipped (already seen) ⇒ exactly one match, no ambiguity.
    const matches = child.sourcesForType('topic');
    expect(matches.map((m) => m.source)).toEqual(['x']);
  });

  it('unknown query field ⇒ semantic.unknown-query-field', () => {
    const scope = fx.engine.globalScope();
    scope.bind('paper', { kind: 'type', type: fx.engine.type('paper')!, source: 'paper', synthetic: false });
    scope.bind('topic', { kind: 'type', type: fx.engine.type('topic')!, source: 'topic', synthetic: false });
    const def: ExprDef = { kind: 'semantic', source: 'paper', query: { source: 'topic', field: 'nope' } };
    expect(codes(fx.engine.validateExpr(def, scope))).toContain('semantic.unknown-query-field');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Builder + JSON round-trip + LLM schema
// ════════════════════════════════════════════════════════════════════════════

describe('semantic pairing: builder / JSON / schema', () => {
  const fx = makeFx();

  it('e.semantic accepts a { source, field } pairing and round-trips through JSON', () => {
    const expr = e.semantic('paper', { source: 'topic', field: 'label' });
    expect(expr.toJSON()).toEqual({ kind: 'semantic', source: 'paper', query: { source: 'topic', field: 'label' } });
    expect(expr.clone().toJSON()).toEqual(expr.toJSON());
    expect(expr.toCode()).toBe('semantic(paper, topic.label)');
    // The `{ type, field }` form still builds a typeField query.
    const tf = e.semantic('paper', { type: 'topic', field: 'label' });
    expect(tf.toJSON()).toEqual({ kind: 'semantic', source: 'paper', query: { type: 'topic', field: 'label' } });
  });

  it('parse round-trips a sourceField query def', () => {
    const def: ExprDef = { kind: 'semantic', source: 'paper', field: 'title', query: { source: 'topic', field: 'label' } };
    const parsed = fx.engine.parse(def);
    expect(parsed.toJSON()).toEqual(def);
    expect(parsed.clone().toJSON()).toEqual(def);
  });

  it('the LLM Expr schema accepts a bound-source semantic query', () => {
    const schemas = buildSchemas(fx.engine, { depth: 'open' });
    const ok = schemas.Expr.safeParse({
      kind: 'semantic',
      source: 'paper',
      query: { source: 'topic', field: 'label' },
    });
    expect(ok.success).toBe(true);
  });
});
