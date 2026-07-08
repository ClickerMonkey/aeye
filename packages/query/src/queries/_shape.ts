/**
 * Shared structural {@link Shape}s reused across the query kinds' owned parsers
 * (the zod-free parallel to each `from`). See `shape/` for the design (never
 * throws, accumulates problems, no casts).
 *
 * These cover the small building blocks several query kinds share:
 *  - a SELECT/RETURNING field (`{ expr, as? }`);
 *  - a SET / ON-CONFLICT assignment (`{ field, value }` → `{ field, expr }`);
 *  - a LIMIT / OFFSET bound (a literal integer count or a bound `param`).
 */
import type { Expr } from '../expr';
import type { ParamExprDef } from '../schema';
import { obj, str, exprRef, isRecord, expected, INVALID, type Shape } from '../shape';
import { ParamExpr } from '../exprs/index';

/** A parsed SELECT / RETURNING field — its output expr plus an optional alias. */
export interface ShapeField {
  expr: Expr;
  as: string | undefined;
}

/** Shape for a `SelectFieldDef` (`{ expr, as? }`). */
export function selectFieldShape(): Shape<ShapeField> {
  return obj(
    { expr: exprRef(), as: str('FieldName') },
    (v) => ({ expr: v.expr, as: v.as }),
    { optional: ['as'], aid: 'SelectField' },
  );
}

/** A parsed field assignment — the target field name plus its value expr. */
export interface ShapeAssign {
  field: string;
  expr: Expr;
}

/** Shape for a `FieldValueDef` (`{ field, value }` → `{ field, expr }`). */
export function fieldValueShape(): Shape<ShapeAssign> {
  return obj(
    { field: str('FieldName'), value: exprRef() },
    (v) => ({ field: v.field, expr: v.value }),
    { aid: 'FieldValue' },
  );
}

/**
 * Shape for a LIMIT / OFFSET bound: a literal integer count, or a bound `param`
 * (`{ kind:'param', name }`) whose def is kept verbatim. A non-number, non-param
 * value records an aid-directed `shape.type` (`expected a number or a param`).
 */
export function boundShape(): Shape<number | ParamExprDef> {
  return {
    check(json, ctx) {
      if (typeof json === 'number') return json;
      if (isRecord(json) && json['kind'] === 'param') {
        const built = ctx.registry.parseCheckedExpr(json, ctx.problems);
        if (built instanceof ParamExpr) return built.toJSON();
        return INVALID;
      }
      ctx.problems.error('shape.type', expected('Limit', json));
      return INVALID;
    },
  };
}
