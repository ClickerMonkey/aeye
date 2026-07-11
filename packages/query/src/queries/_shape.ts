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
import { obj, str, exprRef, isRecord, expected, INVALID, type Shape, type CheckCtx } from '../shape';
import { LiteralExpr, ParamExpr } from '../exprs/index';
import { isExprValue } from './_write';

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

/**
 * One WRITE value → its `Expr`, or `undefined` to OMIT the field (absent key or
 * a JSON `null` — the OpenAI-safe null semantics; a literal-null expr sets SQL
 * NULL). A `{ kind }` object is a full expr; a raw scalar becomes a literal.
 */
function writeValueShape(): Shape<Expr | undefined> {
  return {
    check(json: unknown, ctx: CheckCtx): Expr | undefined | typeof INVALID {
      if (json === null || json === undefined) return undefined; // OMIT
      if (isExprValue(json)) {
        const built = ctx.registry.parseCheckedExpr(json, ctx.problems);
        return built === undefined ? INVALID : built;
      }
      if (typeof json === 'string' || typeof json === 'number' || typeof json === 'boolean') {
        return new LiteralExpr(json);
      }
      ctx.problems.error('shape.type', expected('WriteValue', json));
      return INVALID;
    },
  };
}

/**
 * Shape for a keyed WRITE RECORD — an INSERT row / UPDATE SET / ON CONFLICT
 * update `{ [field]: WriteValueDef }`. Non-object → aid-directed
 * `shape.not-object`; each value is checked at `problems.at(field, …)`;
 * OMITted (JSON-`null`) keys are DROPPED. Returns an insertion-ordered
 * `Map<string, Expr>` (mirroring `writeRecordShape`'s throwing twin). Accumulates.
 */
export function writeRecordShape(aid: string): Shape<Map<string, Expr>> {
  const value = writeValueShape();
  return {
    check(json, ctx) {
      if (!isRecord(json)) {
        ctx.problems.error('shape.not-object', expected(aid, json));
        return INVALID;
      }
      const out = new Map<string, Expr>();
      let ok = true;
      for (const key of Object.keys(json)) {
        const built = ctx.problems.at(key, () => value.check(json[key], ctx));
        if (built === INVALID) ok = false;
        else if (built !== undefined) out.set(key, built); // undefined ⇒ OMIT
      }
      return ok ? out : INVALID;
    },
  };
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
