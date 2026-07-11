/**
 * Expr-availability guard helper shared by the gating OPERATOR exprs
 * (`comparison` / `between` / `in` / `is-null` / `array-op`). When such an
 * operator has a DIRECT field-ref operand, that field-ref must be gated against
 * the OPERATOR's kind (so a `field.exprs` restriction like `{ only: ['comparison']
 * }` is honored), not the standalone `'field-ref'` kind. This helper produces the
 * child `ValidateContext` that carries the operator kind ONLY when the operand is
 * a direct field-ref; every other operand is validated unchanged (so a deeply
 * nested field-ref self-gates as `'field-ref'`, never the operator's kind).
 */
import type { Expr, ValidateContext } from '../expr';
import type { ExprKind } from '../schema';
import { FieldRefExpr } from './field-ref';

/**
 * The context for validating `operand` as the direct subject of a gating
 * operator: a field-ref operand carries `fieldExprKind = kind`; anything else is
 * returned the incoming `ctx` unchanged. `relationOk` (set by the FK-comparison
 * operators — `comparison` / `in` / `between`) additionally permits a RELATION
 * field-ref operand there, since those operators run their own relation-vs-relation
 * / relation-vs-scalar checks; a gating operator that leaves it false (`is-null`,
 * `array-op`) lets a bare relation operand raise `ref.relation-not-value`.
 */
export function operandCtx(operand: Expr, kind: ExprKind, ctx: ValidateContext, relationOk = false): ValidateContext {
  if (!(operand instanceof FieldRefExpr)) return ctx;
  return relationOk ? { ...ctx, fieldExprKind: kind, relationValueOk: true } : { ...ctx, fieldExprKind: kind };
}
