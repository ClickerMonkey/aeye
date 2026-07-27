/**
 * Search + semantic BACKING — the dev-side layer that says HOW a `search` /
 * `semantic` Type/field is searched, most importantly by pointing at a HIDDEN
 * physical field (a precomputed `tsvector` / `pgvector`) the conceptual `TypeDef`
 * never exposes.
 *
 * Covers, across BOTH dialects and the in-memory runtime:
 *  - a whole-type `TypeBacking.search` / `.semantic` via a hidden `vectorField`;
 *  - a FIELD-level override winning over the type-level backing;
 *  - the `sql` / `run` / `vector` overrides;
 *  - the `default` fall-through (empty backing ⇒ today's behavior);
 *  - alias-correctness (an `{kind:'aliased'}` source references the bound alias
 *    while the backing is still found by Type name);
 *  - base-dialect graceful degrade (LIKE / constant-0) without throwing;
 *  - the `readFieldText` / `readFieldVector` edge branches (direct resolver calls).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { Embedder } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { SqlText } from '../sql/emit';
import {
  resolveSearchRun,
  resolveSemanticRun,
  type TypeBacking,
} from '../backing';
import { RuntimeContext } from '../runtime/context';
import { SqlContext } from '../sql/emit';
import { JoinCtePlanner } from '../sql/planner';
import { SemanticExpr } from '../exprs/semantic';
import { lit } from './_utils';
import type { TypeDef, SelectDef, ExprDef } from '../schema';
import type { SourceRecord } from '../runtime/row';

// ─── A deterministic stub embedder ────────────────────────────────────────────
// 'cat' embeds to [1,2,3]; everything else to [0,0,1] (orthogonal ⇒ cosine 0).
const stubEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    return text === 'cat' ? [1, 2, 3] : [0, 0, 1];
  },
};

// A second embedder used only via a field-level `SemanticBacking.embedder`.
const overrideEmbedder: Embedder = {
  async embed(): Promise<number[]> {
    return [9, 9, 9];
  },
};

// A deterministic text→vector-text converter (the INTERNAL SQL-side semantic
// seam a `SqlContext` is constructed with directly): 'cat' ⇒ '[1,2,3]', else
// '[0,0,1]'.
const stubConvert = (text: string): string => (text === 'cat' ? '[1,2,3]' : '[0,0,1]');

// The PUBLIC precomputed embeddings cache (`toSQL({ embeddings })`): 'cat' ⇒
// [1,2,3], so a `semantic(...)` TEXT term resolves to a pgvector literal instead
// of throwing.
const stubEmbeddings = new Map<string, readonly number[]>([['cat', [1, 2, 3]]]);

/** The conceptual `doc` Type — plain, LLM-facing; nothing hints at hidden fields. */
const docTypeDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    // The whole-type search/semantic driver (type-level backing applies).
    { name: 'body', type: { kind: 'text', search: true, semantic: true } },
    // Field-level vectorField override.
    { name: 'title', type: { kind: 'text', search: true, semantic: true } },
    // Field-level sql/run override.
    { name: 'ovr', type: { kind: 'text', search: true, semantic: true } },
    // Field-level `vector` producer (semantic) / empty search backing (default).
    { name: 'prov', type: { kind: 'text', search: true, semantic: true } },
    // Field-level `vector` producer that yields null.
    { name: 'provNull', type: { kind: 'text', semantic: true } },
    // Empty field backing ⇒ default fall-through in both modes.
    { name: 'deflt', type: { kind: 'text', search: true, semantic: true } },
  ],
  count: 100,
  bytes: 64,
};

/** A plain type with NO backing ⇒ unchanged default behavior. */
const noteTypeDef: TypeDef = {
  name: 'note',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'text', type: { kind: 'text', search: true, semantic: true } },
  ],
  count: 10,
  bytes: 32,
};

/** The `doc` backing: hidden tsvector/pgvector fields + per-field overrides. */
const docBacking: TypeBacking = {
  // WHOLE-TYPE search/semantic via hidden precomputed fields.
  search: { vectorField: 'search_tsv', language: 'english' },
  semantic: { vectorField: 'embedding' },
  fields: {
    // Field-level vectorField override (wins over the type-level backing).
    title: { search: { vectorField: 'title_tsv' }, semantic: { vectorField: 'title_vec' } },
    // Field-level full overrides (sql + run).
    ovr: {
      search: {
        sql: (alias) => SqlText.raw(`${alias}_search_override`),
        run: () => true,
      },
      semantic: {
        sql: (alias) => SqlText.raw(`${alias}_semantic_override`),
        run: () => 0.75,
        embedder: overrideEmbedder,
      },
    },
    // Field-level `vector` producer (semantic); empty search backing (default).
    prov: {
      search: {},
      semantic: { vector: () => [1, 2, 3] },
    },
    // Field-level `vector` producer that yields null ⇒ a score of 0.
    provNull: { semantic: { vector: () => null } },
    // Empty backings ⇒ default fall-through.
    deflt: { search: {}, semantic: {} },
  },
};

