/**
 * Shared WRITE-value parsing for the keyed INSERT-row / UPDATE-SET records — the
 * throwing counterpart of the defensive {@link writeRecordShape} in `_shape.ts`.
 * A field's value is EITHER a raw typed value OR a full `ExprDef` (see
 * `WriteValueDef`), and the OpenAI-safe null semantics are enforced here: an
 * absent key OR a JSON `null` value OMITS the field (its backing default fills
 * in / it stays unset); a literal-null expr `{ kind:'literal', value:null }` is
 * the ONLY way to set SQL NULL.
 */
import type { Expr } from '../expr';
import type { Registry } from '../registry';
import type { ExprDef, WriteValueDef } from '../schema';
import { LiteralExpr } from '../exprs/index';
import { isRecord } from '../shape';
import { QueryTypeError } from '../problem';

/** Whether a write value is an `ExprDef` — a non-null object carrying a string `kind`. */
export function isExprValue(v: unknown): v is ExprDef {
  return isRecord(v) && typeof v['kind'] === 'string';
}

/**
 * Parse one {@link WriteValueDef} into its `Expr`, or `undefined` to OMIT the
 * field. `undefined` / `null` ⇒ OMIT; a `{ kind }` object ⇒ an `ExprDef` (a
 * literal-null expr sets SQL NULL); a raw scalar ⇒ a `LiteralExpr`. A raw array
 * / non-expr object is unsupported (throws) — such values must be expressed as
 * an expression.
 */
export function writeValueToExpr(v: WriteValueDef, registry: Registry): Expr | undefined {
  if (v === null || v === undefined) return undefined; // OMIT
  if (isExprValue(v)) return registry.parseExpr(v);
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return new LiteralExpr(v);
  throw new QueryTypeError({
    path: [],
    code: 'write.unsupported-value',
    severity: 'error',
    message: `Unsupported write value ${JSON.stringify(v)}; use a scalar or an expression.`,
  });
}

/**
 * Parse a keyed write RECORD (an INSERT row / UPDATE SET / ON CONFLICT update)
 * into an insertion-ordered field → `Expr` map, DROPPING every OMITted key
 * (absent is impossible here; a JSON-`null` value is dropped).
 */
export function parseWriteRecord(
  record: { readonly [field: string]: WriteValueDef },
  registry: Registry,
): Map<string, Expr> {
  const out = new Map<string, Expr>();
  for (const key of Object.keys(record)) {
    const expr = writeValueToExpr(record[key]!, registry);
    if (expr !== undefined) out.set(key, expr); // undefined ⇒ OMIT
  }
  return out;
}
