/**
 * Subquery resolution seam.
 *
 * `subquery`, `exists`, and the subquery form of `in` reference a `QueryDef`.
 * They all infer the subquery's output `ResolvedType` through this single
 * function so the call site stays localized.
 *
 * Phase 3 SWAP (done): now that the runtime Query classes exist, this delegates
 * to real `Query.resolve(engine, scope)` — `registry.parseQuery(def)` builds
 * the query and resolution binds its FROM / JOIN sources in a child scope (so
 * a correlated subquery can still see the outer sources via the parent chain).
 * Single-field selects resolve to that field's scalar type; multi-field
 * shapes resolve to a synthetic type.
 */
import type { QueryDef } from '../schema';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import type { ValidateContext } from '../expr';

/** Infer a subquery's output `ResolvedType` via real query resolution. */
export function inferSubqueryOutput(
  engine: QueryEngine,
  scope: QueryScope,
  def: QueryDef,
): ResolvedType {
  return engine.parseQuery(def).resolve(engine, scope);
}

/**
 * FULLY VALIDATE a subquery's inner query (accumulating its problems into `p`)
 * and return its output `ResolvedType`. Used by `exists` / `in` (subquery form)
 * / `subquery` so an error INSIDE the inner query surfaces.
 *
 * CORRELATION-AWARE: the inner query's own `validateWalk` seeds a CHILD scope
 * (binding its FROM / JOIN sources) whose PARENT is `scope` — so a correlated
 * ref inside the subquery still resolves the OUTER sources via the parent chain,
 * exactly as `resolve`'s child-scope binding does. Total (never throws); the
 * caller wraps the call in the right `p.at(...)` path so problems nest under the
 * subquery.
 */
export function validateSubqueryOutput(
  engine: QueryEngine,
  scope: QueryScope,
  p: Problems,
  ctx: ValidateContext,
  def: QueryDef,
): ResolvedType {
  const q = engine.parseQuery(def);
  q.validateWalk(engine, scope, p, ctx);
  return q.resolve(engine, scope);
}
