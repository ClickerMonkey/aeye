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

/** Infer a subquery's output `ResolvedType` via real query resolution. */
export function inferSubqueryOutput(
  engine: QueryEngine,
  scope: QueryScope,
  def: QueryDef,
): ResolvedType {
  return engine.parseQuery(def).resolve(engine, scope);
}
