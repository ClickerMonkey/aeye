/**
 * `autoPaginate` — a transform that binds a query's pagination to named bind
 * PARAMETERS, so a single LLM-authored query becomes a reusable, paged artifact
 * (the caller supplies `limit` / `offset` values at run/emit time).
 *
 * Behaviour:
 *  - If the query does NOT already constrain `limit`, a `param` expr named
 *    `opts.limitParam` (default `'limit'`) is added.
 *  - If the query does NOT already constrain `offset`, a `param` expr named
 *    `opts.offsetParam` (default `'offset'`) is added.
 *  - Each is independent: a query that already pins `limit` (literal or param)
 *    but not `offset` only gains an `offset` param.
 *
 * WHICH QUERIES IT PAGES — and why it refuses the rest. Pagination is a bound on
 * the ROWS a statement returns, so the transform is defined exactly on the kinds
 * that carry one:
 *  - `select` — its own LIMIT / OFFSET;
 *  - `union` / `intersect` / `except` — the SET-LEVEL LIMIT / OFFSET applied to
 *    the combined rows (never to an arm: paging an arm changes which rows the
 *    set operation compares);
 *  - `cte` — a `WITH` statement returns whatever its `final` query returns, so
 *    the bounds are bound on `final` (recursively). Paging a CTE BODY would page
 *    an intermediate result, which is a different query.
 *
 * Every other kind — `insert` / `update` / `delete` / `expr` — has no row bound
 * to bind. Asking for one used to be SILENT: the JSON branch spread whatever it
 * was given and set `limit` / `offset` on the copy, so a `cte` came back looking
 * paged while the parser dropped both keys and the statement returned every row.
 * It now throws a {@link QueryTypeError} (`paginate.unsupported-kind`) instead.
 * Use {@link canAutoPaginate} to ask first when holding an arbitrary `QueryDef`.
 *
 * The transform is IDEMPOTENT — running it twice yields a structurally identical
 * result, because an already-present `limit` / `offset` (whether a literal number
 * or a param this transform added) is left untouched.
 *
 * It never mutates its argument: a `Query` in produces a fresh `Query`; a
 * `QueryDef` in produces a fresh `QueryDef`.
 */
import type {
  CTEStatementDef,
  ParamExprDef,
  QueryDef,
  SelectDef,
  SetOperationDef,
} from '../schema';
import { QueryTypeError } from '../problem';
import { CTEStatementQuery, Query, SelectQuery, SetOperationQuery } from '../queries/index';

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

/**
 * The authored query kinds {@link autoPaginate} accepts: the ones carrying a row
 * bound of their own (`select`, the three set operations) plus `cte`, which
 * delegates to its `final` query.
 */
export type PaginatableDef = SelectDef | SetOperationDef | CTEStatementDef;

/** The parsed counterparts of {@link PaginatableDef}. */
export type PaginatableQuery = SelectQuery | SetOperationQuery | CTEStatementQuery;

/** A `ParamExprDef` for the given name. */
function paramBound(name: string): ParamExprDef {
  return { kind: 'param', name };
}

/**
 * Whether {@link autoPaginate} can page this query — true for `select`, the set
 * operations, and `cte` (whose `final` is paged in turn). Ask this when holding
 * an arbitrary `Query` / `QueryDef`; `autoPaginate` throws otherwise.
 */
export function canAutoPaginate(query: Query | QueryDef): boolean {
  const kind = query.kind;
  return kind === 'select' || kind === 'union' || kind === 'intersect' || kind === 'except' || kind === 'cte';
}

/** The refusal for a query kind with no row bound to bind. */
function unsupported(kind: string): QueryTypeError {
  return new QueryTypeError({
    path: [],
    code: 'paginate.unsupported-kind',
    message:
      `autoPaginate: cannot page a '${kind}' query — only 'select', 'union' / 'intersect' / ` +
      `'except' (set-level bounds) and 'cte' (paged through its 'final' query) carry a row ` +
      `limit / offset. Check with canAutoPaginate() first.`,
    severity: 'error',
  });
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
 * Bind a query's pagination to named bind params: add a `limit` / `offset` param
 * (per `opts`) wherever the query does not already constrain that bound. A `cte`
 * statement is paged through its `final` query. Idempotent and non-mutating —
 * returns a fresh `Query` / `QueryDef` mirroring the input shape.
 *
 * @throws {QueryTypeError} `paginate.unsupported-kind` for a query kind that has
 * no row bound (`insert` / `update` / `delete` / `expr`) — see
 * {@link canAutoPaginate}.
 */
export function autoPaginate(select: SelectQuery, opts?: AutoPaginateOptions): SelectQuery;
export function autoPaginate(select: SelectDef, opts?: AutoPaginateOptions): SelectDef;
export function autoPaginate(query: SetOperationQuery, opts?: AutoPaginateOptions): SetOperationQuery;
export function autoPaginate(query: SetOperationDef, opts?: AutoPaginateOptions): SetOperationDef;
export function autoPaginate(query: CTEStatementQuery, opts?: AutoPaginateOptions): CTEStatementQuery;
export function autoPaginate(query: CTEStatementDef, opts?: AutoPaginateOptions): CTEStatementDef;
export function autoPaginate(query: PaginatableQuery, opts?: AutoPaginateOptions): PaginatableQuery;
export function autoPaginate(query: PaginatableDef, opts?: AutoPaginateOptions): PaginatableDef;
export function autoPaginate(
  query: PaginatableQuery | PaginatableDef,
  opts?: AutoPaginateOptions,
): PaginatableQuery | PaginatableDef;
export function autoPaginate(
  query: PaginatableQuery | PaginatableDef,
  opts: AutoPaginateOptions = {},
): PaginatableQuery | PaginatableDef {
  if (query instanceof SelectQuery) {
    // Clone first, then reconstruct with the (possibly added) bounds. The
    // clone's children are fresh, so reusing them in the new instance is safe.
    const c = query.clone();
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

  if (query instanceof SetOperationQuery) {
    // SET-LEVEL bounds over the combined rows — never an arm's.
    const c = query.clone();
    const { limit, offset } = resolveBounds(c.limit, c.offset, opts);
    return new SetOperationQuery(c.kind, c.left, c.right, c.all, c.order, limit, offset);
  }

  if (query instanceof CTEStatementQuery) {
    // A `WITH` returns what its `final` returns — page THAT, not a CTE body.
    const c = query.clone();
    if (!canAutoPaginate(c.final)) throw unsupported(c.final.kind);
    return new CTEStatementQuery(c.ctes, autoPaginate(c.final as PaginatableQuery, opts));
  }

  // A parsed Query of some OTHER kind (insert / update / delete / expr) — only
  // reachable through a cast, which is exactly the call that used to produce a
  // silently unpaged result.
  if (query instanceof Query) throw unsupported(query.kind);

  // ─── Plain JSON defs ────────────────────────────────────────────────────
  if (query.kind === 'cte') {
    if (!canAutoPaginate(query.final)) throw unsupported(query.final.kind);
    return { ...query, final: autoPaginate(query.final as PaginatableDef, opts) };
  }
  if (!canAutoPaginate(query)) throw unsupported(query.kind);

  // Shallow-copy and set the bounds (never mutate the input).
  const { limit, offset } = resolveBounds(query.limit, query.offset, opts);
  const out: SelectDef | SetOperationDef = { ...query };
  if (limit === undefined) delete out.limit;
  else out.limit = limit;
  if (offset === undefined) delete out.offset;
  else out.offset = offset;
  return out;
}
