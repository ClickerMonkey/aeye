/**
 * Cost — the bottom-up row / byte estimate of an expression or query, plus
 * the optional `CostConstraints` the validation phase enforces (algorithm
 * "(e) Cost estimation" in the plan).
 *
 * The model is deliberately simple and explainable (it drives LLM-facing
 * guard-rails, not a real query planner):
 *
 *   - A base type scan starts at `rows = Type.count`, `bytes = rows *
 *     Type.bytes`.
 *   - An equality / range WHERE predicate either matches a `Type.indexes`
 *     entry (reducing `rows` to that index's distinct `count`; a UNIQUE index
 *     ⇒ 1) or applies a fixed selectivity (`EQ_SELECTIVITY` ≈ 0.33 for
 *     equality, `RANGE_SELECTIVITY` ≈ 0.5 for ranges), never below 1 row.
 *   - A relation join multiplies `rows` by the relation's `count`
 *     (one-to-one ⇒ ×1, fan-out ⇒ ×count).
 *   - GROUP BY collapses to `distinct(keys)` (a key index's `count`, else
 *     `√rows`); a bare aggregate collapses to a single row while still
 *     tracking the scanned rows for the byte estimate.
 *   - LIMIT caps the OUTPUT rows (not the scanned rows).
 *   - A semantic / text-search predicate adds a large per-row penalty to the
 *     byte estimate (a proxy for the embedding / scan work it implies).
 *
 * Everything is plain arithmetic over a `{ rows, bytes }` record — no engine
 * state, no `any`, no casts.
 */
import type { ResolvedType } from './resolved-type';
import { asFieldType } from './resolved-type';
import type { Problems } from './problem';
import type { QueryEngine } from './engine';
import type { Expr } from './expr';
import type { FieldRefExpr } from './exprs/field-ref';
import type { JsonValue, SortSelectionDef } from './schema';

/** The estimated size of an intermediate / final result set. */
export interface Cost {
  /** Estimated number of rows produced (or scanned, per context). */
  rows: number;
  /** Estimated total bytes produced (≈ rows × per-row bytes + penalties). */
  bytes: number;
}

/**
 * The context threaded through a cost walk — the analogue of `SqlContext`
 * (emit) and `RuntimeContext` (run) for the cost phase. It carries the engine
 * plus the OPTIONAL execution-time selections a query is costed WITH, so a
 * `filters` / `sorter` placeholder can weave the real supplied predicate / sort
 * into the estimate instead of contributing nothing:
 *  - `filters` — the execution-time filter PREDICATE per source name (already
 *    parsed to an `Expr`), so a `FiltersExpr` for that source costs / selects /
 *    penalizes exactly as the supplied predicate would (a subquery inside it
 *    then jacks the cost up, as it should). Absent ⇒ the placeholder is neutral.
 *  - `sort` — the execution-time sort SELECTION, so a `SorterExpr` costs the
 *    catalog entries actually chosen (else its `defaultSort`, else — as a
 *    worst case — its whole catalog).
 */
export interface CostContext {
  /** The engine the query is costed against (type/backing/query lookups). */
  readonly engine: QueryEngine;
  /** Execution-time filter predicates by source name (parsed), woven into cost. */
  readonly filters?: ReadonlyMap<string, Expr>;
  /** Execution-time sort selection, weaving the chosen `sorter` catalog entries. */
  readonly sort?: readonly SortSelectionDef[];
  /**
   * Execution-time param VALUES by name — lets a param-bound `LIMIT` / `OFFSET`
   * resolve to a concrete cap when computing the OUTPUT cost (see
   * `Query.outputCost`). Absent params leave the bound uncapped.
   */
  readonly params?: Readonly<Record<string, JsonValue>>;
}

/**
 * A shallow "index-scannable" reading of a single predicate: the column
 * field-ref it constrains to a bounded set of point values, plus the `arity`
 * of that set (`col = v` ⇒ 1; `col IN (a, b, c)` ⇒ 3). Drives index-prefix
 * matching in the cost model — `arity` scales the matched distinct-row bound
 * (an `IN` of k values fans a unique-index lookup to ~k rows). A predicate that
 * is not a column-to-values binding reports `undefined`.
 */
export interface IndexProbe {
  /** The column field-ref bound by this predicate. */
  readonly ref: FieldRefExpr;
  /** How many candidate point values the column is bound to (`=` ⇒ 1). */
  readonly arity: number;
}

/** One entry of an {@link Affected} breakdown: a Type and the rows a statement mutates on it. */
export interface AffectedType {
  /** The affected Type's name. */
  readonly type: string;
  /** Estimated rows this statement mutates on that Type. */
  readonly rows: number;
}

/**
 * The rows a statement MUTATES — a total plus a per-Type breakdown. A read-only
 * query is `{ rows: 0, types: [] }`; an INSERT / UPDATE / DELETE names its one
 * target Type; a CTE with several data-modifying entries SUMS same-Type rows
 * into one entry each (gross rows touched). `rows` always equals the sum of
 * `types[*].rows`.
 */
export interface Affected {
  /** Total estimated rows mutated across every affected Type. */
  readonly rows: number;
  /** Per-Type breakdown, one entry per mutated Type (zero-row Types omitted). */
  readonly types: readonly AffectedType[];
}