const docRows: SourceRecord[] = [
  {
    id: 1,
    body: 'hello',
    title: 'sparkle',
    ovr: 'x',
    prov: 'y',
    deflt: 'cat',
    // Hidden physical fields (not in the TypeDef):
    search_tsv: 'hello sparkle world',
    title_tsv: 'sparkle',
    embedding: [1, 2, 3],
    title_vec: [1, 2, 3],
  },
];

const noteRows: SourceRecord[] = [{ id: 1, text: 'cat' }];

/** Build a registry + engine over `doc` (backed) and `note` (unbacked). */
function makeEngine(opts?: { embedder?: Embedder }): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(docTypeDef), docBacking);
  registry.registerType(registry.parseType(noteTypeDef));
  registry.finalize();
  return new QueryEngine(registry, {
    embedder: opts?.embedder,
    executors: { doc: arrayExecutor(docRows), note: arrayExecutor(noteRows) },
  });
}

/** SELECT one predicate over `doc` (projecting id). */
function docWhere(where: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: { kind: 'field-ref', source: 'doc', field: 'id' }, as: 'id' }],
    from: { kind: 'type', type: 'doc' },
    where: [where],
  };
}

/** SELECT one value expr over `doc` as `s`. */
function docValue(expr: ExprDef): SelectDef {
  return { kind: 'select', fields: [{ expr, as: 's' }], from: { kind: 'type', type: 'doc' } };
}

// ════════════════════════════════════════════════════════════════════════════
// engine.searchBacking / semanticBacking lookups
// ════════════════════════════════════════════════════════════════════════════

