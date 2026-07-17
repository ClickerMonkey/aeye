/**
 * Shared query cost-estimation helpers (algorithm "(e)" of the plan), used by
 * SELECT / UPDATE / DELETE which all scan a base Type under WHERE predicates.
 *
 * The estimate is intentionally coarse and explainable — and, crucially, it no
 * longer SWITCHES on concrete expr classes. Each predicate reports its own
 * {@link Expr.selectivity}, {@link Expr.scanRowPenalty}, {@link Expr.indexProbe}
 * and {@link Expr.conjuncts}; this module just COMPOSES those:
 *  - a base scan starts at the Type's `count` rows;
 *  - a WHERE is flattened to its AND-conjuncts, each of which either matches an
 *    index prefix (collapsing rows to the index's distinct `count`, scaled by an
 *    `IN`'s arity) or applies its own fixed selectivity, never below 1;
 *  - a predicate subtree's per-scanned-row penalties (semantic / text-search)
 *    add a byte cost proportional to the scanned rows.
 */
import type { Expr } from '../expr';
import type { FieldRefExpr } from '../exprs/field-ref';
import type { Type } from '../type';
import type { QueryScope } from '../scope';
import type { JoinSpec } from '../backing';
import { joinAlias } from '../backing';
import { RelationFieldType } from '../field-types/index';
import { exprDigest } from '../index-spec';
import { type Cost, type CostContext, type IndexProbe, ZERO_COST, addCost } from '../cost';

/** A plain type-scan cost: every row, at the Type's per-row byte estimate. */
export function scanCost(type: Type): Cost {
  return { rows: type.count, bytes: type.count * type.bytes };
}

/** Never let an estimate drop below a single row. */
function floor1(n: number): number {
  return Math.max(1, n);
}

/**
 * Every AND-conjunct of a WHERE, flattened across nesting — so
 * `[and(and(a, b), c)]` yields `[a, b, c]`. Each predicate reports its own
 * conjuncts ({@link Expr.conjuncts}); a leaf is just itself, and a `filters`
 * placeholder expands to its execution-time predicate's conjuncts (or none).
 */
function conjunctsOf(ctx: CostContext, scope: QueryScope, where: readonly Expr[]): Expr[] {
  return where.flatMap((w) => [...w.conjuncts(ctx, scope)]);
}

/**
 * The shallow index-probes of a WHERE: each conjunct that binds a column to a
 * bounded value set (`col = v`, `col IN (…)`) contributes one probe. Drives
 * index-prefix matching without inspecting operand internals.
 */
function probesOf(conjuncts: readonly Expr[]): IndexProbe[] {
  const probes: IndexProbe[] = [];
  for (const c of conjuncts) {
    const probe = c.indexProbe();
    if (probe) probes.push(probe);
  }
  return probes;
}

/** The canonical digests of every part of every index on `type` (for probe matching). */
function indexPartDigests(type: Type): Set<string> {
  const digests = new Set<string>();
  for (const idx of type.indexes) for (const part of idx.parts) digests.add(part.digest);
  return digests;
}

/**
 * The lowest achievable row count across all of `type`'s composite indexes
 * given the equality/`IN`-constrained probe `refs`: the MIN over indexes of each
 * index's longest-matched-prefix `count`. `undefined` when no index prefix
 * matches.
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
 * The multiplier an index-covered `IN (…)` applies to the matched distinct-row
 * bound: a `col IN (a, b, c)` fans a unique-index lookup to ~3 rows. Only probes
 * whose column actually participates in an index part (and whose `arity > 1`)
 * scale the bound; a plain `=` (arity 1) leaves it unchanged.
 */
function indexArityFactor(partDigests: Set<string>, probes: readonly IndexProbe[]): number {
  let factor = 1;
  for (const pr of probes) {
    if (pr.arity > 1 && partDigests.has(exprDigest(pr.ref.toJSON()))) factor *= pr.arity;
  }
  return factor;
}

/**
 * Apply WHERE predicates to a base scan cost: reduce rows via index prefix /
 * per-conjunct selectivity, then size the result at `perRowBytes` plus any
 * per-scanned-row penalty the predicates imply.
 *
 * An index-covered point-probe (its column in a matched index part) is folded
 * into the prefix reduction and does NOT also apply its own selectivity (no
 * double-counting); a probe whose column is not indexed still applies its
 * selectivity normally.
 */
