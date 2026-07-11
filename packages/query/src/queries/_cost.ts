/**
 * Shared query cost-estimation helpers (algorithm "(e)" of the plan), used by
 * SELECT / UPDATE / DELETE which all scan a base Type under WHERE predicates.
 *
 * The estimate is intentionally coarse and explainable:
 *  - a base scan starts at the Type's `count` rows;
 *  - an equality predicate on an indexed field collapses to the index's
 *    distinct `count` (UNIQUE ⇒ 1); a non-indexed predicate applies a fixed
 *    selectivity (equality ≈ 0.33, range / membership ≈ 0.5), never below 1;
 *  - a semantic / text-search predicate adds a per-scanned-row byte penalty.
 */
import type { Expr } from '../expr';
import type { Type } from '../type';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { JoinSpec } from '../backing';
import { joinAlias } from '../backing';
import {
  ComparisonExpr,
  BetweenExpr,
  InExpr,
  IsNullExpr,
  FieldRefExpr,
  SemanticExpr,
  TextSearchExpr,
} from '../exprs/index';
import { RelationFieldType } from '../field-types/index';
import {
  type Cost,
  ZERO_COST,
  addCost,
  EQ_SELECTIVITY,
  RANGE_SELECTIVITY,
  IN_SELECTIVITY,
  SEMANTIC_ROW_PENALTY,
  TEXT_SEARCH_ROW_PENALTY,
} from '../cost';

/** A plain type-scan cost: every row, at the Type's per-row byte estimate. */
export function scanCost(type: Type): Cost {
  return { rows: type.count, bytes: type.count * type.bytes };
}

/** Never let an estimate drop below a single row. */
function floor1(n: number): number {
  return Math.max(1, n);
}

/** The field-ref operand of a comparison (whichever side is one), if any. */
function fieldRefSide(cmp: ComparisonExpr): FieldRefExpr | undefined {
  if (cmp.left instanceof FieldRefExpr) return cmp.left;
  if (cmp.right instanceof FieldRefExpr) return cmp.right;
  return undefined;
}

/** The field-refs constrained by an equality (`=`) predicate in `where`. */
function equalityFieldRefs(where: readonly Expr[]): FieldRefExpr[] {
  const refs: FieldRefExpr[] = [];
  for (const pred of where) {
    if (pred instanceof ComparisonExpr && pred.op === '=') {
      const fr = fieldRefSide(pred);
      if (fr) refs.push(fr);
    }
  }
  return refs;
}

/**
 * The lowest achievable row count across all of `type`'s composite indexes
 * given the equality-constrained `refs`: the MIN over indexes of each index's
 * longest-matched-prefix `count`. `undefined` when no index prefix matches.
 */
function bestPrefixReduction(type: Type, refs: readonly FieldRefExpr[]): number | undefined {
  if (refs.length === 0) return undefined;
  let best: number | undefined;
  for (const idx of type.indexes) {
    const r = idx.prefixReduction(refs);
    if (r === undefined) continue;
    best = best === undefined ? r : Math.min(best, r);
  }
  return best;
}

/**
 * Reduce a running row estimate by one predicate's selectivity. Equality
 * predicates whose field participates in a matched index prefix are accounted
 * for separately (`indexCovered`) and skipped here to avoid double-counting.
 */
function reducePredicate(rows: number, pred: Expr, indexCovered: boolean): number {
  if (pred instanceof ComparisonExpr) {
    if (pred.op === '=') {
      // Equality folded into the prefix reduction ⇒ no extra selectivity here.
      if (indexCovered && fieldRefSide(pred)) return rows;
      return floor1(rows * EQ_SELECTIVITY);
    }
    if (pred.op === '<' || pred.op === '<=' || pred.op === '>' || pred.op === '>=') {
      return floor1(rows * RANGE_SELECTIVITY);
    }
    // <> / like / notLike / ilike — treat like an equality selectivity.
    return floor1(rows * EQ_SELECTIVITY);
  }
  if (pred instanceof BetweenExpr) return floor1(rows * RANGE_SELECTIVITY);
  if (pred instanceof InExpr) return floor1(rows * IN_SELECTIVITY);
  if (pred instanceof IsNullExpr) return floor1(rows * EQ_SELECTIVITY);
  // logical / other predicates: no row reduction (conservative).
  return rows;
}

/** The per-scanned-row byte penalty implied by semantic / text-search nodes. */
function predicatePenalty(where: readonly Expr[]): number {
  let penalty = 0;
  for (const pred of where) {
    pred.walk((e) => {
      if (e instanceof SemanticExpr) penalty += SEMANTIC_ROW_PENALTY;
      else if (e instanceof TextSearchExpr) penalty += TEXT_SEARCH_ROW_PENALTY;
    });
  }
  return penalty;
}

/**
 * Apply WHERE predicates to a base scan cost: reduce rows via index /
 * selectivity, then size the result at `perRowBytes` plus any semantic /
 * text-search per-scanned-row penalty.
 */
export function applyWhere(
  base: Cost,
  type: Type,
  where: readonly Expr[],
  perRowBytes: number,
): Cost {
  let rows = base.rows;
  const reduction = bestPrefixReduction(type, equalityFieldRefs(where));
  const indexCovered = reduction !== undefined;
  for (const pred of where) rows = reducePredicate(rows, pred, indexCovered);
  // An index prefix bounds the equality-constrained rows from above.
  if (reduction !== undefined) rows = Math.min(rows, reduction);
  const penalty = predicatePenalty(where) * base.rows;
  return { rows, bytes: rows * perRowBytes + penalty };
}