/** Merge several {@link Affected} results, summing rows per Type (first-seen order). */
export function mergeAffected(parts: readonly Affected[]): Affected {
  const byType = new Map<string, number>();
  for (const part of parts) {
    for (const t of part.types) byType.set(t.type, (byType.get(t.type) ?? 0) + t.rows);
  }
  const types = [...byType].map(([type, rows]) => ({ type, rows }));
  return { rows: types.reduce((sum, t) => sum + t.rows, 0), types };
}

/** Build an {@link Affected} for a single target Type (omitting a zero-row breakdown). */
export function affectedOne(type: string, rows: number): Affected {
  return rows > 0 ? { rows, types: [{ type, rows }] } : { rows: 0, types: [] };
}

/** The no-mutation result (a read-only query). */
export const AFFECTED_NONE: Affected = { rows: 0, types: [] };

/** Optional caps the validation phase enforces against an estimated `Cost`. */
export interface CostConstraints {
  /** Maximum allowed estimated output rows. */
  maxRows?: number;
  /** Maximum allowed estimated output bytes. */
  maxBytes?: number;
}

/** The empty cost (a no-op contribution). */
export const ZERO_COST: Cost = { rows: 0, bytes: 0 };

/**
 * A `changes` value of `0` — the data ALWAYS changes (a query over it is stale
 * immediately). The dominating element when folding change intervals.
 */
export const ALWAYS_CHANGES = 0;
/**
 * A `changes` value of `-1` — the data NEVER changes (immutable). The identity
 * when folding: it never makes a query result go stale. Any negative value is
 * treated as "never".
 */
export const NEVER_CHANGES = -1;

/**
 * Fold two `changes` intervals (ms between changes) into the effective interval
 * of reading BOTH: `0` (always-changing) dominates; a negative (never-changing)
 * is the identity; otherwise the FASTEST (smallest positive) rate wins — a
 * result is stale as soon as its quickest-changing input changes.
 */
export function foldChanges(a: number, b: number): number {
  if (a === ALWAYS_CHANGES || b === ALWAYS_CHANGES) return ALWAYS_CHANGES;
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** Fixed selectivity of a non-indexed equality predicate (`col = x`). */
export const EQ_SELECTIVITY = 0.33;
/** Fixed selectivity of a non-indexed range predicate (`col < x`, BETWEEN). */
export const RANGE_SELECTIVITY = 0.5;
/** Fixed selectivity of a non-indexed membership predicate (`col IN (...)`). */
export const IN_SELECTIVITY = 0.5;

/** Per-row byte penalty for a semantic-similarity predicate (embedding work). */
export const SEMANTIC_ROW_PENALTY = 1000;
/** Per-row byte penalty for a full-text-search predicate (scan work). */
export const TEXT_SEARCH_ROW_PENALTY = 100;

/** Sum two costs component-wise. */
export function addCost(a: Cost, b: Cost): Cost {
  return { rows: a.rows + b.rows, bytes: a.bytes + b.bytes };
}

/** The component-wise maximum of two costs (e.g. INTERSECT bounds). */
export function maxCost(a: Cost, b: Cost): Cost {
  return { rows: Math.max(a.rows, b.rows), bytes: Math.max(a.bytes, b.bytes) };
}

/** Scale a cost's rows (and proportionally its bytes) by `factor`, floored at 1 row. */
export function scaleRows(cost: Cost, factor: number): Cost {
  const rows = Math.max(1, cost.rows * factor);
  const perRow = cost.rows > 0 ? cost.bytes / cost.rows : 0;
  return { rows, bytes: rows * perRow };
}

/** Build a cost for `rows` rows of `perRowBytes` each. */
export function rowsCost(rows: number, perRowBytes: number): Cost {
  const r = Math.max(0, rows);
  return { rows: r, bytes: r * Math.max(0, perRowBytes) };
}

/** Estimated bytes of a single value of a resolved type (0 for a type). */
export function bytesOfResolved(rt: ResolvedType): number {
  // A resolved FIELD prefers its own (possibly authored / registry-defaulted)
  // byte size; anything else falls back to the field type's avgBytes.
  if (rt.kind === 'field') return rt.field.bytes();
  return asFieldType(rt)?.avgBytes() ?? 0;
}

/**
 * Push `cost.rows-exceeded` / `cost.bytes-exceeded` problems when an estimate
 * blows past a cap. The message always carries BOTH the estimate and the cap
 * so an LLM (or developer) can see how far over the query is.
 */
export function reportCostProblems(cost: Cost, constraints: CostConstraints, p: Problems): void {
  if (constraints.maxRows !== undefined && cost.rows > constraints.maxRows) {
    p.error(
      'cost.rows-exceeded',
      `Estimated ${Math.round(cost.rows)} rows exceed the maximum of ${constraints.maxRows} rows.`,
    );
  }
  if (constraints.maxBytes !== undefined && cost.bytes > constraints.maxBytes) {
    p.error(
      'cost.bytes-exceeded',
      `Estimated ${Math.round(cost.bytes)} bytes exceed the maximum of ${constraints.maxBytes} bytes.`,
    );
  }
}