describe('engine.searchBacking / semanticBacking', () => {
  const engine = makeEngine();

  it('whole-type lookup returns the type-level backing', () => {
    expect(engine.searchBacking('doc')?.vectorField).toBe('search_tsv');
    expect(engine.semanticBacking('doc')?.vectorField).toBe('embedding');
  });

  it('a field with its own backing overrides the type-level one', () => {
    expect(engine.searchBacking('doc', 'title')?.vectorField).toBe('title_tsv');
    expect(engine.semanticBacking('doc', 'title')?.vectorField).toBe('title_vec');
  });

  it('a field WITHOUT its own backing falls back to the type-level backing', () => {
    expect(engine.searchBacking('doc', 'body')?.vectorField).toBe('search_tsv');
    expect(engine.semanticBacking('doc', 'body')?.vectorField).toBe('embedding');
  });

  it('a Type with no backing returns undefined', () => {
    expect(engine.searchBacking('note')).toBeUndefined();
    expect(engine.semanticBacking('note', 'text')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SQL emission — postgres (hidden fields) + base (degrade)
// ════════════════════════════════════════════════════════════════════════════

describe('search/semantic backing: SQL emission', () => {
  const engine = makeEngine();

  it('postgres: whole-type text-search emits the hidden tsvector predicate', () => {
    const { sql } = engine.toSQL(docWhere({ kind: 'text-search', source: 'doc', query: 'cat' }), 'postgres');
    expect(sql).toContain(`"doc"."search_tsv" @@ plainto_tsquery('english', $1)`);
  });

  it('postgres: field-level text-search override wins (title_tsv, not search_tsv)', () => {
    const { sql } = engine.toSQL(
      docWhere({ kind: 'text-search', source: 'doc', field: 'title', query: 'cat' }),
      'postgres',
    );
    expect(sql).toContain(`"doc"."title_tsv" @@ plainto_tsquery('english', $1)`);
    expect(sql).not.toContain('search_tsv');
  });

  it('postgres: a field WITHOUT its own backing uses the type-level tsvector', () => {
    const { sql } = engine.toSQL(
      docWhere({ kind: 'text-search', source: 'doc', field: 'body', query: 'cat' }),
      'postgres',
    );
    expect(sql).toContain(`"doc"."search_tsv" @@ plainto_tsquery('english', $1)`);
  });

  it('postgres: whole-type semantic emits similarity over the hidden vector, param cast ::vector', () => {
    // The TEXT term 'cat' embeds to '[1,2,3]' via the converter; the dialect casts
    // the bound vector-text param `::vector`.
    const { sql, params } = engine.toSQL(docValue({ kind: 'semantic', source: 'doc', query: 'cat' }), 'postgres', {
      embeddings: stubEmbeddings,
    });
    expect(sql).toContain(`(1 - ("doc"."embedding" <=> $1::vector))`);
    expect(params).toEqual(['[1,2,3]']);
  });

  it('postgres: field-level semantic override wins (title_vec)', () => {
    const { sql, params } = engine.toSQL(
      docValue({ kind: 'semantic', source: 'doc', field: 'title', query: 'cat' }),
      'postgres',
      { embeddings: stubEmbeddings },
    );
    expect(sql).toContain(`"doc"."title_vec" <=> $1::vector`);
    expect(params).toEqual(['[1,2,3]']);
  });

  it('postgres: a full sql override is emitted verbatim (search + semantic)', () => {
    const search = engine.toSQL(
      docWhere({ kind: 'text-search', source: 'doc', field: 'ovr', query: 'cat' }),
      'postgres',
    ).sql;
    expect(search).toContain('doc_search_override');
    const semantic = engine.toSQL(
      docValue({ kind: 'semantic', source: 'doc', field: 'ovr', query: 'cat' }),
      'postgres',
      { embeddings: stubEmbeddings },
    ).sql;
    expect(semantic).toContain('doc_semantic_override');
  });

  it('postgres: an EMPTY backing falls through to the default form', () => {
    // deflt search ⇒ default tsvector over the field; deflt semantic ⇒ default embedding col.
    const search = engine.toSQL(
      docWhere({ kind: 'text-search', source: 'doc', field: 'deflt', query: 'cat' }),
      'postgres',
    ).sql;
    expect(search).toContain('to_tsvector("doc"."deflt")');
    const semantic = engine.toSQL(
      docValue({ kind: 'semantic', source: 'doc', field: 'deflt', query: 'cat' }),
      'postgres',
      { embeddings: stubEmbeddings },
    ).sql;
    expect(semantic).toContain(`"doc"."embedding" <=> $1`);
    expect(semantic).not.toContain('::vector');
  });

  it('alias-correct: an {aliased} source references the bound alias (backing found by Type)', () => {
    const aliased: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'd', field: 'id' }, as: 'id' }],
      from: { kind: 'aliased', type: 'doc', as: 'd' },
      where: [{ kind: 'text-search', source: 'd', query: 'cat' }],
    };
    const { sql } = engine.toSQL(aliased, 'postgres');
    expect(sql).toContain(`"d"."search_tsv" @@ plainto_tsquery('english', $1)`);
    expect(sql).not.toContain('"doc"."search_tsv"');

    const aliasedSem: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'semantic', source: 'd', query: 'cat' }, as: 's' }],
      from: { kind: 'aliased', type: 'doc', as: 'd' },
    };
    expect(engine.toSQL(aliasedSem, 'postgres', { embeddings: stubEmbeddings }).sql).toContain(
      `"d"."embedding" <=> $1::vector`,
    );
  });

  it('base dialect DEGRADES (LIKE / constant-0) without throwing', () => {
    const search = engine.toSQL(docWhere({ kind: 'text-search', source: 'doc', query: 'cat' }), 'base').sql;
    expect(search).toContain(`LOWER("doc"."search_tsv") LIKE ('%' || LOWER(?) || '%')`);
    const semantic = engine.toSQL(docValue({ kind: 'semantic', source: 'doc', query: 'cat' }), 'base', {
      embeddings: stubEmbeddings,
    }).sql;
    // The base similarity degrades to constant 0.
    expect(semantic).toContain('0 AS "s"');
  });

  it('an unbacked Type keeps the default SQL forms', () => {
    const noteWhere: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'note' },
      where: [{ kind: 'text-search', source: 'note', query: 'cat' }],
    };
    const { sql } = engine.toSQL(noteWhere, 'postgres');
    expect(sql).toContain('to_tsvector("note"."text")');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime — the run / vector / vectorField paths
// ════════════════════════════════════════════════════════════════════════════

