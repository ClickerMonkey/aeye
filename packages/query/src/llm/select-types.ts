/**
 * `selectTypes` — semantic Type SELECTION: given a natural-language request,
 * rank the engine's registered Types by how relevant they are and return the
 * top-N. This is the "narrow the schema before prompting" step — feeding an
 * LLM only the handful of Types a request actually needs keeps the structured
 * query schema small (see `shouldUseStringSchema`) and the prompt focused.
 *
 * Strategy:
 *  - WITH an embedder: embed the request and each Type's descriptive text
 *    (name + label + description), rank by cosine similarity, return the top
 *    `topN`.
 *  - WITHOUT an embedder (graceful degrade): fall back to a case-insensitive
 *    substring match of the request against each Type's text; if nothing
 *    matches, return ALL Types (better to over-include than to hide schema).
 *
 * The embedder is the engine's optional `embedder` slot, so tests can inject
 * a deterministic STUB that maps known phrases to fixed vectors.
 */
import type { QueryEngine } from '../engine';
import type { Embedder } from '../engine';
import type { Type } from '../type';

/** Options for `selectTypes`. */
export interface SelectTypesOptions {
  /** Maximum Types to return. Default 5. */
  topN?: number;
  /**
   * Override the engine's embedder (e.g. inject a stub in tests). When the
   * resulting embedder is undefined, the substring-match fallback is used.
   */
  embedder?: Embedder;
}

/** Cosine similarity of two equal-length vectors (0 when either is empty). */
function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** The descriptive text used to embed / match a Type. */
function typeText(type: Type): string {
  return [type.name, type.label, type.description].filter((s): s is string => Boolean(s)).join(' ');
}

/** Degraded selection: substring match, falling back to every Type. */
function substringSelect(types: readonly Type[], request: string, topN: number): Type[] {
  const needle = request.toLowerCase();
  const matched = types.filter((t) => typeText(t).toLowerCase().includes(needle));
  const chosen = matched.length > 0 ? matched : [...types];
  return chosen.slice(0, topN);
}

/**
 * Rank the engine's registered Types by relevance to a natural-language
 * `request` and return the top-`topN`. Uses the engine's (or overridden)
 * embedder for cosine-similarity ranking, falling back to substring matching
 * (and to every Type when nothing matches) when no embedder is available.
 */
export async function selectTypes(
  engine: QueryEngine,
  request: string,
  options: SelectTypesOptions = {},
): Promise<Type[]> {
  const topN = options.topN ?? 5;
  const types = engine.registry.typeList();
  if (types.length === 0) return [];

  const embedder = options.embedder ?? engine.embedder;
  if (!embedder) return substringSelect(types, request, topN);

  // Embed the request once, then each Type, and rank by cosine similarity.
  const requestVec = await embedder.embed(request);
  const scored = await Promise.all(
    types.map(async (type) => ({
      type,
      score: cosine(requestVec, await embedder.embed(typeText(type))),
    })),
  );
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN).map((s) => s.type);
}
