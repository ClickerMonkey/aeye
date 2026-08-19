/**
 * The JSON VALUE an expr carries AT EMIT TIME — a literal's own value, or the
 * value bound to a param — and the routing decision that follows from it.
 *
 * WHY THIS IS SHARED. `Dialect.jsonValue(value, fieldType?)` is where a declared
 * type's `cast` template fires (`ST_GeomFromGeoJSON($1)::geometry(Polygon,4326)`
 * instead of `CAST($1 AS jsonb)`), and it can only fire when the caller SUPPLIES
 * the field type. Through `0.6.6`'s first pass exactly one road did — the write
 * cell — so a document reaching SQL anywhere else emitted the base cast and
 * Postgres refused the statement outright (`operator does not exist: geometry &&
 * jsonb`). Any position that KNOWS the type a value is destined for should route
 * through here; the two that do are a write cell (the column's type) and a
 * registered operator's operand (the DECLARED operand type).
 *
 * `LiteralExpr` / `ParamExpr` in a position with no declared target still cannot
 * be helped — a bare literal in a `WHERE` knows only its own shape, and a param's
 * INFERRED type does not exist at emit time (`engine.toSQL` builds a fresh scope
 * and runs no validation walk). That is a separate, wider change; this module is
 * for the positions where the answer is already in hand.
 */
import type { JsonValue } from '../schema';
import { QueryTypeError } from '../problem';
import type { FieldType } from '../field-type';
import type { Expr } from '../expr';
import type { Dialect } from '../sql/dialect';
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
 * WHAT the known target is, which decides whether its declared `cast` may fill
 * an option the target did not write.
 *
 *  - `'column'` — a real column. Its refinement's option DEFAULTS are facts
 *    about it, so a cast may resolve them; that is what makes a write cell emit
 *    `ST_GeomFromGeoJSON($1)::geometry(Polygon,4326)`.
 *  - `'value'` — a declared type standing in for "any value of this type", which
 *    is what an operator OPERAND is. Filling a slot from the refinement's
 *    default PINS a constraint the value was never required to satisfy: measured
 *    on the flagship predicate, an operand declaring `{kind:'json',
 *    as:'Geometry'}` with no `with` cast a Polygon document to
 *    `::geometry(Point,4326)` — a PostGIS TYPMOD — and the server refused it
 *    (`Geometry type (Polygon) does not match column type (Point)`).
 *
 * It is the same rule the model-facing renderer already follows: an operand's
 * tag shows only what its declaration WROTE. One rule, two surfaces.
 */
export type TargetPosition = 'column' | 'value';

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
 * In a `'value'` position a target whose cast interpolates an option the target
 * did not write is REFUSED rather than filled from the refinement's defaults —
 * see {@link TargetPosition}, and `refuseUnwrittenCast` for why a refusal beats
 * both alternatives.
 */
export function typedValueSql(
  expr: Expr,
  target: FieldType | undefined,
  dialect: Dialect,
  ctx: SqlContext,
  position: TargetPosition = 'column',
  where?: string,
): SqlText {
  const value = boundValue(expr, ctx);
  if (value !== undefined && value !== null && (typeof value === 'object' || target?.resolve() === 'json')) {
    if (position === 'value' && target) refuseUnwrittenCast(target, dialect, where);
    return dialect.jsonValue(value, target);
  }
  return expr.toSQL(dialect, ctx);
}

/**
 * Refuse a `'value'`-position cast that could only be resolved by asserting an
 * option the target never wrote.
 *
 * A REFUSAL rather than either alternative, and both alternatives were
 * considered. Filling from the refinement's DEFAULTS is what shipped and it
 * emits confidently wrong SQL — a typmod the value need not satisfy, rejected by
 * the server on the NORMAL case (`&&` is a bounding-box pre-filter, so a Polygon
 * argument is the ordinary one). Falling back to the BASE cast is worse still:
 * that is `CAST($1 AS jsonb)`, which is how this whole road was broken to begin
 * with (`operator does not exist: geometry && jsonb`) — silently emitting SQL
 * the database rejects for a different reason is not an improvement.
 *
 * So the declarer is told, at the one point the ambiguity is real, with the two
 * things that actually resolve it: move the per-column part out of `cast` (a
 * cast that interpolates NO option is position-independent and is used here
 * unchanged), or have the operand WRITE the options in its own `with` — which
 * makes the typmod a constraint the operand genuinely declares.
 */
function refuseUnwrittenCast(target: FieldType, dialect: Dialect, where: string | undefined): void {
  const unwritten = target.uncastableOptions(dialect.name);
  if (unwritten.length === 0) return;
  throw new QueryTypeError({
    path: where === undefined ? [] : ['args', where],
    code: 'cast.unwritten-option',
    severity: 'error',
    message:
      `A document bound here is typed \`${target.as}\`, whose \`${dialect.name}\` cast interpolates ` +
      `${unwritten.map((o) => `\`{${o}}\``).join(', ')} — and this position declared no value for ` +
      `${unwritten.length === 1 ? 'it' : 'them'}. Resolving from the type's DEFAULTS would pin a ` +
      'constraint on the value that nothing required it to satisfy (a default belongs to the TYPE, not ' +
      'to this value), which is how a PostGIS `::geometry(Point,4326)` came to be applied to a Polygon. ' +
      `Either declare a \`cast\` that interpolates no option — one that says only "this IS a ` +
      `${target.as}", which is what a value position can honestly assert — or write the options here, ` +
      `in this operand's own \`with\` bag, so the cast expresses a constraint you actually declared.`,
  });
}
