/**
 * Three-valued logic (3VL) for the in-memory predicate path, mirroring SQL's
 * `TRUE` / `FALSE` / `UNKNOWN`. `UNKNOWN` is represented as `undefined`.
 *
 * Predicate evaluation (`BoolExpr.evaluateBool`) returns a `Tri`; a row-filter
 * site (WHERE / HAVING / JOIN ON) keeps a row ONLY when the predicate is
 * strictly `true` — both `false` AND `undefined` (UNKNOWN) exclude, exactly as
 * SQL does. This module is the single source of the truth tables so comparison
 * / logical / in / between stay consistent.
 */
import type { Value } from './value';

/** A three-valued boolean: `true` / `false` / `undefined` (SQL UNKNOWN). */
export type Tri = boolean | undefined;

/** SQL `NOT`: `NOT UNKNOWN = UNKNOWN`. */
export function not3(a: Tri): Tri {
  return a === undefined ? undefined : !a;
}

/** SQL `AND`: FALSE dominates; else UNKNOWN if any UNKNOWN; else TRUE. */
export function and3(a: Tri, b: Tri): Tri {
  if (a === false || b === false) return false;
  if (a === undefined || b === undefined) return undefined;
  return true;
}

/** SQL `OR`: TRUE dominates; else UNKNOWN if any UNKNOWN; else FALSE. */
export function or3(a: Tri, b: Tri): Tri {
  if (a === true || b === true) return true;
  if (a === undefined || b === undefined) return undefined;
  return false;
}

/**
 * Interpret a runtime `Value` as a `Tri`: a NULL value is UNKNOWN; otherwise
 * its truthiness. Used where a predicate operand is a general `Expr` (e.g. a
 * `logical` operand, a `filters` inner expr) so a NULL boolean propagates as
 * UNKNOWN rather than collapsing to FALSE.
 */
export function triOf(v: Value): Tri {
  return v.isNull() ? undefined : v.toBoolean();
}
