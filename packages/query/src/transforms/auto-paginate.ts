/**
 * `autoPaginate` — a SELECT transform that binds pagination to named bind
 * PARAMETERS, so a single LLM-authored query becomes a reusable, paged
 * artifact (the caller supplies `limit` / `offset` values at run/emit time).
 *
 * Behaviour:
 *  - If the select does NOT already constrain `limit`, a `param` expr named
 *    `opts.limitParam` (default `'limit'`) is added.
 *  - If the select does NOT already constrain `offset`, a `param` expr named
 *    `opts.offsetParam` (default `'offset'`) is added.
 *  - Each is independent: a query that already pins `limit` (literal or param)
 *    but not `offset` only gains an `offset` param.
 *
 * The transform is IDEMPOTENT — running it twice yields a structurally
 * identical result, because an already-present `limit` / `offset` (whether a
 * literal number or a param this transform added) is left untouched.
 *
 * It never mutates its argument: a `SelectQuery` in produces a fresh
 * `SelectQuery`; a `SelectDef` in produces a fresh `SelectDef`.
 */
import type { ParamExprDef, SelectDef } from '../schema';
import { SelectQuery } from '../queries/index';

/** Options controlling the auto-paginate transform. */
export interface AutoPaginateOptions {
  /** Param name to bind `limit` to when absent. Default `'limit'`. */
  limitParam?: string;
  /** Param name to bind `offset` to when absent. Default `'offset'`. */
  offsetParam?: string;
  /** Add a `limit` param when none is present. Default `true`. */
  limit?: boolean;
  /** Add an `offset` param when none is present. Default `true`. */
  offset?: boolean;
  // NOTE: `includeTotal` is no longer a build-time pagination option — it is an
  // EXECUTION-time option. A paged caller pairs it with pagination by passing
  // `includeTotal: true` to `engine.run` / `engine.toSQL`.
}

/** A `ParamExprDef` for the given name. */
function paramBound(name: string): ParamExprDef {
  return { kind: 'param', name };
}

/**
 * Decide the new `limit` / `offset` bounds, preserving any already present.
 * Returns the (possibly unchanged) bound values plus whether each was added.
 */
function resolveBounds(
  currentLimit: number | ParamExprDef | undefined,
  currentOffset: number | ParamExprDef | undefined,
  opts: AutoPaginateOptions,
): { limit: number | ParamExprDef | undefined; offset: number | ParamExprDef | undefined } {
  const addLimit = opts.limit ?? true;
  const addOffset = opts.offset ?? true;
  const limitName = opts.limitParam ?? 'limit';
  const offsetName = opts.offsetParam ?? 'offset';
  return {
    limit: currentLimit === undefined && addLimit ? paramBound(limitName) : currentLimit,
    offset: currentOffset === undefined && addOffset ? paramBound(offsetName) : currentOffset,
  };
}

/**
 * Bind a SELECT's pagination to named bind params: add a `limit` / `offset`
 * param (per `opts`) wherever the query does not already constrain that bound.
 * Idempotent and non-mutating — returns a fresh `SelectQuery` / `SelectDef`
 * mirroring the input shape.
 */
export function autoPaginate(select: SelectQuery, opts?: AutoPaginateOptions): SelectQuery;
export function autoPaginate(select: SelectDef, opts?: AutoPaginateOptions): SelectDef;
export function autoPaginate(
  select: SelectQuery | SelectDef,
  opts?: AutoPaginateOptions,
): SelectQuery | SelectDef;
export function autoPaginate(
  select: SelectQuery | SelectDef,
  opts: AutoPaginateOptions = {},
): SelectQuery | SelectDef {
  if (select instanceof SelectQuery) {
    // Clone first, then reconstruct with the (possibly added) bounds. The
    // clone's children are fresh, so reusing them in the new instance is safe.
    const c = select.clone();
    const { limit, offset } = resolveBounds(c.limit, c.offset, opts);
    return new SelectQuery(
      c.distinct,
      c.fields,
      c.from,
      c.joins,
      c.where,
      c.groupBy,
      c.having,
      c.order,
      limit,
      offset,
    );
  }

  // Plain JSON def: shallow-copy and set the bounds (never mutate the input).
  const { limit, offset } = resolveBounds(select.limit, select.offset, opts);
  const out: SelectDef = { ...select };
  if (limit === undefined) delete out.limit;
  else out.limit = limit;
  if (offset === undefined) delete out.offset;
  else out.offset = offset;
  return out;
}