export function applyWhere(
  ctx: CostContext,
  scope: QueryScope,
  base: Cost,
  type: Type,
  where: readonly Expr[],
  perRowBytes: number,
): Cost {
  const conjuncts = conjunctsOf(ctx, scope, where);
  const rows = reduceRows(ctx, scope, type, base.rows, conjuncts);
  const penalty = conjuncts.reduce((sum, c) => sum + c.totalScanRowPenalty(), 0) * base.rows;
  return { rows, bytes: rows * perRowBytes + penalty };
}

/**
 * Reduce a base row count by an implicit-AND set of `conjuncts`: an index prefix
 * (equality / `IN` probes) bounds the equality-constrained rows, and every other
 * conjunct applies its own selectivity. An index-covered point-probe is folded
 * into the prefix reduction and does NOT also apply its selectivity.
 */
function reduceRows(ctx: CostContext, scope: QueryScope, type: Type, baseRows: number, conjuncts: readonly Expr[]): number {
  const probes = probesOf(conjuncts);
  const partDigests = indexPartDigests(type);
  const reduction = bestPrefixReduction(type, probes.map((p) => p.ref));

  let rows = baseRows;
  for (const c of conjuncts) {
    const probe = c.indexProbe();
    // A probe whose column participates in the MATCHED index prefix is accounted
    // for by the prefix reduction below — skip its selectivity to avoid
    // double-counting. A probe on a column that is only a NON-leading part (no
    // usable prefix, so `reduction` is undefined) still applies its selectivity.
    if (reduction !== undefined && probe && partDigests.has(exprDigest(probe.ref.toJSON()))) continue;
    rows = floor1(rows * c.selectivity(ctx, scope));
  }
  // An index prefix bounds the equality/IN-constrained rows from above.
  if (reduction !== undefined) rows = Math.min(rows, floor1(reduction * indexArityFactor(partDigests, probes)));
  return rows;
}

/**
 * Estimate how many rows of `type` a WHERE MATCHES — the row count an
 * UPDATE / DELETE affects. Like {@link applyWhere}'s reduction, but OR-aware:
 * a disjunction is estimated as the UNION (index-merge) of its branches via
 * inclusion-exclusion (`1 − Π(1 − branchFraction)`), each branch itself
 * estimated recursively (so nested AND/OR + per-branch index use all count).
 * An empty WHERE matches every row.
 */
export function matchedRows(ctx: CostContext, scope: QueryScope, type: Type, where: readonly Expr[]): number {
  return andMatch(ctx, scope, type, type.count, conjunctsOf(ctx, scope, where));
}

/** Rows surviving an implicit-AND of `conjuncts`: index/selectivity over the non-OR ones, then each OR's union fraction. */
function andMatch(ctx: CostContext, scope: QueryScope, type: Type, base: number, conjuncts: readonly Expr[]): number {
  const ors = conjuncts.filter((c) => c.orOperands() !== undefined);
  const rest = conjuncts.filter((c) => c.orOperands() === undefined);
  let rows = reduceRows(ctx, scope, type, base, rest);
  for (const or of ors) rows = floor1(rows * orFraction(ctx, scope, type, or));
  return rows;
}

/** The fraction of rows an OR keeps: `1 − Π(1 − branchFraction)`, each branch estimated on its own. */
function orFraction(ctx: CostContext, scope: QueryScope, type: Type, orExpr: Expr): number {
  let none = 1;
  for (const operand of orExpr.orOperands()!) {
    const branch = andMatch(ctx, scope, type, type.count, operand.conjuncts(ctx, scope));
    none *= 1 - branch / type.count;
  }
  return 1 - none;
}

/**
 * Estimate the distinct row count for a GROUP BY: a single field-ref key backed
 * by an index uses that index's `count`; otherwise `√rows` (rounded up) — a
 * standard rough distinct-value heuristic.
 */
export function distinctEstimate(
  type: Type,
  groupBy: readonly Expr[],
  scannedRows: number,
): number {
  if (groupBy.length === 1) {
    const ref = groupBy[0]!.fieldRef();
    if (ref) {
      // A single key backed by an index uses that index's leading-part count.
      const reduction = bestPrefixReduction(type, [ref]);
      if (reduction !== undefined) return Math.max(1, reduction);
    }
  }
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, scannedRows))));
}

