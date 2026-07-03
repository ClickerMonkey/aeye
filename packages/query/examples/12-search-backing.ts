/**
 * Example 12 — Search & semantic BACKING: hidden tsvector / pgvector fields.
 *
 * A conceptual `article` Type flags `body` as `search` + `semantic` — that is
 * ALL the LLM sees. Behind the scenes the physical table also has two fields the
 * type system never exposes: a precomputed `search_tsv` (`tsvector`) and an
 * `embedding` (`pgvector`). A `TypeBacking` points full-text search / similarity
 * at those hidden fields via `vectorField`, so:
 *
 *   - `toSQL('postgres')` for a `text-search` emits the precomputed-tsvector
 *     predicate `"article"."search_tsv" @@ plainto_tsquery('english', $1)` — NOT
 *     a fresh `to_tsvector(body)` — and for a `semantic` score emits cosine
 *     `1 - ("article"."embedding" <=> $1::vector)` (the query vector bound as a
 *     pgvector PARAM; `toSQL` stays synchronous — no embedder call).
 *   - `run()` in-memory reads the same hidden fields: the `search_tsv` text is
 *     token-matched, and the stored `embedding` is cosine-compared to the query
 *     embedding (a stub embedder supplies vectors here).
 *   - the base (ANSI) dialect DEGRADES gracefully — the tsvector field falls back
 *     to a `LIKE`, and vector similarity to a constant `0` — without throwing.
 *
 * The `title` field shows a FIELD-LEVEL override winning over the type-level
 * backing (its own `title_tsv` / `title_vec`).
 */
import {
  createRegistry,
  QueryEngine,
  arrayExecutor,
  type Embedder,
  type TypeDef,
  type SelectDef,
  type ExprDef,
  type TypeBacking,
  type SourceRecord,
} from '../src/index';
import type { ExampleReport } from './_util';

// A deterministic stub embedder: 'search ranking' embeds near the first row's
// stored embedding; everything else is orthogonal (cosine 0).
const stubEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    return text.includes('ranking') ? [1, 1, 0] : [0, 0, 1];
  },
};

/** The CONCEPTUAL `article` Type — plain + LLM-facing; no hidden fields here. */
const articleTypeDef: TypeDef = {
  name: 'article',
  label: 'Article',
  description: 'A published article.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text', search: true, semantic: true } },
    { name: 'body', type: { kind: 'text', search: true, semantic: true } },
  ],
  count: 500,
  bytes: 96,
};

/** A tiny field-ref helper for the JSON exprs below. */
const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });

export async function run(): Promise<ExampleReport> {
  const output: string[] = [];
  let errors = 0;

  const registry = createRegistry();

  // The backing points search / similarity at HIDDEN physical fields. None of
  // `search_tsv` / `embedding` / `title_tsv` / `title_vec` is a conceptual field.
  const backing: TypeBacking = {
    // WHOLE-TYPE: a precomputed tsvector field + a pgvector embedding field.
    search: { vectorField: 'search_tsv', language: 'english' },
    semantic: { vectorField: 'embedding' },
    fields: {
      // FIELD-LEVEL override: a title-only tsvector / vector wins for `title`.
      title: {
        search: { vectorField: 'title_tsv' },
        semantic: { vectorField: 'title_vec' },
      },
    },
  };

  registry.registerType(registry.parseType(articleTypeDef), backing);
  registry.finalize();

  // The hidden fields (search_tsv / embedding / title_*) live only in the data.
  const rows: SourceRecord[] = [
    {
      id: 1,
      title: 'Search ranking basics',
      body: 'How full text search ranking works.',
      search_tsv: 'search ranking basics full text works',
      title_tsv: 'search ranking basics',
      embedding: [1, 1, 0],
      title_vec: [1, 1, 0],
    },
    {
      id: 2,
      title: 'Unrelated notes',
      body: 'A grab bag of miscellany.',
      search_tsv: 'unrelated notes grab bag miscellany',
      title_tsv: 'unrelated notes',
      embedding: [0, 0, 1],
      title_vec: [0, 0, 1],
    },
  ];

  const engine = new QueryEngine(registry, {
    embedder: stubEmbedder,
    executors: { article: arrayExecutor(rows) },
  });

  // ── 1. EMIT SQL over the HIDDEN fields (postgres) ────────────────────────────
  const textWhere: SelectDef = {
    kind: 'select',
    fields: [{ expr: ref('article', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'article' },
    where: [{ kind: 'text-search', source: 'article', query: 'ranking' }],
  };
  const semanticSelect: SelectDef = {
    kind: 'select',
    fields: [
      { expr: ref('article', 'id'), as: 'id' },
      { expr: { kind: 'semantic', source: 'article', query: 'search ranking' }, as: 'score' },
    ],
    from: { kind: 'type', type: 'article' },
  };
  const titleWhere: SelectDef = {
    kind: 'select',
    fields: [{ expr: ref('article', 'id'), as: 'id' }],
    from: { kind: 'type', type: 'article' },
    where: [{ kind: 'text-search', source: 'article', field: 'title', query: 'ranking' }],
  };

  errors += engine.validateQuery(textWhere).list.filter((p) => p.severity === 'error').length;
  errors += engine.validateQuery(semanticSelect).list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  output.push('\ntoSQL(postgres) — whole-type text-search (hidden tsvector):');
  output.push(`  ${engine.toSQL(textWhere, 'postgres').sql}`);
  output.push('\ntoSQL(postgres) — field-level override (title_tsv):');
  output.push(`  ${engine.toSQL(titleWhere, 'postgres').sql}`);
  output.push('\ntoSQL(postgres) — semantic (hidden pgvector, $n::vector param):');
  output.push(`  ${engine.toSQL(semanticSelect, 'postgres').sql}`);

  // ── 2. BASE (ANSI) DEGRADE — no throw ────────────────────────────────────────
  output.push('\ntoSQL(base) — degrades tsvector → LIKE, similarity → 0:');
  output.push(`  ${engine.toSQL(textWhere, 'base').sql}`);
  output.push(`  ${engine.toSQL(semanticSelect, 'base').sql}`);

  // ── 3. RUN IN-MEMORY over the hidden fields ──────────────────────────────────
  const searched = await engine.run(textWhere);
  output.push(`\nrun() text-search 'ranking' (token-matched search_tsv) ⇒ ids: ${JSON.stringify(searched.rows.map((r) => r['id']))}`);

  const scored = await engine.run(semanticSelect);
  output.push('run() semantic score (cosine over stored embedding):');
  for (const row of scored.rows) {
    const score = row['score'];
    const n = typeof score === 'number' ? score.toFixed(3) : String(score);
    output.push(`  id=${String(row['id'])} score=${n}`);
  }

  return { title: 'Search & semantic backing — hidden tsvector / pgvector fields', output, errors };
}
