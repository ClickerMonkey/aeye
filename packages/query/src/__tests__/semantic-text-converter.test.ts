/**
 * The semantic text→vector conversion seam (`convertSemanticText`) + the
 * pgvector TEXT helpers.
 *
 * A `semantic(...)` term whose query is a TEXT literal — or a text PARAM value —
 * is TEXT, not an embedding. SQL emission is synchronous and cannot call an async
 * embedder, so it used to bind the raw text and emit the invalid
 * `'<text>'::vector`. Now:
 *   - `engine.toSQLAsync(query, dialect, { convertSemanticText })` embeds every
 *     semantic text term (literals AND text-param values, in subqueries too) into
 *     a pgvector TEXT literal (`[…]`) before binding;
 *   - `engine.toSQL(query, dialect, { convertSemanticText })` does the same with a
 *     SYNC converter (pre-embedded / warmed-cache callers);
 *   - a plain-text semantic term with NO converter THROWS (fail loud);
 *   - a PRE-EMBEDDED `[…]` vector-text param is bound as-is (unchanged);
 *   - `engine.run(query, { convertSemanticText })` uses the same seam in-memory
 *     (parsing the `[…]` back to a vector for cosine), with no embedder needed.
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

// A deterministic converter: 'cat' ⇒ the first row's unit vector, else orthogonal.
const convert = (text: string): string => (text.includes('cat') ? '[1,0,0]' : '[0,0,1]');

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
// SQL emission — toSQLAsync / toSQL with a converter, and the throw
// ════════════════════════════════════════════════════════════════════════════

describe('semantic text→vector: SQL emission', () => {
  const engine = makeEngine();

  it('toSQLAsync embeds a TEXT-literal term to a pgvector param, cast ::vector', async () => {
    const { sql, params } = await engine.toSQLAsync(docScore('cat'), 'postgres', { convertSemanticText: convert });
    expect(sql).toContain('(1 - ("doc"."embedding" <=> $1::vector))');
    expect(params).toEqual(['[1,0,0]']);
  });

  it('toSQLAsync embeds a TEXT-PARAM value that arrives at execution', async () => {
    const { sql, params } = await engine.toSQLAsync(docScore({ kind: 'param', name: 'q' }), 'postgres', {
      params: { q: 'a cat photo' },
      convertSemanticText: convert,
    });
    expect(sql).toContain('$1::vector');
    expect(params).toEqual(['[1,0,0]']);
  });

  it('toSQLAsync accepts an ASYNC converter and dedupes repeated terms', async () => {
    let calls = 0;
    const asyncConvert = async (text: string): Promise<string> => {
      calls++;
      return convert(text);
    };
    // Same literal used twice (score + WHERE) ⇒ converted ONCE.
    const def = docScore('cat', {
      kind: 'comparison',
      op: '>',
      left: { kind: 'semantic', source: 'doc', query: 'cat' },
      right: { kind: 'literal', value: 0.5 },
    });
    const { params } = await engine.toSQLAsync(def, 'postgres', { convertSemanticText: asyncConvert });
    expect(calls).toBe(1);
    expect(params.filter((p) => p === '[1,0,0]').length).toBe(2);
  });

  it('a PRE-EMBEDDED [..] vector-text param is bound as-is (never sent to the converter)', async () => {
    let called = false;
    const { params } = await engine.toSQLAsync(docScore({ kind: 'param', name: 'q' }), 'postgres', {
      params: { q: '[9,9,9]' },
      convertSemanticText: (t) => {
        called = true;
        return convert(t);
      },
    });
    expect(called).toBe(false);
    expect(params).toEqual(['[9,9,9]']);
  });

  it('sync toSQL works with a SYNC converter', () => {
    const { sql, params } = engine.toSQL(docScore('cat'), 'postgres', { convertSemanticText: convert });
    expect(sql).toContain('$1::vector');
    expect(params).toEqual(['[1,0,0]']);
  });

  it('a semantic text PARAM with NO value supplied binds NULL (no conversion, no throw)', () => {
    // The converter is never consulted for an absent param — it binds NULL.
    const { params } = engine.toSQL(docScore({ kind: 'param', name: 'q' }), 'postgres', {
      convertSemanticText: convert,
    });
    expect(params).toEqual([null]);
  });

  it('THROWS a directed error when a text term has NO converter (sync or async)', async () => {
    expect(() => engine.toSQL(docScore('cat'), 'postgres')).toThrow(/plain text.*text→vector|toSQLAsync/s);
    await expect(engine.toSQLAsync(docScore('cat'), 'postgres')).rejects.toThrow(/plain text|toSQLAsync/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime — run() with a stub converter (no embedder needed)
// ════════════════════════════════════════════════════════════════════════════

describe('semantic text→vector: runtime run()', () => {
  const engine = makeEngine();

  it('run() with a converter scores against the stored vector (no embedder)', async () => {
    const res = await engine.run(docScore('cat'), { convertSemanticText: convert });
    // 'cat' ⇒ [1,0,0]; row 1 embedding [1,0,0] ⇒ cosine 1; row 2 [0,1,0] ⇒ 0.
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
    expect(res.rows[1]!['s']).toBeCloseTo(0, 6);
  });

  it('run() with a converter resolves a text PARAM value', async () => {
    const res = await engine.run(docScore({ kind: 'param', name: 'q' }), {
      params: { q: 'a cat' },
      convertSemanticText: convert,
    });
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('run() with an ASYNC converter works too', async () => {
    const res = await engine.run(docScore('cat'), { convertSemanticText: async (t) => convert(t) });
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });

  it('run() uses a PRE-EMBEDDED [..] param value directly (converter not consulted)', async () => {
    let called = false;
    const res = await engine.run(docScore({ kind: 'param', name: 'q' }), {
      params: { q: '[1,0,0]' },
      convertSemanticText: (t) => {
        called = true;
        return convert(t);
      },
    });
    expect(called).toBe(false);
    expect(res.rows[0]!['s']).toBeCloseTo(1, 6);
  });
});