describe('search/semantic backing: runtime', () => {
  it('search via hidden vectorField token-matches its stored text', async () => {
    const engine = makeEngine();
    // 'sparkle' is in search_tsv ('hello sparkle world') ⇒ match; 'absent' ⇒ no match.
    const hit = await engine.run(docWhere({ kind: 'text-search', source: 'doc', query: 'sparkle' }));
    expect(hit.rows.map((r) => r['id'])).toEqual([1]);
    const miss = await engine.run(docWhere({ kind: 'text-search', source: 'doc', query: 'absent' }));
    expect(miss.rows.length).toBe(0);
  });

  it('search via a run override always matches', async () => {
    const engine = makeEngine();
    const hit = await engine.run(docWhere({ kind: 'text-search', source: 'doc', field: 'ovr', query: 'nope' }));
    expect(hit.rows.map((r) => r['id'])).toEqual([1]);
  });

  it('search with an EMPTY backing falls through to the default token match', async () => {
    const engine = makeEngine();
    // deflt field value is 'cat' ⇒ default field token match on 'cat'.
    const hit = await engine.run(docWhere({ kind: 'text-search', source: 'doc', field: 'deflt', query: 'cat' }));
    expect(hit.rows.map((r) => r['id'])).toEqual([1]);
  });

  it('semantic via hidden vectorField cosine-compares the stored embedding', async () => {
    const engine = makeEngine({ embedder: stubEmbedder });
    // query 'cat' ⇒ [1,2,3]; row embedding [1,2,3] ⇒ cosine ≈ 1.
    const res = await engine.run(docValue({ kind: 'semantic', source: 'doc', query: 'cat' }));
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('semantic via a run override returns the score directly', async () => {
    // No engine embedder: the field-level `embedder` override embeds the query.
    const engine = makeEngine();
    const res = await engine.run(docValue({ kind: 'semantic', source: 'doc', field: 'ovr', query: 'cat' }));
    expect(res.rows[0]!['s']).toBeCloseTo(0.75, 6);
  });

  it('semantic via a `vector` producer cosine-compares the produced vector', async () => {
    const engine = makeEngine({ embedder: stubEmbedder });
    // prov.vector ⇒ [1,2,3]; query 'cat' ⇒ [1,2,3] ⇒ cosine ≈ 1.
    const res = await engine.run(docValue({ kind: 'semantic', source: 'doc', field: 'prov', query: 'cat' }));
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('semantic field override wins over the type-level backing (title_vec path)', async () => {
    const engine = makeEngine({ embedder: stubEmbedder });
    // title_vec [1,2,3] vs query 'cat' [1,2,3] ⇒ cosine ≈ 1.
    const res = await engine.run(docValue({ kind: 'semantic', source: 'doc', field: 'title', query: 'cat' }));
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('semantic with an EMPTY backing falls through to embed-the-text (default)', async () => {
    const engine = makeEngine({ embedder: stubEmbedder });
    // deflt semantic {} ⇒ default: embed the row text; a numeric score results.
    const res = await engine.run(docValue({ kind: 'semantic', source: 'doc', field: 'deflt', query: 'cat' }));
    expect(typeof res.rows[0]!['s']).toBe('number');
  });

  it('semantic with a `vector` producer that yields null scores 0', async () => {
    const engine = makeEngine({ embedder: stubEmbedder });
    const res = await engine.run(docValue({ kind: 'semantic', source: 'doc', field: 'provNull', query: 'cat' }));
    expect(res.rows[0]!['s']).toBe(0);
  });

  it('evaluate over an UNBOUND source (no Type) uses the default path', async () => {
    const engine = makeEngine({ embedder: stubEmbedder });
    // 'ghost' resolves to no Type ⇒ no backing ⇒ default embed-the-text path.
    const expr = new SemanticExpr('ghost', undefined, { kind: 'text', text: 'cat' });
    const v = await expr.evaluate(new RuntimeContext(engine, { embedder: stubEmbedder }), { ghost: { id: 1, body: 'cat' } });
    expect(typeof v.raw).toBe('number');
  });

  it('an unbacked Type keeps default runtime behavior', async () => {
    const engine = makeEngine({ embedder: stubEmbedder });
    const noteWhere: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'note', field: 'id' }, as: 'id' }],
      from: { kind: 'type', type: 'note' },
      where: [{ kind: 'text-search', source: 'note', query: 'cat' }],
    };
    const res = await engine.run(noteWhere);
    expect(res.rows.map((r) => r['id'])).toEqual([1]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// semantic.toSQL over unbound / non-type sources (no backing ⇒ default form)
// ════════════════════════════════════════════════════════════════════════════

describe('semantic.toSQL: unbound / non-type sources emit the default form', () => {
  const engine = makeEngine();
  const pg = engine.registry.dialect('postgres')!;

  /**
   * A postgres SqlContext whose scope binds a non-type `c` (leaving others
   * unbound). The trailing positional arg is the `semanticText` converter so a
   * `semantic(...)` text term embeds rather than throwing.
   */
  function ctx(): SqlContext {
    const scope = engine.globalScope();
    scope.bind('c', engine.resolveExpr(lit(1), scope));
    const planner = new JoinCtePlanner(pg, engine, undefined);
    return new SqlContext(pg, engine, scope, planner, undefined, false, {}, {}, false, false, [], stubConvert);
  }

  it('an UNBOUND source falls through (no backing) to the default embedding column', () => {
    const expr = new SemanticExpr('ghost', undefined, { kind: 'text', text: 'x' });
    expect(expr.toSQL(pg, ctx()).render(pg).sql).toContain('"ghost"."embedding" <=> $1');
  });

  it('a NON-TYPE binding falls through (no backing) to the default embedding column', () => {
    const expr = new SemanticExpr('c', undefined, { kind: 'text', text: 'x' });
    expect(expr.toSQL(pg, ctx()).render(pg).sql).toContain('"c"."embedding" <=> $1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Direct resolver calls — readFieldText / readFieldVector edge branches
// ════════════════════════════════════════════════════════════════════════════

describe('resolveSearchRun / resolveSemanticRun edge branches', () => {
  const engine = makeEngine();
  const ctx = new RuntimeContext(engine);

  it('resolveSearchRun: run override, string / array / non-string / missing field text, default', async () => {
    const run = await resolveSearchRun({ run: () => false }, 'd', {}, 'q', ctx);
    expect(run).toEqual({ kind: 'match', matched: false });

    const str = await resolveSearchRun({ vectorField: 'tsv' }, 'd', { d: { tsv: 'hi there' } }, 'q', ctx);
    expect(str).toEqual({ kind: 'text', text: 'hi there' });

    // Array cell ⇒ only the string elements are joined.
    const arr = await resolveSearchRun({ vectorField: 'tsv' }, 'd', { d: { tsv: ['a', 3, 'b'] } }, 'q', ctx);
    expect(arr).toEqual({ kind: 'text', text: 'a b' });

    // Non-string / non-array cell ⇒ empty text.
    const num = await resolveSearchRun({ vectorField: 'tsv' }, 'd', { d: { tsv: 42 } }, 'q', ctx);
    expect(num).toEqual({ kind: 'text', text: '' });

    // No record under the alias ⇒ empty text.
    const none = await resolveSearchRun({ vectorField: 'tsv' }, 'd', {}, 'q', ctx);
    expect(none).toEqual({ kind: 'text', text: '' });

    // Neither run nor vectorField ⇒ default.
    const def = await resolveSearchRun({}, 'd', { d: {} }, 'q', ctx);
    expect(def).toEqual({ kind: 'default' });
  });

  it('resolveSemanticRun: run override, vector producer, vectorField numbers / non-number / non-array / missing, default', async () => {
    const score = await resolveSemanticRun({ run: () => 0.5 }, 'd', {}, [1], ctx);
    expect(score).toEqual({ kind: 'score', score: 0.5 });

    const prod = await resolveSemanticRun({ vector: () => [1, 2] }, 'd', {}, [1], ctx);
    expect(prod).toEqual({ kind: 'vector', vector: [1, 2] });

    const vec = await resolveSemanticRun({ vectorField: 'emb' }, 'd', { d: { emb: [1, 2, 3] } }, [1], ctx);
    expect(vec).toEqual({ kind: 'vector', vector: [1, 2, 3] });

    // A non-number element ⇒ null.
    const bad = await resolveSemanticRun({ vectorField: 'emb' }, 'd', { d: { emb: [1, 'x'] } }, [1], ctx);
    expect(bad).toEqual({ kind: 'vector', vector: null });

    // A non-array cell ⇒ null.
    const nonArr = await resolveSemanticRun({ vectorField: 'emb' }, 'd', { d: { emb: 'nope' } }, [1], ctx);
    expect(nonArr).toEqual({ kind: 'vector', vector: null });

    // No record under the alias ⇒ null.
    const none = await resolveSemanticRun({ vectorField: 'emb' }, 'd', {}, [1], ctx);
    expect(none).toEqual({ kind: 'vector', vector: null });

    // Neither run / vector / vectorField ⇒ default.
    const def = await resolveSemanticRun({}, 'd', { d: {} }, [1], ctx);
    expect(def).toEqual({ kind: 'default' });
  });
});
