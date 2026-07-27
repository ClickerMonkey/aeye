/**
 * The extract→embed→sync-build semantic seam + the pgvector TEXT helpers.
 *
 * A `semantic(...)` term whose query is a TEXT literal — or a text PARAM value —
 * is TEXT, not an embedding. SQL emission is synchronous and cannot call an async
 * embedder, so the caller resolves the vectors UP FRONT:
 *   - `engine.semanticTexts(query, opts)` extracts the DISTINCT plain-text
 *     semantic terms (literals AND text-param values, in subqueries too) needing
 *     embedding, in a stable order — excluding any already-`[…]` vector-text;
 *   - the caller embeds each and fills a `text → vector` Map;
 *   - `engine.toSQL(query, dialect, { embeddings })` looks each term up, formats
 *     it to a pgvector TEXT literal (`[…]`), and binds it — all SYNC;
 *   - a plain-text semantic term with NO cache — or MISSING from it — THROWS;
 *   - a PRE-EMBEDDED `[…]` vector-text term / param is bound as-is (never looked up);
 *   - `engine.run(query, { embeddings })` uses the same cache in-memory (no embedder).
 */
import { describe, it, expect } from 'vitest';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { arrayExecutor } from '../runtime/executor';
import { isVectorText, toVectorText, parseVectorText } from '../vector-text';
import type { TypeBacking, TypeDef, SelectDef, SourceRecord } from '../index';

// ─── Fixture: a `doc` Type backed by a hidden `embedding` pgvector field ──────

const docTypeDef: TypeDef = {
  name: 'doc',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'body', type: { kind: 'text', search: true, semantic: true } },
  ],
  count: 100,
  bytes: 64,
};

const docBacking: TypeBacking = { semantic: { vectorField: 'embedding' } };

const docRows: SourceRecord[] = [
  { id: 1, body: 'cats are great', embedding: [1, 0, 0] },
  { id: 2, body: 'dogs are loyal', embedding: [0, 1, 0] },
];

function makeEngine(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(docTypeDef), docBacking);
  registry.finalize();
  return new QueryEngine(registry, { executors: { doc: arrayExecutor(docRows) } });
}

/** SELECT a semantic score over `doc`, aliased `s`, optionally with a WHERE. */
function docScore(query: unknown, where?: unknown): SelectDef {
  const def: SelectDef = {
    kind: 'select',
    fields: [{ expr: { kind: 'semantic', source: 'doc', query } as never, as: 's' }],
    from: { kind: 'type', type: 'doc' },
  };
  if (where) def.where = [where as never];
  return def;
}

// A deterministic embedding: 'cat' ⇒ the first row's unit vector, else orthogonal.
const embed = (text: string): readonly number[] => (text.includes('cat') ? [1, 0, 0] : [0, 0, 1]);

/** Build the `embeddings` cache for exactly the terms a query needs. */
function cacheFor(engine: QueryEngine, def: SelectDef, opts?: { params?: Record<string, string> }): Map<string, readonly number[]> {
  const cache = new Map<string, readonly number[]>();
  for (const text of engine.semanticTexts(def, opts)) cache.set(text, embed(text));
  return cache;
}

// ════════════════════════════════════════════════════════════════════════════
// pgvector TEXT helpers
// ════════════════════════════════════════════════════════════════════════════