/**
 * Estimate the distinct row count for a GROUP BY: a single field-ref key
 * backed by an index uses that index's `count`; otherwise `√rows` (rounded
 * up) — a standard rough distinct-value heuristic.
 */
export function distinctEstimate(
  type: Type,
  groupBy: readonly Expr[],
  scannedRows: number,
): number {
  if (groupBy.length === 1) {
    const key = groupBy[0]!;
    if (key instanceof FieldRefExpr) {
      // A single key backed by an index uses that index's leading-part count.
      const reduction = bestPrefixReduction(type, [key]);
      if (reduction !== undefined) return Math.max(1, reduction);
    }
  }
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, scannedRows))));
}

/**
 * A single expression's contribution to a query's cost, scaled by HOW MANY
 * TIMES the engine evaluates it. A scalar expression (`rows === 0`) is already
 * sized into the per-row byte estimate, so it adds nothing here; only an expr
 * that FANS OUT — a subquery / EXISTS / IN-subquery scan (`rows > 0`) — is real
 * extra work, counted `runs` times (once per outer row for a correlated /
 * select-position subquery, once for an uncorrelated WHERE subquery).
 */
export function fanOutCost(exprCost: Cost, runs: number): Cost {
  if (exprCost.rows <= 0) return ZERO_COST;
  const n = Math.max(0, runs);
  return { rows: exprCost.rows * n, bytes: exprCost.bytes * n };
}

/**
 * The cost of the HIDDEN joins a query's computed / backed fields inject, plus
 * the FROM Type's row-level-security predicate — real work the SQL planner adds
 * that a plain base scan misses. Assumptions (documented, since the plan is a
 * guard-rail, not a real optimizer):
 *  - A backed field's named join is counted ONCE per query even when several
 *    fields share it (the planner dedupes it to a single join) — tracked by the
 *    join's deterministic `joinAlias`.
 *  - A LATERAL backing runs once PER OUTER ROW, so its inner cost is multiplied
 *    by `outputRows` (matching a correlated subquery).
 *  - A relation backing lowers to a single shared JOIN, scanned ONCE at the
 *    target Type's size (not per outer row).
 *  - Only the structured `expr` join path is costable; opaque raw `sql` / `run`
 *    backings contribute nothing here.
 *  - RLS on the FROM Type contributes its predicate's own (usually per-row)
 *    cost once.
 */
export function backingCost(
  engine: QueryEngine,
  scope: QueryScope,
  fieldExprs: readonly Expr[],
  fromType: Type,
  outputRows: number,
): Cost {
  let cost: Cost = ZERO_COST;

  // Row-level security on the FROM type: a predicate is per-scan work; a static
  // allow/deny (`true`/`false`) or no-op adds nothing.
  const rlsPred = engine.backing(fromType.name)?.rls()?.expr?.(fromType.name);
  if (rlsPred !== undefined && typeof rlsPred !== 'boolean') {
    cost = addCost(cost, rlsPred.cost(engine, scope));
  }

  // Backed-field hidden joins, deduped by their deterministic alias.
  const counted = new Set<string>();
  for (const expr of fieldExprs) {
    expr.walk((e) => {
      if (!(e instanceof FieldRefExpr)) return;
      const bound = scope.lookup(e.source);
      if (!bound || bound.kind !== 'type') return;
      const names = engine.fieldBacking(bound.type.name, e.field)?.joins;
      if (!names) return;
      for (const name of names) {
        const alias = joinAlias(e.source, name);
        if (counted.has(alias)) continue;
        counted.add(alias);
        const jb = engine.joinBacking(bound.type.name, name);
        if (!jb?.expr) continue;
        cost = addCost(cost, joinSpecCost(engine, scope, e.source, jb.expr(e.source), outputRows));
      }
    });
  }
  return cost;
}

/** The cost a single backed `JoinSpec` contributes (per its shape — see `backingCost`). */
function joinSpecCost(
  engine: QueryEngine,
  scope: QueryScope,
  outer: string,
  spec: JoinSpec,
  outputRows: number,
): Cost {
  if (spec.kind === 'lateral') {
    // A LATERAL is a correlated subquery: it runs once per outer row.
    const inner = engine.coerceQuery(spec.query(outer)).cost(engine, scope.child());
    const runs = Math.max(0, outputRows);
    return { rows: inner.rows * runs, bytes: inner.bytes * runs };
  }
  // A relation backing is a single shared join, scanned once at the target size.
  const bound = scope.lookup(spec.source);
  /* v8 ignore next -- defensive: the backing factory targets a bound source, so the relation always resolves */
  if (!bound || bound.kind !== 'type') return ZERO_COST;
  const field = bound.type.field(spec.relation);
  /* v8 ignore next -- defensive: a relation backing names a real relation field */
  if (!field || !(field.fieldType instanceof RelationFieldType)) return ZERO_COST;
  const target = engine.type(field.fieldType.to);
  /* v8 ignore next -- defensive: a relation field always points at a registered Type */
  if (!target) return ZERO_COST;
  return { rows: target.count, bytes: target.count * target.bytes };
}
