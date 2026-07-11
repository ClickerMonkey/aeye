/**
 * `defaultConditionWithout` — derive the suppression fields that LIFT a
 * {@link DefaultCondition}.
 *
 * This lives in its OWN module (not `backing.ts`) precisely so it can import the
 * concrete `FieldRefExpr` as a runtime value without breaking `backing.ts`'s
 * no-cycle, type-only invariant: `backing.ts` sits BELOW the expr classes in the
 * dependency graph, so importing an expr value there would force `field-ref` to
 * evaluate before its `Expr` base and crash. Only the higher query / describe
 * layers import THIS module, so `field-ref` never depends on it — no cycle.
 */
import type { Expr } from './expr';
import { FieldRefExpr } from './exprs/field-ref';
import type { DefaultCondition } from './backing';

/**
 * The effective `without` fields that LIFT `cond` for a source bound under
 * `alias`: its explicit `cond.without` when set, else DERIVED by building
 * `cond.where.expr(alias)` and collecting every field its `FieldRefExpr`s read
 * (an `instanceof` narrow — no cast; the factory references only `alias`, so its
 * refs are on `alias`). A `where` with no `expr` (only `sql` / `run`) and no
 * explicit `without` derives to an EMPTY list, so the condition cannot be lifted
 * — set `without` EXPLICITLY for a `sql`/`run` `where`.
 */
export function defaultConditionWithout(cond: DefaultCondition, alias: string): readonly string[] {
  if (cond.without) return cond.without;
  const built = cond.where.expr?.(alias);
  if (built === undefined || typeof built === 'boolean') return [];
  const fields = new Set<string>();
  built.walk((e: Expr) => {
    if (e instanceof FieldRefExpr) fields.add(e.field);
  });
  return [...fields];
}
