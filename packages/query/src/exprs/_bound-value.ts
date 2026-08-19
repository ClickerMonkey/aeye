/**
 * The JSON VALUE an expr carries AT EMIT TIME — a literal's own value, or the
 * value bound to a param — and the routing decision that follows from it.
 *
 * WHY THIS IS SHARED. `Dialect.jsonValue(value, fieldType?, site?)` is where a
 * declared type's `cast` template fires
 * (`ST_GeomFromGeoJSON($1)::geometry(Polygon,4326)` instead of
 * `CAST($1 AS jsonb)`), and it can only fire when the caller SUPPLIES the field
 * type. Through `0.6.6`'s first pass exactly one road did — the write cell — so
 * a document reaching SQL anywhere else emitted the base cast and Postgres
 * refused the statement outright (`operator does not exist: geometry && jsonb`).
 * Any position that KNOWS the type a value is destined for should route through
 * here; the two that do are a write cell (the column's type) and a registered
 * operator's operand (the DECLARED operand type).
 *
 * `LiteralExpr` / `ParamExpr` in a position with no declared target still cannot
 * be helped — a bare literal in a `WHERE` knows only its own shape, and a param's
 * INFERRED type does not exist at emit time (`engine.toSQL` builds a fresh scope
 * and runs no validation walk). That is a separate, wider change; this module is
 * for the positions where the answer is already in hand.
 *
 * THE COLUMN-VS-VALUE RULE LIVES IN THE DIALECT, not here — see
 * {@link ValueSite}. It has to: Postgres binds a native array ELEMENT-WISE and
 * re-enters `jsonValue` per element, so a rule enforced at this one call site was
 * enforced for the container and skipped for everything inside it.
 */
import type { JsonValue } from '../schema';
import type { FieldType } from '../field-type';
import type { Expr } from '../expr';
import type { Dialect, ValueSite } from '../sql/dialect';
import type { SqlContext, SqlText } from '../sql/emit';
import { LiteralExpr } from './literal';
import { ParamExpr } from './param';

/**
 * The JSON value `expr` carries at emit time, or `undefined` when it is an
 * expression to emit normally (a field ref, a function call, an unbound param).
 */
export function boundValue(expr: Expr, ctx: SqlContext): JsonValue | undefined {
  if (expr instanceof LiteralExpr) return expr.value;
  if (expr instanceof ParamExpr && Object.prototype.hasOwnProperty.call(ctx.params, expr.name)) {
    return ctx.params[expr.name];
  }
  return undefined;
}

/**
 * Emit `expr` in a position whose target type is KNOWN, binding a carried
 * document (or any value destined for a `json` target) through
 * {@link Dialect.jsonValue} so the target's declared `cast` fires.
 *
 * The routing predicate is the A12 one, unchanged and shared rather than
 * restated: a value routes when it is an OBJECT (a document has no other correct
 * binding) or when the target is a `json` one (a scalar into a `json` slot needs
 * the cast too — the difference between a Postgres `jsonb` cast and the
 * `ARRAY[…]::text[]` a native array column actually needs).
 *
 * SQL NULL stays SQL NULL: a null literal is the documented way to write one,
 * and routing it would emit `CAST('null' AS jsonb)` — the JSON *value* `null`, a
 * different thing.
 *
 * `site` marks this a VALUE position and names the operand it belongs to; absent
 * ⇒ a COLUMN. A value position whose target's cast interpolates an option the
 * position did not write is REFUSED there rather than filled from the
 * refinement's defaults — see {@link ValueSite}.
 */
export function typedValueSql(
  expr: Expr,
  target: FieldType | undefined,
  dialect: Dialect,
  ctx: SqlContext,
  site?: ValueSite,
): SqlText {
  const value = boundValue(expr, ctx);
  if (value !== undefined && value !== null && (typeof value === 'object' || target?.resolve() === 'json')) {
    return dialect.jsonValue(value, target, site);
  }
  return expr.toSQL(dialect, ctx);
}
