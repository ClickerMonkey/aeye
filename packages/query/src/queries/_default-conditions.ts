/**
 * Default-condition (soft-scope) detection + injection, shared by SELECT /
 * UPDATE / DELETE.
 *
 * A Type's `TypeBacking.defaultConditions` are archived-style DEFAULT SCOPES:
 * while ACTIVE, each condition's `where` predicate is ANDed into the WHERE of a
 * row-filtering op — per bound occurrence of the Type. A condition LIFTS for a
 * given bound source the moment the query references one of its `without` fields
 * (on THAT source) in a CONDITION position — the query's `where` / `having` or a
 * JOIN's `and`. References in SELECT items / ORDER BY / GROUP BY do NOT lift it.
 *
 * The detector scans ONLY the condition clauses (never all of `walkExprs`).
 * Because `Expr.walk` does NOT descend into subquery-wrapping exprs (they carry
 * their inner query as raw JSON, not child exprs), a correlated inner reference
 * never lifts an OUTER source's condition — each query level decides from its own
 * clauses, and each bound alias (incl. a self-joined alias) is decided
 * INDEPENDENTLY by references on ITS alias.
 */
import type { QueryEngine } from '../engine';
import type { Expr } from '../expr';
import { FieldRefExpr } from '../exprs/field-ref';
import {
  defaultConditionOps,
  resolveDefaultConditionSql,
  resolveDefaultConditionRun,
  type DefaultCondition,
  type DefaultConditionOp,
} from '../backing';
import { defaultConditionWithout } from '../default-conditions';
import { SqlText } from '../sql/emit';
import type { SqlContext } from '../sql/emit';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { QueryJoin } from './join';

/** A bound occurrence of a Type in a query: the alias it is bound under + its Type name. */
export interface BoundTypeSource {
  /** The alias the Type is bound under (a FROM alias or a join hop's target alias). */
  readonly alias: string;
  /** The bound Type's name (drives the `engine.defaultConditions` lookup). */
  readonly typeName: string;
}

/** One ACTIVE (non-suppressed, op-matching) default condition for a bound source alias. */
export interface ActiveDefaultCondition {
  /** The bound alias the condition scopes (its predicate references this alias). */
  readonly alias: string;
  /** The condition whose `where` is ANDed in for this alias. */
  readonly cond: DefaultCondition;
}

/**
 * The CONDITION clauses of a query — its `where` + `having` predicates and each
 * join's `and`. These (and ONLY these) decide which default conditions LIFT; a
 * reference in a select field / GROUP BY / ORDER BY never suppresses one. Shared
 * by SELECT (with `having`) and UPDATE / DELETE (empty `having`).
 */
export function conditionClauses(
  where: readonly Expr[],
  having: readonly Expr[],
  joins: readonly QueryJoin[],
): Expr[] {
  const out: Expr[] = [...where, ...having];
  for (const j of joins) if (j.and) out.push(j.and);
  return out;
}

/**
 * Collect, per source ALIAS, the set of field names referenced in a CONDITION
 * position across `clauses` (a query's WHERE / HAVING / JOIN `and`s). Used to
 * decide which default conditions LIFT. `Expr.walk` stops at subquery
 * boundaries, so an inner correlated reference is invisible here (see the module
 * note).
 */
export function conditionFieldRefs(clauses: readonly Expr[]): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  for (const clause of clauses) {
    clause.walk((e) => {
      if (!(e instanceof FieldRefExpr)) return;
      let set = refs.get(e.source);
      if (!set) {
        set = new Set<string>();
        refs.set(e.source, set);
      }
      set.add(e.field);
    });
  }
  return refs;
}

/**
 * The default conditions ACTIVE for `op` across `sources`: every declared
 * condition whose `ops` include `op` and whose `without` fields are NOT
 * referenced (on that source's alias) in `condRefs`. Each bound occurrence is
 * decided INDEPENDENTLY by references on ITS alias.
 */
export function activeDefaultConditions(
  engine: QueryEngine,
  sources: readonly BoundTypeSource[],
  condRefs: Map<string, Set<string>>,
  op: DefaultConditionOp,
): ActiveDefaultCondition[] {
  const active: ActiveDefaultCondition[] = [];
  for (const { alias, typeName } of sources) {
    const conds = engine.defaultConditions(typeName);
    if (conds.length === 0) continue;
    const referenced = condRefs.get(alias);
    for (const cond of conds) {
      if (!defaultConditionOps(cond).includes(op)) continue;
      const without = defaultConditionWithout(cond, alias);
      // SUPPRESSED when any `without` field is referenced on this alias.
      if (referenced && without.some((f) => referenced.has(f))) continue;
      active.push({ alias, cond });
    }
  }
  return active;
}

/**
 * SQL predicates for the ACTIVE default conditions, ready to AND into a
 * statement's WHERE. A statically-denied condition (`where` ⇒ `false`) emits
 * `FALSE` (no rows while active); an `allow` / `noop` result contributes nothing.
 */
export function defaultConditionPredicatesSql(
  active: readonly ActiveDefaultCondition[],
  ctx: SqlContext,
): SqlText[] {
  const preds: SqlText[] = [];
  for (const { alias, cond } of active) {
    const acc = resolveDefaultConditionSql(cond, alias, ctx);
    if (acc.kind === 'predicate') preds.push(acc.sql);
    else if (acc.kind === 'deny') preds.push(SqlText.raw('FALSE'));
    // 'allow' / 'noop' ⇒ nothing to AND in.
  }
  return preds;
}

/**
 * Whether `row` PASSES every ACTIVE default condition — the in-memory analogue
 * of the SQL WHERE injection. A condition that resolves to a denied `visible`
 * (including a static `false`) drops the row; an `allow` / `noop` passes.
 */
export async function rowPassesDefaultConditions(
  active: readonly ActiveDefaultCondition[],
  row: SourceRow,
  ctx: RuntimeContext,
): Promise<boolean> {
  for (const { alias, cond } of active) {
    const acc = await resolveDefaultConditionRun(cond, alias, row, ctx);
    if (acc.kind === 'visible' && !acc.visible) return false;
  }
  return true;
}