describe('pgvector TEXT helpers', () => {
  it('isVectorText detects bracketed literals (tolerating whitespace)', () => {
    expect(isVectorText('[1,2,3]')).toBe(true);
    expect(isVectorText('  [0.1, -2] ')).toBe(true);
    expect(isVectorText('[]')).toBe(true);
    expect(isVectorText('cat')).toBe(false);
    expect(isVectorText('1,2,3')).toBe(false);
  });

  it('toVectorText / parseVectorText round-trip', () => {
    expect(toVectorText([1, 2, 3])).toBe('[1,2,3]');
    expect(parseVectorText('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseVectorText('  [0.5, -0.25 , 4] ')).toEqual([0.5, -0.25, 4]);
    expect(parseVectorText('[]')).toEqual([]);
  });

  it('parseVectorText throws on non-vector text (fail loud)', () => {
    expect(() => parseVectorText('cat')).toThrow(/pgvector text/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// semanticTexts — the extract step
// ════════════════════════════════════════════════════════════════════════════

describe('semanticTexts: extract the terms to embed', () => {
  const engine = makeEngine();

  it('returns exactly the plain-text literal term', () => {
    expect(engine.semanticTexts(docScore('some text'))).toEqual(['some text']);
  });

  it('extracts a text-PARAM value from opts.params', () => {
    expect(
      engine.semanticTexts(docScore({ kind: 'param', name: 'q' }), { params: { q: 'a cat photo' } }),
    ).toEqual(['a cat photo']);
  });

  it('DEDUPES a repeated term (score + WHERE), preserving first-seen order', () => {
    const def = docScore('cat', {
      kind: 'comparison',
      op: '>',
      left: { kind: 'semantic', source: 'doc', query: 'dog' },
      right: { kind: 'literal', value: 0.5 },
    });
    // 'cat' (the score) then 'dog' (the WHERE), each once, in first-seen order.
    expect(engine.semanticTexts(def)).toEqual(['cat', 'dog']);
  });

  it('a repeated identical term collapses to a single entry', () => {
    const def = docScore('cat', {
      kind: 'comparison',
      op: '>',
      left: { kind: 'semantic', source: 'doc', query: 'cat' },
      right: { kind: 'literal', value: 0.5 },
    });
    expect(engine.semanticTexts(def)).toEqual(['cat']);
  });

  it('EXCLUDES an already-`[…]` vector-text literal (needs no embedding)', () => {
    expect(engine.semanticTexts(docScore('[9,9,9]'))).toEqual([]);
  });

  it('EXCLUDES a pre-embedded vector-text PARAM; a NULL param contributes nothing', () => {
    expect(
      engine.semanticTexts(docScore({ kind: 'param', name: 'q' }), { params: { q: '[9,9,9]' } }),
    ).toEqual([]);
    // No value supplied ⇒ not a semantic term ⇒ nothing to embed.
    expect(engine.semanticTexts(docScore({ kind: 'param', name: 'q' }))).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SQL emission — toSQL with a precomputed embeddings cache, and the throws
// ════════════════════════════════════════════════════════════════════════════

describe('semantic text→vector: SQL emission (sync)', () => {
  const engine = makeEngine();

  it('END-TO-END: collect → embed → toSQL emits a pgvector param, cast ::vector', () => {
    const def = docScore('cat');
    // Extract → embed → fill cache → build synchronously.
    expect(engine.semanticTexts(def)).toEqual(['cat']);
    const { sql, params } = engine.toSQL(def, 'postgres', { embeddings: cacheFor(engine, def) });
    expect(sql).toContain('(1 - ("doc"."embedding" <=> $1::vector))');
    expect(params).toEqual(['[1,0,0]']);
  });

  it('resolves a TEXT-PARAM value that arrives at execution', () => {
    const def = docScore({ kind: 'param', name: 'q' });
    const opts = { params: { q: 'a cat photo' } };
    const { sql, params } = engine.toSQL(def, 'postgres', {
      ...opts,
      embeddings: cacheFor(engine, def, opts),
    });
    expect(sql).toContain('$1::vector');
    expect(params).toEqual(['[1,0,0]']);
  });

  it('a repeated term binds twice from ONE cache entry (dedup on extract)', () => {
    const def = docScore('cat', {
      kind: 'comparison',
      op: '>',
      left: { kind: 'semantic', source: 'doc', query: 'cat' },
      right: { kind: 'literal', value: 0.5 },
    });
    const cache = cacheFor(engine, def);
    expect(cache.size).toBe(1);
    const { params } = engine.toSQL(def, 'postgres', { embeddings: cache });
    expect(params.filter((p) => p === '[1,0,0]').length).toBe(2);
  });

  it('accepts a RESOLVER function as a superset of the Map', () => {
    const { params } = engine.toSQL(docScore('cat'), 'postgres', { embeddings: (t) => embed(t) });
    expect(params).toEqual(['[1,0,0]']);
  });

  it('a PRE-EMBEDDED `[…]` vector-text term / param is bound as-is (never looked up)', () => {
    // A literal already in pgvector form — no cache needed, passes through.
    expect(engine.toSQL(docScore('[9,9,9]'), 'postgres').params).toEqual(['[9,9,9]']);
    // And a pre-embedded param, likewise.
    const { params } = engine.toSQL(docScore({ kind: 'param', name: 'q' }), 'postgres', {
      params: { q: '[9,9,9]' },
    });
    expect(params).toEqual(['[9,9,9]']);
  });

  it('a semantic text PARAM with NO value supplied binds NULL (no lookup, no throw)', () => {
    const { params } = engine.toSQL(docScore({ kind: 'param', name: 'q' }), 'postgres', {
      embeddings: new Map(),
    });
    expect(params).toEqual([null]);
  });

  it('THROWS a directed error when a text term has NO embeddings cache', () => {
    expect(() => engine.toSQL(docScore('cat'), 'postgres')).toThrow(/plain text.*semanticTexts/s);
  });

  it('THROWS when a needed term is MISSING from the cache (fail loud, no mis-bind)', () => {
    // Cache has the wrong term ⇒ 'cat' is absent ⇒ throw (never `'cat'::vector`).
    expect(() =>
      engine.toSQL(docScore('cat'), 'postgres', { embeddings: new Map([['dog', [0, 0, 1]]]) }),
    ).toThrow(/no embedding supplied.*"cat"/s);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime — run() with a precomputed embeddings cache (no embedder needed)
// ════════════════════════════════════════════════════════════════════════════

describe('semantic text→vector: runtime run()', () => {
  const engine = makeEngine();

  it('run() with an embeddings cache scores against the stored vector (no embedder)', async () => {
    const def = docScore('cat');
    const res = await engine.run(def, { embeddings: cacheFor(engine, def) });
    // 'cat' ⇒ [1,0,0]; row 1 embedding [1,0,0] ⇒ cosine 1; row 2 [0,1,0] ⇒ 0.
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
    expect(res.rows[1]!['s']).toBeCloseTo(0, 6);
  });

  it('run() with a cache resolves a text PARAM value', async () => {
    const def = docScore({ kind: 'param', name: 'q' });
    const opts = { params: { q: 'a cat' } };
    const res = await engine.run(def, { ...opts, embeddings: cacheFor(engine, def, opts) });
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('run() accepts a RESOLVER function too', async () => {
    const res = await engine.run(docScore('cat'), { embeddings: (t) => embed(t) });
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('run() uses a PRE-EMBEDDED `[…]` param value directly (cache not consulted)', async () => {
    let consulted = false;
    const res = await engine.run(docScore({ kind: 'param', name: 'q' }), {
      params: { q: '[1,0,0]' },
      embeddings: (t) => {
        consulted = true;
        return embed(t);
      },
    });
    expect(consulted).toBe(false);
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('run() THROWS when a needed term is MISSING from the cache (fail loud)', async () => {
    await expect(engine.run(docScore('cat'), { embeddings: new Map() })).rejects.toThrow(
      /no embedding supplied.*"cat"/s,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEPTH COVERAGE — `semanticTexts` finds terms ANYWHERE in the query tree, and
// the SAME walk `toSQL` uses to RESOLVE terms visits the identical set.
//
// `semanticTexts` reuses `toSQL`'s exact emit walk (a discarded collecting pass),
// so a term is collected iff `toSQL` would bind it — no matter how deeply it is
// nested (boolean AND/OR/NOT, a subquery WHERE, a computed-field expr, a
// function-call arg, a CASE/WHEN). These tests plant terms at several depths and
// prove BOTH that they are all found and that extract == build.
// ════════════════════════════════════════════════════════════════════════════

describe('semanticTexts: deep-tree coverage + extract==build agreement', () => {
  // A `doc` Type whose hidden `boost` field is a COMPUTED semantic score — so
  // referencing it emits a `semantic(...)` term buried in a computed-field expr.
  function makeDeepEngine(): QueryEngine {
    const registry = createRegistry();
    const deepDocDef: TypeDef = {
      name: 'doc',
      fields: [
        { name: 'id', type: { kind: 'number', whole: true } },
        { name: 'body', type: { kind: 'text', search: true, semantic: true } },
        { name: 'boost', type: { kind: 'number' } },
      ],
      count: 100,
      bytes: 64,
    };
    const deepBacking: TypeBacking = {
      semantic: { vectorField: 'embedding' },
      fields: {
        // `boost` is computed from a semantic term (planted at computed-field depth).
        boost: {
          compute: {
            expr: (alias) => registry.parseExpr({ kind: 'semantic', source: alias, query: 'in-computed' }),
          },
        },
      },
    };
    registry.registerType(registry.parseType(deepDocDef), deepBacking);
    registry.finalize();
    return new QueryEngine(registry, { executors: { doc: arrayExecutor(docRows) } });
  }

  /** `semantic(doc, text) > 0.1` — a numeric comparison carrying a semantic term. */
  const sem = (text: string): unknown => ({
    kind: 'comparison',
    op: '>',
    left: { kind: 'semantic', source: 'doc', query: text },
    right: { kind: 'literal', value: 0.1 },
  });

  // A single query with `semantic(...)` terms planted at SIX different depths:
  //   1. 'in-computed'  — inside a computed-field expr (via the `boost` field-ref);
  //   2. 'in-case'      — inside a CASE/WHEN condition (a projection);
  //   3. 'in-function'  — inside a function-call ARG (`abs(semantic(...))`);
  //   4. 'in-and'       — inside AND inside OR inside NOT (nested boolean, WHERE);
  //   5. 'in-or'        — a sibling of that AND, one level up (same nested WHERE);
  //   6. 'in-subquery'  — inside an EXISTS subquery's own WHERE.
  const deepQuery: SelectDef = {
    kind: 'select',
    fields: [
      { expr: { kind: 'field-ref', source: 'doc', field: 'boost' }, as: 'boost' },
      {
        expr: {
          kind: 'case',
          branches: [{ when: sem('in-case') as never, then: { kind: 'literal', value: 1 } }],
          else: { kind: 'literal', value: 0 },
        } as never,
        as: 'flag',
      },
      {
        expr: {
          kind: 'function-call',
          function: 'abs',
          args: { value: { kind: 'semantic', source: 'doc', query: 'in-function' } },
        } as never,
        as: 'mag',
      },
    ],
    from: { kind: 'type', type: 'doc' },
    where: [
      {
        kind: 'logical',
        op: 'not',
        operands: [
          {
            kind: 'logical',
            op: 'or',
            operands: [
              { kind: 'logical', op: 'and', operands: [sem('in-and') as never] },
              sem('in-or') as never,
            ],
          },
        ],
      } as never,
      {
        kind: 'exists',
        query: {
          kind: 'select',
          fields: [{ expr: { kind: 'field-ref', source: 'd2', field: 'id' }, as: 'id' }],
          from: { kind: 'aliased', type: 'doc', as: 'd2' },
          where: [
            {
              kind: 'comparison',
              op: '>',
              left: { kind: 'semantic', source: 'd2', query: 'in-subquery' },
              right: { kind: 'literal', value: 0.5 },
            },
          ],
        },
      } as never,
    ],
  };

  const ALL_TERMS = ['in-computed', 'in-case', 'in-function', 'in-and', 'in-or', 'in-subquery'];

  it('collects EVERY planted term regardless of nesting depth (deduped)', () => {
    const engine = makeDeepEngine();
    const collected = engine.semanticTexts(deepQuery);
    // Every planted term is found — order is stable/first-seen, but assert on the
    // SET so the test is robust to the emit order across clauses.
    expect([...collected].sort()).toEqual([...ALL_TERMS].sort());
    // Deduped: no term appears twice.
    expect(collected.length).toBe(new Set(collected).size);
  });

  it('extract == build: the toSQL resolve walk requests exactly the collected set', () => {
    const engine = makeDeepEngine();
    const collected = engine.semanticTexts(deepQuery);
    // Build with a RESOLVER that records every term `toSQL` asks it to resolve.
    const requested: string[] = [];
    engine.toSQL(deepQuery, 'postgres', {
      embeddings: (text) => {
        requested.push(text);
        return [1, 0, 0];
      },
    });
    // The build asks for a vector once per OCCURRENCE; its DISTINCT set must equal
    // exactly the set `semanticTexts` extracted (no term collected-but-not-resolved
    // or resolved-but-not-collected).
    expect([...new Set(requested)].sort()).toEqual([...collected].sort());
  });

  it('a repeated deep term is collected ONCE but resolved per occurrence at build', () => {
    const engine = makeDeepEngine();
    // Same term buried in a CASE (projection) AND in a nested-AND WHERE.
    const def: SelectDef = {
      kind: 'select',
      fields: [
        {
          expr: {
            kind: 'case',
            branches: [{ when: sem('repeated') as never, then: { kind: 'literal', value: 1 } }],
          } as never,
          as: 'flag',
        },
      ],
      from: { kind: 'type', type: 'doc' },
      where: [{ kind: 'logical', op: 'and', operands: [sem('repeated') as never] } as never],
    };
    expect(engine.semanticTexts(def)).toEqual(['repeated']);
    const requested: string[] = [];
    engine.toSQL(def, 'postgres', {
      embeddings: (text) => {
        requested.push(text);
        return [1, 0, 0];
      },
    });
    expect(requested).toEqual(['repeated', 'repeated']);
  });
});
