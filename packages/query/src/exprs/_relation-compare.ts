/**
 * Relation comparison lowering shared by `ComparisonExpr` / `InExpr`.
 *
 * A BELONGS-TO relation (`count === 1`) compared to a relation VALUE (an object
 * keyed by the target's PK field names, e.g. `{ id: 5 }`), a bare scalar (a
 * single-key convenience), or another same-target relation lowers to a
 * per-key-column comparison: `AND_i ( source.local_i <op> other_i )`, driven by
 * the relation's ordered `resolveKeys()` pairs (composite-capable). Single-key +
 * scalar stays identical to comparing the lone FK column, so existing queries
 * are unaffected.
 *
 * Detection is TYPE-based (the operand's `fieldRef()` + the owning Type), which
 * both the runtime (`ctx.sourceType`) and SQL (`ctx.scope`) can supply — so the
 * two surfaces lower identically.
 */
import type { Expr } from '../expr';
import { FieldRefExpr } from './field-ref';
import { ParamExpr } from './param';
import type { Type } from '../type';
import type { QueryEngine } from '../engine';
import type { JsonValue } from '../schema';
import { RelationFieldType } from '../field-types/index';
import { Value } from '../runtime/value';
import { and3, not3, type Tri } from '../runtime/tri';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, type SqlValue, SqlText } from '../sql/emit';

/** A belongs-to relation operand's key columns, for comparison lowering. */
export interface RelationCompare {
  /** The bound source the relation is read from. */
  readonly source: string;
  /** The ordered join-key pairs: `local` a column on `source`, `foreign` the target PK field. */
  readonly keys: readonly { local: string; foreign: string }[];
}

/**
 * If `operand` is a BELONGS-TO relation field-ref, its key columns — else
 * `undefined`. `typeOf` maps a bound source to its owning Type (runtime:
 * `ctx.sourceType`; SQL: a `ctx.scope` lookup). Has-many (`count > 1`) is NOT a
 * value comparison (it is a SET — handled via membership elsewhere).
 */
export function relationCompare(
  operand: Expr,
  engine: QueryEngine,
  typeOf: (source: string) => Type | undefined,
): RelationCompare | undefined {
  const ref: FieldRefExpr | undefined = operand.fieldRef();
  if (!ref) return undefined;
  const owner = typeOf(ref.source);
  if (!owner) return undefined;
  const field = owner.field(ref.field);
  if (!field || !(field.fieldType instanceof RelationFieldType)) return undefined;
  const ft = field.fieldType;
  if (ft.count !== 1) return undefined; // has-many is a set, not a single identity
  const target = engine.type(ft.to);
  if (!target) return undefined;
  return { source: ref.source, keys: ft.resolveKeys(engine, ref.field, owner, target) };
}

/** Read one raw column value off a row's source record (correlation-aware), as a `Value`. */
function column(row: SourceRow, source: string, name: string, ctx: RuntimeContext): Value {
  const rec = row[source] ?? ctx.correlation?.[source];
  const raw = rec?.[name];
  return Value.of(raw === undefined ? null : raw);
}

/** The ordered key-VALUE tuple for one operand: a relation reads its columns; a value extracts by PK field (or is a lone scalar). */
async function tuple(
  operand: Expr,
  rel: RelationCompare | undefined,
  keys: readonly { local: string; foreign: string }[],
  row: SourceRow,
  ctx: RuntimeContext,
  group: readonly SourceRow[] | undefined,
): Promise<Value[]> {
  if (rel) return rel.keys.map((k) => column(row, rel.source, k.local, ctx));
  const v = await operand.evaluate(ctx, row, group);
  if (v.isNull()) return keys.map(() => Value.null());
  const raw = v.raw;
  // A relation VALUE object → extract each target PK field; a lone scalar (single
  // key) compares directly.
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, JsonValue>;
    return keys.map((k) => Value.of(obj[k.foreign] ?? null));
  }
  return [v];
}

/** 3VL equality of two scalar `Value`s (NULL on either side ⇒ UNKNOWN). */
function eq3(a: Value, b: Value): Tri {
  if (a.isNull() || b.isNull()) return undefined;
  return a.compareTo(b) === 0;
}

/**
 * Evaluate a relation `=` / `<>` comparison under 3VL: build both sides' key
 * tuples and AND their per-column equalities (`<>` is the 3VL negation).
 */
export async function evaluateRelationCompare(
  op: '=' | '<>',
  left: Expr,
  right: Expr,
  leftRel: RelationCompare | undefined,
  rightRel: RelationCompare | undefined,
  row: SourceRow,
  ctx: RuntimeContext,
  group: readonly SourceRow[] | undefined,
): Promise<Tri> {
  const keys = (leftRel ?? rightRel)!.keys;
  const lt = await tuple(left, leftRel, keys, row, ctx, group);
  const rt = await tuple(right, rightRel, keys, row, ctx, group);
  let acc: Tri = true;
  for (let i = 0; i < keys.length; i++) acc = and3(acc, eq3(lt[i]!, rt[i]!));
  return op === '=' ? acc : not3(acc);
}

/** The ordered key-column SqlText tuple for one operand (relation → its columns; value → per-PK binds). */
function tupleSql(
  operand: Expr,
  rel: RelationCompare | undefined,
  keys: readonly { local: string; foreign: string }[],
  dialect: Dialect,
  ctx: SqlContext,
): SqlText[] {
  if (rel) return rel.keys.map((k) => new FieldRefExpr(rel.source, k.local).toSQL(dialect, ctx));
  // A value operand: a param binds either a { pk } object (per-column) or a lone
  // scalar (single key); any other scalar expr emits directly (single key).
  if (operand instanceof ParamExpr) {
    const pv = ctx.params[operand.name];
    if (pv !== null && pv !== undefined && typeof pv === 'object') {
      const obj = pv as Record<string, SqlValue>;
      return keys.map((k) => SqlText.param(obj[k.foreign] ?? null));
    }
    return [SqlText.param((pv ?? null) as SqlValue)];
  }
  return [operand.toSQL(dialect, ctx)];
}

/**
 * Emit a relation `=` / `<>` comparison as ANDed per-key-column equalities
 * (`<>` wraps them in `NOT (...)`), portable across dialects.
 */
export function emitRelationCompare(
  op: '=' | '<>',
  left: Expr,
  right: Expr,
  leftRel: RelationCompare | undefined,
  rightRel: RelationCompare | undefined,
  dialect: Dialect,
  ctx: SqlContext,
): SqlText {
  const keys = (leftRel ?? rightRel)!.keys;
  const ls = tupleSql(left, leftRel, keys, dialect, ctx);
  const rs = tupleSql(right, rightRel, keys, dialect, ctx);
  const eqs = keys.map((_, i) => SqlText.join([ls[i]!, SqlText.raw('='), rs[i]!], ' '));
  const anded = SqlText.join(eqs, ' AND ').parens();
  return op === '=' ? anded : SqlText.concat([SqlText.raw('NOT '), anded]);
}
