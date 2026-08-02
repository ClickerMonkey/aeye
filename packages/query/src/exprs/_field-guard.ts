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
import type { Expr, RelationUse, ValidateContext } from '../expr';
import type { ExprKind } from '../schema';
import { FieldRefExpr } from './field-ref';

/**
 * The context for validating `operand` as the direct subject of a gating
 * operator: a field-ref operand carries `fieldExprKind = kind`; anything else is
 * returned the incoming `ctx` unchanged. `relationUse` (see
 * `ValidateContext.relationUse`) additionally says how a RELATION field-ref
 * operand may be used here — `'compare'` for the FK-comparison operators, which
 * run their own relation-vs-relation / relation-vs-scalar checks, `'value'` for
 * a position that reads the relation's identity (`is-null`). A gating operator
 * that passes neither (`array-op`) lets a bare relation operand be refused.
 */
export function operandCtx(
  operand: Expr,
  kind: ExprKind,
  ctx: ValidateContext,
  relationUse?: RelationUse,
): ValidateContext {
  if (!(operand instanceof FieldRefExpr)) return ctx;
  return relationUse ? { ...ctx, fieldExprKind: kind, relationUse } : { ...ctx, fieldExprKind: kind };
}

/**
 * The context for validating `expr` at a position that reads a relation's
 * IDENTITY as a value — a select field / RETURNING, an ORDER BY term, a GROUP BY
 * key. Applied ONLY when `expr` IS the field-ref, mirroring `operandCtx`: were it
 * merged into the ambient context it would flow down into nested exprs and quietly
 * permit `upper(note.author)`, which is not a defined thing.
 */
export function identityValueCtx(expr: Expr, ctx: ValidateContext): ValidateContext {
  return expr instanceof FieldRefExpr ? { ...ctx, relationUse: 'value' } : ctx;
}
