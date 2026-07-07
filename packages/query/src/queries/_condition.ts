/**
 * Shared validation for TOP-LEVEL condition clauses — a query's WHERE / HAVING
 * predicates, a join's `and` predicate, and a DML (UPDATE / DELETE) WHERE.
 *
 * Each such predicate must resolve to a boolean, exactly as `logical`'s operands
 * and `case`'s `when` clauses already require of their sub-conditions. This
 * closes the gap where a bare non-boolean predicate (a numeric field-ref, a
 * literal, an arithmetic `binary`, …) slipped through at the clause boundary.
 *
 * A bare `param` predicate is EXEMPT (its type is inferred from use, mirroring
 * `LogicalExpr.validateWalk`), so a standalone `:flag` param stays valid.
 */
import type { Expr } from '../expr';
import type { ResolvedType } from '../resolved-type';
import type { Problems } from '../problem';
import { ParamExpr } from '../exprs/param';
import { categoryOf } from '../exprs/_shared';

/**
 * Flag a condition predicate that does not resolve to a boolean. `rt` is the
 * predicate's already-resolved type; the problem is recorded at the CURRENT
 * path, so the caller should be positioned on the offending predicate. A bare
 * `param` is exempt (type inferred), matching `logical`'s exemption.
 */
export function checkBoolCondition(expr: Expr, rt: ResolvedType, p: Problems): void {
  // A standalone param has no observed type yet — leave it to be inferred.
  if (expr instanceof ParamExpr) return;
  if (categoryOf(rt) !== 'bool') {
    p.error('condition.non-bool', `Expected a boolean condition; got ${categoryOf(rt) ?? 'a value'}.`);
  }
}
