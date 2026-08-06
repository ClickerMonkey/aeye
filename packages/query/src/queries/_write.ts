/**
 * Shared WRITE-value handling for the keyed INSERT-row / UPDATE-SET records:
 * parsing, per-column validation, and emission of ONE write cell.
 *
 * A field's value is EITHER a raw typed value OR a full `ExprDef` (see
 * `WriteValueDef`), and the OpenAI-safe null semantics are enforced here: an
 * absent key OR a JSON `null` value OMITS the field (its backing default fills
 * in / it stays unset); a literal-null expr `{ kind:'literal', value:null }` is
 * the ONLY way to set SQL NULL.
 *
 * A9 — A WRITE CELL CAN CARRY A DOCUMENT. Until 0.6.1 it could not carry a
 * `json` or `array` value AT ALL, by four separate roads:
 *  - a RAW document (`{}` / `['x']`) was refused, though `WriteValueDef` is
 *    documented as `JsonValue | ExprDef` — the TYPE and the PARSER disagreed;
 *  - OMITTING the cell instead is `insert.missing-required` on a non-nullable
 *    column;
 *  - no EXPRESSION could carry one (`LiteralExpr` took only a scalar);
 *  - and the `param` road was the worst outcome available: it parsed, then bound
 *    SQL `NULL`, so the write SUCCEEDED and the value was silently dropped.
 * A raw document now parses to a `LiteralExpr` (the parser follows the type),
 * and both roads emit through {@link writeCellSql}, which hands the target
 * COLUMN's field type to `Dialect.jsonValue` — the difference between a `jsonb`
 * cast and the `ARRAY[…]::text[]` a native array column needs.
 *
 * A12 (0.6.2) — THAT ROUTING NOW ASKS THE COLUMN, NOT THE VALUE. Asking the
 * value ("is it a document?") missed the JSON *scalar*: a bare string / number /
 * boolean is a legal value of a `json` column and was bound raw and uncast, so
 * Postgres rejected the statement at run time. See {@link writeCellSql}.
 */
import type { Expr, ValidateContext } from '../expr';
import type { QueryEngine } from '../engine';
import type { QueryScope } from '../scope';
import type { Registry } from '../registry';
import type { Field } from '../field';
import type { ExprDef, JsonValue, WriteValueDef } from '../schema';
import { LiteralExpr, ParamExpr } from '../exprs/index';
import { RelationFieldType } from '../field-types/index';
import { asFieldType } from '../resolved-type';
import { isRecord, isJsonValue, JSON_MAX_DEPTH } from '../shape';
import { QueryTypeError } from '../problem';
import type { Problems } from '../problem';
import type { Dialect } from '../sql/dialect';
import type { SqlContext, SqlText } from '../sql/emit';

/**
 * Whether a write value is an `ExprDef` — a non-null object whose `kind` names a
 * REGISTERED expr kind.
 *
 * The registry check is what keeps the `JsonValue | ExprDef` union decidable now
 * that a raw DOCUMENT is a legal write value: a settings blob that happens to
 * carry a string `kind` (`{ kind: 'section', … }`) is DATA, not a malformed
 * expression, and reading it as the latter reported an unknown-kind error about
 * a construct the caller never wrote. A document whose `kind` genuinely names an
 * expr kind is still read as an expression — that ambiguity is inherent to the
 * union, and the registered-kind test narrows it to the smallest possible set.
 */
export function isExprValue(v: unknown, registry?: Registry): v is ExprDef {
  if (!isRecord(v) || typeof v['kind'] !== 'string') return false;
  return registry === undefined || registry.exprClass(v['kind']) !== undefined;
}

/**
 * Parse one {@link WriteValueDef} into its `Expr`, or `undefined` to OMIT the
 * field. `undefined` / `null` ⇒ OMIT; a `{ kind }` object naming a registered
 * expr kind ⇒ an `ExprDef` (a literal-null expr sets SQL NULL); any other JSON
 * value — a scalar OR a whole document — ⇒ a `LiteralExpr`.
 */
export function writeValueToExpr(v: WriteValueDef, registry: Registry): Expr | undefined {
  if (v === null || v === undefined) return undefined; // OMIT
  if (isExprValue(v, registry)) return registry.parseExpr(v);
  if (isJsonValue(v, JSON_MAX_DEPTH)) return new LiteralExpr(v);
  // Unreachable from parsed JSON (`WriteValueDef` admits nothing else), but a
  // HAND-BUILT def can hold a `Date` / a function / a cyclic object, and writing
  // whatever those stringify to is exactly the silent-corruption class A9 ends.
  throw new QueryTypeError({
    path: [],
    code: 'write.unsupported-value',
    severity: 'error',
    message: `Unsupported write value ${describeUnsupported(v)}; use a JSON value or an expression.`,
  });
}

/** A safe rendering of a non-JSON write value (it may be cyclic — never stringify it). */
function describeUnsupported(v: unknown): string {
  return typeof v === 'object' && v !== null ? Object.prototype.toString.call(v) : String(v);
}

/**
 * Parse a keyed write RECORD (an INSERT row / UPDATE SET / ON CONFLICT update)
 * into an insertion-ordered field → `Expr` map, DROPPING every OMITted key
 * (absent is impossible here; a JSON-`null` value is dropped).
 */
export function parseWriteRecord(
  record: { readonly [field: string]: WriteValueDef },
  registry: Registry,
): Map<string, Expr> {
  const out = new Map<string, Expr>();
  for (const key of Object.keys(record)) {
    const expr = writeValueToExpr(record[key]!, registry);
    if (expr !== undefined) out.set(key, expr); // undefined ⇒ OMIT
  }
  return out;
}

