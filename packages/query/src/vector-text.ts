/**
 * pgvector TEXT helpers + the caller-supplied text→vector conversion seam.
 *
 * A `semantic(...)` term can be a plain-text LITERAL or a text PARAM value. Such
 * text is NOT an embedding — it must be turned into a vector before it can be
 * compared. Postgres has no array bind type, so a query vector travels as a
 * pgvector TEXT literal (`[a,b,c]`) and is cast `::vector` by the dialect. The
 * embedding itself is a model/network call the query layer does not own, so the
 * CALLER supplies the conversion function (see `SemanticTextToVector`).
 *
 * This module has NO runtime imports (pure string/number work), so it sits at
 * the bottom of the module graph and is safe to import from both the SQL and the
 * runtime paths.
 */

/**
 * Converts a plain-text semantic term — a `semantic(...)` TEXT LITERAL, or the
 * runtime value of a `semantic(...)` text PARAM — into its pgvector TEXT form: a
 * bracketed literal such as `[0.0123,-0.045,…]`. The SYNCHRONOUS form is what SQL
 * emission (`engine.toSQL`) requires, because emission is synchronous.
 */
export type SemanticTextToVector = (text: string) => string;

/**
 * The ASYNC-capable form of {@link SemanticTextToVector}, accepted by the
 * asynchronous entry points (`engine.run`, `engine.toSQLAsync`) — they resolve
 * every semantic term up front, before binding.
 */
export type SemanticTextToVectorAsync = (text: string) => string | Promise<string>;

/** Whether `text` is already in pgvector TEXT form (a bracketed `[…]` literal). */
export function isVectorText(text: string): boolean {
  const t = text.trim();
  return t.startsWith('[') && t.endsWith(']');
}

/** Format an embedding vector as pgvector TEXT (`[a,b,c]`, no spaces). */
export function toVectorText(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

/**
 * Parse a pgvector TEXT literal (`[a,b,c]`) back into numbers. Tolerates
 * surrounding whitespace and an empty vector (`[]` ⇒ `[]`). Throws on a value
 * that is not bracketed pgvector text (so a mis-supplied term fails loudly rather
 * than silently scoring against a garbage vector).
 */
export function parseVectorText(text: string): number[] {
  const t = text.trim();
  if (!isVectorText(t)) {
    throw new Error(`parseVectorText: expected pgvector text '[…]', got ${JSON.stringify(text)}.`);
  }
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(',').map((part) => Number(part.trim()));
}
