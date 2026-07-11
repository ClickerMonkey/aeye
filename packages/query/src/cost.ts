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

/** The estimated size of an intermediate / final result set. */
export interface Cost {
  /** Estimated number of rows produced (or scanned, per context). */
  rows: number;
  /** Estimated total bytes produced (≈ rows × per-row bytes + penalties). */
  bytes: number;
}

/** Optional caps the validation phase enforces against an estimated `Cost`. */
export interface CostConstraints {
  /** Maximum allowed estimated output rows. */
  maxRows?: number;
  /** Maximum allowed estimated output bytes. */
  maxBytes?: number;
}

/** The empty cost (a no-op contribution). */
export const ZERO_COST: Cost = { rows: 0, bytes: 0 };

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