/**
 * The per-entry byte size to use for an INDEX-ONLY (covered) scan, or
 * `undefined` when the query cannot be answered from an index alone.
 *
 * A covered scan reads index entries instead of whole rows, so it is cheaper.
 * It applies when EVERY column referenced in the projection (`fields`) and the
 * `where` is a part of one index that the WHERE also PROBES, and nothing reaches
 * beyond that index — no correlated / subquery fan-out and no reference to a
 * source other than the scanned one (the caller has already excluded joins /
 * grouping / distinct / aggregates). The returned size is that index's
 * {@link Index.bytes}.
 */
export function coveredScanBytes(
  ctx: CostContext,
  scope: QueryScope,
  fromType: Type,
  fromAlias: string,
  fields: readonly Expr[],
  where: readonly Expr[],
): number | undefined {
  const refs: FieldRefExpr[] = [];
  let simple = true;
  const collect = (e: Expr): void => {
    e.walk((n) => {
      // A fan-out (subquery / EXISTS) reads data beyond any index ⇒ not covered.
      if (n.cost(ctx, scope).rows > 0) simple = false;
      const r = n.fieldRef();
      if (!r) return;
      if (r.source !== fromAlias) simple = false;
      else refs.push(r);
    });
  };
  for (const e of fields) collect(e);
  for (const w of where) collect(w);
  if (!simple || refs.length === 0) return undefined;

  const refDigests = new Set(refs.map((r) => exprDigest(r.toJSON())));
  const probes = probesOf(conjunctsOf(ctx, scope, where));
  if (probes.length === 0) return undefined;
  for (const idx of fromType.indexes) {
    const partDigests = indexPartDigestsOf(idx.parts);
    const allColumnsIndexed = [...refDigests].every((d) => partDigests.has(d));
    const whereProbesIndex = probes.some((p) => partDigests.has(exprDigest(p.ref.toJSON())));
    if (allColumnsIndexed && whereProbesIndex) return idx.bytes(fromType);
  }
  return undefined;
}

/** The digests of a single index's parts (a covered-scan helper). */
function indexPartDigestsOf(parts: readonly { digest: string }[]): Set<string> {
  return new Set(parts.map((p) => p.digest));
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
  ctx: CostContext,
  scope: QueryScope,
  fieldExprs: readonly Expr[],
  fromType: Type,
  outputRows: number,
): Cost {
  const engine = ctx.engine;
  let cost: Cost = ZERO_COST;

  // Row-level security on the FROM type: a predicate is per-scan work; a static
  // allow/deny (`true`/`false`) or no-op adds nothing.
  const rlsPred = engine.backing(fromType.name)?.rls()?.expr?.(fromType.name);
  if (rlsPred !== undefined && typeof rlsPred !== 'boolean') {
    cost = addCost(cost, rlsPred.cost(ctx, scope));
  }

  // Backed-field hidden joins, deduped by their deterministic alias.
  const counted = new Set<string>();
  for (const expr of fieldExprs) {
    expr.walk((e) => {
      const ref = e.fieldRef();
      if (!ref) return;
      const bound = scope.lookup(ref.source);
      if (!bound || bound.kind !== 'type') return;
      const names = engine.fieldBacking(bound.type.name, ref.field)?.joins;
      if (!names) return;
      for (const name of names) {
        const alias = joinAlias(ref.source, name);
        if (counted.has(alias)) continue;
        counted.add(alias);
        const jb = engine.joinBacking(bound.type.name, name);
        if (!jb?.expr) continue;
        cost = addCost(cost, joinSpecCost(ctx, scope, ref.source, jb.expr(ref.source), outputRows));
      }
    });
  }
  return cost;
}

/** The cost a single backed `JoinSpec` contributes (per its shape — see `backingCost`). */
function joinSpecCost(
  ctx: CostContext,
  scope: QueryScope,
  outer: string,
  spec: JoinSpec,
  outputRows: number,
): Cost {
  const engine = ctx.engine;
  if (spec.kind === 'lateral') {
    // A LATERAL is a correlated subquery: it runs once per outer row.
    const inner = engine.coerceQuery(spec.query(outer)).cost(ctx, scope.child());
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