/**
 * Validate ONE write cell against the COLUMN it is assigned to.
 *
 * Three things the column — and only the column — can settle:
 *  1. the value expr is WALKED (an INSERT's VALUES exprs were previously never
 *     walked at all, so a bad ref or an unbound source inside one was silently
 *     accepted and only surfaced at emit / run time);
 *  2. a PARAM cell is OBSERVED against the column's field type, which is where
 *     its type has to come from — nothing else in a write cell supplies one,
 *     which is why an UPDATE `SET x = :p` reported `param.untyped`;
 *  3. the value's category must be assignable to the column's (`write.type`) —
 *     the check that turns "a document into a text column" from silently-wrong
 *     SQL into a stated problem.
 *
 * A param and a null literal are exempt from (3): a param has no category of its
 * own (it takes the column's, per (2)), and NULL is assignable to any column
 * whose own nullability admits it.
 */
export function validateWriteValue(
  engine: QueryEngine,
  scope: QueryScope,
  p: Problems,
  ctx: ValidateContext,
  field: Field | undefined,
  expr: Expr,
): void {
  const resolved = expr.validateWalk(engine, scope, p, ctx);
  if (!field) return; // an unknown column is reported by the caller
  if (expr instanceof ParamExpr) {
    scope.params.observe(expr.name, field.fieldType, p.here);
    return;
  }
  if (expr instanceof LiteralExpr && expr.isNullLiteral()) return;
  // A RELATION column is exempt: what you write to it is the TARGET's IDENTITY
  // (a scalar for a single-column key, a `{ pk }` object for a composite one),
  // never a value of the relation's own category — and
  // `RelationFieldType.comparableWith` deliberately admits only another relation
  // to the same target, so asking it here would refuse the ordinary "set the
  // foreign key" write. Checking the identity's type instead needs the target's
  // primary key, which throws for a Type that declares none; that is a separate
  // piece of work, so relation cells stay as unchecked as they were.
  if (field.fieldType instanceof RelationFieldType) return;
  const valueType = asFieldType(resolved);
  if (valueType && !field.fieldType.comparableWith(valueType)) {
    p.error(
      'write.type',
      `Cannot write a ${valueType.resolve()} value to field '${field.name}' (${field.fieldType.resolve()}).`,
    );
  }
}

/**
 * Emit ONE write cell, giving a JSON value the target COLUMN's field type.
 *
 * A JSON value has to be told what to be cast to, and only the write position
 * knows: `Expr.toSQL` sees the value's own shape and nothing else, so a
 * `['a','b']` bound for a Postgres `text[]` would otherwise be cast to `jsonb`
 * and rejected by the server. BOTH roads a value can arrive by are routed here —
 * a `LiteralExpr` carrying it, and a `param` bound to it — so neither falls back
 * to the shape-only default, and neither can bind NULL.
 *
 * A12 — THE COLUMN DECIDES, NOT THE VALUE'S SHAPE. Until 0.6.2 the routing asked
 * the VALUE ("is it a document?"), which left a JSON *scalar* — a bare string,
 * number or boolean, every one of them a legal value of a `json` column — bound
 * raw and uncast: `VALUES ($1, $2)`, which Postgres rejects (`column is of type
 * jsonb but expression is of type text`) with nothing upstream to catch it. A
 * cast ALONE would not have fixed it either — `CAST('a bare string' AS jsonb)`
 * is invalid JSON input — so the value must be JSON-ENCODED as well, which is
 * exactly the pair `Dialect.jsonValue` applies. It is reachable only through a
 * `param`: a scalar LITERAL into a `json` column is refused at validation
 * (`write.type`, `JsonFieldType.comparableWith`), while a param is exempt from
 * that check because it takes the COLUMN's type (`validateWriteValue`) and its
 * value only exists at emit time. Both roads are routed the same way regardless,
 * since `toSQL` carries no guarantee that validation ran.
 *
 * SQL NULL stays SQL NULL. A null literal is the documented — and only — way to
 * write SQL NULL, and an unbound param binds NULL; routing either through
 * `jsonValue` would emit `CAST('null' AS jsonb)`, i.e. the JSON *value* `null`,
 * a different thing. So a null is always left to `Expr.toSQL`.
 *
 * An `array` column is deliberately NOT included: a scalar is not a value of an
 * array column at all (there is no correct cast to emit — `CAST('x' AS text[])`
 * is a syntax error), so it stays a value problem, not an emission one.
 */
export function writeCellSql(
  expr: Expr,
  field: Field | undefined,
  dialect: Dialect,
  ctx: SqlContext,
): SqlText {
  const value = writeCellValue(expr, ctx);
  if (value !== undefined && value !== null && (typeof value === 'object' || isJsonColumn(field))) {
    return dialect.jsonValue(value, field?.fieldType);
  }
  return expr.toSQL(dialect, ctx);
}

/** Whether this write cell's target column is a `json` one (the A12 routing key). */
function isJsonColumn(field: Field | undefined): boolean {
  return field?.fieldType.resolve() === 'json';
}

/**
 * The JSON VALUE this write cell carries at emit time — a literal's own value,
 * or the value bound to a param — or `undefined` when the cell is an expression
 * to emit normally (a ref, a function call, an unbound param).
 */
function writeCellValue(expr: Expr, ctx: SqlContext): JsonValue | undefined {
  if (expr instanceof LiteralExpr) return expr.value;
  if (expr instanceof ParamExpr && Object.prototype.hasOwnProperty.call(ctx.params, expr.name)) {
    return ctx.params[expr.name];
  }
  return undefined;
}
