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
 * Emit ONE write cell, giving a DOCUMENT value the target COLUMN's field type.
 *
 * A document has to be told what to be cast to, and only the write position
 * knows: `Expr.toSQL` sees the value's own shape and nothing else, so a
 * `['a','b']` bound for a Postgres `text[]` would otherwise be cast to `jsonb`
 * and rejected by the server. BOTH roads a document can arrive by are routed
 * here — a `LiteralExpr` carrying it, and a `param` bound to it — so neither
 * falls back to the shape-only default, and neither can bind NULL.
 */
export function writeCellSql(
  expr: Expr,
  field: Field | undefined,
  dialect: Dialect,
  ctx: SqlContext,
): SqlText {
  const document = writeDocument(expr, ctx);
  return document !== undefined ? dialect.jsonValue(document, field?.fieldType) : expr.toSQL(dialect, ctx);
}

/**
 * The JSON DOCUMENT this write cell carries — a literal's own value, or the
 * value bound to a param — or `undefined` when the cell is a scalar or an
 * expression to emit normally.
 */
function writeDocument(expr: Expr, ctx: SqlContext): JsonValue | undefined {
  if (expr instanceof LiteralExpr) {
    return expr.value !== null && typeof expr.value === 'object' ? expr.value : undefined;
  }
  if (expr instanceof ParamExpr && Object.prototype.hasOwnProperty.call(ctx.params, expr.name)) {
    const bound = ctx.params[expr.name];
    return bound !== null && bound !== undefined && typeof bound === 'object' ? bound : undefined;
  }
  return undefined;
}
