/**
 * Example 13 — Scoring & ranking: cross-Type semantic PAIRING + numeric text SCORE.
 *
 * Two complementary "top-N by relevance" tools that produce a NUMBER (usable in
 * SELECT + ORDER BY), so a query can rank rows:
 *
 *   1. CROSS-TYPE SEMANTIC PAIRING — a `semantic` score whose `query` is a
 *      `{ source, field }` (or `{ type, field }`) ref to ANOTHER BOUND source.
 *      With both Types joined into scope it scores each row's embedding against
 *      the paired row's embedding, so `ORDER BY score DESC LIMIT N` returns the
 *      top-N most-similar pairs. `toSQL` emits the dialect's `similarity` over
 *      BOTH bound aliases' vectors (postgres cosine; base degrades to 0).
 *
 *   2. NUMERIC TEXT SCORE — `text-score` is the ranking counterpart of the
 *      `text-search` predicate: postgres `ts_rank(to_tsvector(col),
 *      plainto_tsquery(query))`; the base (ANSI) dialect degrades to a numeric
 *      `CASE WHEN <LIKE> THEN 1 ELSE 0 END`. In memory it is a deterministic
 *      token-overlap fraction. So `ORDER BY textScore(...) DESC` ranks by text
 *      relevance.
 */
import {
  createRegistry,
  QueryEngine,
  arrayExecutor,
  e,
  type Embedder,
  type TypeDef,
  type SelectDef,
  type TypeBacking,
  type SourceRecord,
} from '../src/index';
import type { ExampleReport } from './_util';

// A deterministic stub embedder: topic labels map to fixed unit-ish vectors.
const stubEmbedder: Embedder = {
  async embed(text: string): Promise<number[]> {
    if (text === 'machine learning') return [1, 0, 0];
    if (text === 'databases') return [0, 1, 0];
    return [0, 0, 1];
  },
};

/** `paper` — semantic (title) + a belongs-to `topic`; backed by a hidden `emb`. */
const paperDef: TypeDef = {
  name: 'paper',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text', search: true, semantic: true } },
    { name: 'topicId', type: { kind: 'relation', to: 'topic', count: 1, inverseRelation: 'papers' } },
  ],
  count: 500,
  bytes: 96,
};
/** `topic` — semantic (`label`); no backing ⇒ the default `embedding` fragment. */
const topicDef: TypeDef = {
  name: 'topic',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'label', type: { kind: 'text', search: true, semantic: true } },
  ],
  count: 50,
  bytes: 48,
};
// `paper.emb` is a HIDDEN pgvector field the conceptual TypeDef never exposes.
const paperBacking: TypeBacking = { semantic: { vectorField: 'emb' } };

export async function run(): Promise<ExampleReport> {
  const output: string[] = [];
  let errors = 0;

  const registry = createRegistry();
  registry.registerType(registry.parseType(paperDef), paperBacking);
  registry.registerType(registry.parseType(topicDef));
  registry.finalize();

  const paperRows: SourceRecord[] = [
    { id: 1, title: 'Deep nets', topicId: 1, emb: [1, 0, 0] }, // aligns with topic 1
    { id: 2, title: 'B-trees', topicId: 2, emb: [1, 1, 0] }, // partly aligns with topic 2
  ];
  const topicRows: SourceRecord[] = [
    { id: 1, label: 'machine learning' },
    { id: 2, label: 'databases' },
  ];

  const engine = new QueryEngine(registry, {
    embedder: stubEmbedder,
    executors: { paper: arrayExecutor(paperRows), topic: arrayExecutor(topicRows) },
  });

  // ── 1. CROSS-TYPE SEMANTIC PAIRING — top-N most-similar (paper, topic) pairs ──
  const pairing: SelectDef = {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'paper', field: 'id' }, as: 'paperId' },
      // Score each paper's embedding against its joined topic's embedding.
      { expr: e.semantic('paper', { source: 'topic', field: 'label' }).toJSON(), as: 'score' },
    ],
    from: { kind: 'type', type: 'paper' },
    joins: [{ on: { source: 'paper', field: 'topicId' }, as: 'topic', joinType: 'inner' }],
    order: [{ expr: { kind: 'output', name: 'score' }, dir: 'desc' }],
    limit: 10,
  };

  errors += engine.validateQuery(pairing).list.filter((p) => p.severity === 'error').length;

  output.push('CROSS-TYPE SEMANTIC PAIRING (top-10 most-similar pairs)');
  output.push('\ntoSQL(postgres) — similarity over BOTH bound aliases:');
  output.push(`  ${engine.toSQL(pairing, 'postgres').sql}`);
  output.push('\ntoSQL(base) — vector similarity degrades to 0:');
  output.push(`  ${engine.toSQL(pairing, 'base').sql}`);

  const paired = await engine.run(pairing);
  output.push('\nrun() — cosine over the two bound rows, ranked desc:');
  for (const row of paired.rows) {
    const score = row['score'];
    const n = typeof score === 'number' ? score.toFixed(3) : String(score);
    output.push(`  paperId=${String(row['paperId'])} score=${n}`);
  }

  // ── 2. NUMERIC TEXT SCORE — rank topics by text relevance ─────────────────────
  const ranked: SelectDef = {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'topic', field: 'label' }, as: 'label' },
      { expr: e.textScore('topic', 'learning', 'label').toJSON(), as: 'rank' },
    ],
    from: { kind: 'type', type: 'topic' },
    order: [{ expr: { kind: 'output', name: 'rank' }, dir: 'desc' }],
    limit: 10,
  };

  errors += engine.validateQuery(ranked).list.filter((p) => p.severity === 'error').length;

  output.push('\n\nNUMERIC TEXT SCORE (ORDER BY relevance DESC)');
  output.push('\ntoSQL(postgres) — ts_rank:');
  output.push(`  ${engine.toSQL(ranked, 'postgres').sql}`);
  output.push('\ntoSQL(base) — degrades to a numeric 0/1 match:');
  output.push(`  ${engine.toSQL(ranked, 'base').sql}`);

  const relevance = await engine.run(ranked);
  output.push('\nrun() — token-overlap relevance, ranked desc:');
  for (const row of relevance.rows) {
    output.push(`  label=${JSON.stringify(row['label'])} rank=${String(row['rank'])}`);
  }

  return { title: 'Scoring & ranking — cross-Type semantic pairing + numeric text score', output, errors };
}
