/**
 * Relation comparison lowering shared by `ComparisonExpr` / `InExpr`.
 *
 * A BELONGS-TO relation compared to a relation VALUE (an object
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
import { emitSubquerySQL } from './_shared';
import type { Type } from '../type';
import type { QueryEngine } from '../engine';
import type { JsonValue, QueryDef, SelectDef, ExprDef } from '../schema';
import { RelationFieldType } from '../field-types/index';
import { Value } from '../runtime/value';
import { and3, not3, type Tri } from '../runtime/tri';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow, SourceRecord } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, type SqlValue, SqlText } from '../sql/emit';

/** The reserved subquery alias a has-many EXISTS binds its target under (avoids shadowing the correlated outer source, e.g. a self-relation). */
const HAS_MANY_ALIAS = '__rel';

/** A relation operand's join-key columns + cardinality, for comparison lowering. */
export interface RelationCompare {
  /** The bound source the relation is read from. */
  readonly source: string;
  /**
   * The ordered join-key pairs: `local` a column on `source`, `foreign` a column
   * on the TARGET. For a BELONGS-TO, `foreign` is the target PK field; for a
   * HAS-MANY, it is the target's FK-back column (the join to this row's identity).
   */
  readonly keys: readonly { local: string; foreign: string }[];
  /**
   * Which side the FK is on: true = belongs-to (a single identity held on THIS
   * row), false = has-many (a SET, keyed on the target). Derived from
   * `RelationFieldType.isBelongsTo()`, NOT from `count` alone — a materialized
   * inverse can carry an estimated `count` of 1 and is still a has-many.
   */
  readonly belongsTo: boolean;
  /** The relation's target Type. */
  readonly target: Type;
}

/**
 * If `operand` is a relation field-ref, its key columns + cardinality + target —
 * else `undefined`. `typeOf` maps a bound source to its owning Type (runtime:
 * `ctx.sourceType`; SQL: a `ctx.scope` lookup). A belongs-to compares by
 * identity; a has-many compares by membership.
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
  const target = engine.type(ft.to);
  if (!target) return undefined;
  return {
    source: ref.source,
    keys: ft.resolveKeys(engine, ref.field, owner, target),
    belongsTo: ft.isBelongsTo(),
    target,
  };
}

/** A source → owning-Type resolver for the RUNTIME (bound source types, else a registered Type). */
export function runtimeTypeOf(ctx: RuntimeContext): (source: string) => Type | undefined {
  return (s) => ctx.sourceType(s) ?? ctx.engine.type(s);
}

/** A source → owning-Type resolver for SQL emission (from the emit scope's bindings). */
export function sqlTypeOf(ctx: SqlContext): (source: string) => Type | undefined {
  return (s) => {
    const b = ctx.scope.lookup(s);
    return b && b.kind === 'type' ? b.type : undefined;
  };
}

/**
 * Read one raw column value off a row's source record as a `Value`,
 * correlation-aware: a source not bound directly on `row` falls back to the outer
 * (correlation) row, so a correlated relation comparison reads its outer key.
 */
function column(row: SourceRow, source: string, name: string, ctx: RuntimeContext): Value {
  const rec = row[source] ?? ctx.correlation?.[source];
  /* v8 ignore next -- defensive: a compared source is always bound on the row or in the correlation */
  if (!rec) return Value.null();
  return cell(rec, name);
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

/** Read a raw column off a target row as a `Value` (an absent column ⇒ NULL). */
function cell(rec: SourceRecord, name: string): Value {
  /* v8 ignore next -- a well-formed target row always has its PK / FK columns; defensive NULL for a missing column */
  return Value.of(rec[name] ?? null);
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

/** The ordered target-PK value tuple of a relation VALUE: a `{ pk }` object by field name, else a lone scalar (single-key). */
async function valueTuple(
  value: Expr,
  pkFields: readonly string[],
  row: SourceRow,
  ctx: RuntimeContext,
  group: readonly SourceRow[] | undefined,
): Promise<Value[]> {
  const v = await value.evaluate(ctx, row, group);
  if (v.isNull()) return pkFields.map(() => Value.null());
  const raw = v.raw;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, JsonValue>;
    return pkFields.map((f) => Value.of(obj[f] ?? null));
  }
  return [v];
}

/**
 * Evaluate a HAS-MANY membership comparison: `=` is EXISTS a related row whose PK
 * equals the value (∈ the set); `<>` is NOT EXISTS. Scans the target Type's rows,
 * kept to those joining THIS row (the has-many keys) AND matching the value's PK.
 * Two-valued — EXISTS is never UNKNOWN; a NULL identity / PK matches nothing.
 */
export async function evaluateHasMany(
  op: '=' | '<>',
  rel: RelationCompare,
  value: Expr,
  row: SourceRow,
  ctx: RuntimeContext,
  group: readonly SourceRow[] | undefined,
): Promise<boolean> {
  const pkFields = rel.target.primaryKey().map((f) => f.name);
  const outer = rel.keys.map((k) => column(row, rel.source, k.local, ctx));
  const pkVals = await valueTuple(value, pkFields, row, ctx, group);
  if (outer.some((v) => v.isNull()) || pkVals.some((v) => v.isNull())) return op !== '=';
  const rows = (await ctx.typeState(rel.target)).current;
  const found = rows.some(
    (tr) =>
      rel.keys.every((k, i) => eq3(cell(tr, k.foreign), outer[i]!) === true) &&
      pkFields.every((f, i) => eq3(cell(tr, f), pkVals[i]!) === true),
  );
  return op === '=' ? found : !found;
}

/** The ordered key-column SqlText tuple for one operand (relation → its columns; value → per-PK binds). */
function tupleSql(
  operand: Expr,
  rel: RelationCompare | undefined,
  keys: readonly { local: string; foreign: string }[],
  dialect: Dialect,
  ctx: SqlContext,
): SqlText[] {
  // `columnSQL`, not `toSQL`: a belongs-to's key column shares the relation
  // FIELD's name, so a plain emit would rebuild the identity object here.
  if (rel) return rel.keys.map((k) => new FieldRefExpr(rel.source, k.local).columnSQL(dialect, ctx));
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
  /* v8 ignore next -- a non-param, non-relation value against a relation is rejected in validation; defensive */
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

/**
 * The ordered target-PK scalar components of a has-many VALUE, for SQL binds: a
 * `{ pk }` param object read by field name, else a lone scalar (single-key). A
 * has-many always compares against a param (literals / relations are rejected in
 * validation), so a non-param value is defensively treated as all-NULL.
 */
function valueComponentsSql(value: Expr, pkFields: readonly string[], ctx: SqlContext): SqlValue[] {
  /* v8 ignore next -- a has-many compares only against a param value (literals / relations are rejected in validation); defensive */
  if (!(value instanceof ParamExpr)) return pkFields.map(() => null);
  const pv = ctx.params[value.name];
  if (pv !== null && pv !== undefined && typeof pv === 'object') {
    const obj = pv as Record<string, SqlValue>;
    return pkFields.map((f) => obj[f] ?? null);
  }
  return [(pv ?? null) as SqlValue];
}

/**
 * Emit a HAS-MANY membership comparison as a correlated `[NOT] EXISTS` subquery:
 * `EXISTS (SELECT 1 FROM <target> __rel WHERE <join> AND <target.pk = value>)`.
 * `=` → EXISTS, `<>` → NOT EXISTS. Delegates to the SELECT machinery (FROM
 * naming, correlation scope, planner) via `emitSubquerySQL`; the target binds
 * under a reserved alias so a self-relation does not shadow the outer source.
 */
export function emitHasMany(
  op: '=' | '<>',
  rel: RelationCompare,
  value: Expr,
  dialect: Dialect,
  ctx: SqlContext,
): SqlText {
  const pkFields = rel.target.primaryKey().map((f) => f.name);
  const comps = valueComponentsSql(value, pkFields, ctx);
  const eq = (left: ExprDef, right: ExprDef): ExprDef => ({ kind: 'comparison', op: '=', left, right }) as ExprDef;
  const col = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
  const where: ExprDef[] = [
    // Correlation: each has-many key joins the target's FK-back column to this row's identity.
    ...rel.keys.map((k) => eq(col(HAS_MANY_ALIAS, k.foreign), col(rel.source, k.local))),
    // Membership: the target's PK equals the value's components.
    ...pkFields.map((pk, i) => eq(col(HAS_MANY_ALIAS, pk), { kind: 'literal', value: comps[i] ?? null })),
  ];
  const def: SelectDef = {
    kind: 'select',
    // Project the target's PK column (a bare ref, no bound param) — EXISTS
    // ignores the projected value, and `SELECT 1` would bind a stray literal.
    fields: [{ expr: col(HAS_MANY_ALIAS, pkFields[0]!) }],
    from: { kind: 'aliased', type: rel.target.name, as: HAS_MANY_ALIAS },
    where,
  };
  const sub = emitSubquerySQL(dialect, ctx, def as QueryDef);
  return SqlText.concat([SqlText.raw(op === '=' ? 'EXISTS ' : 'NOT EXISTS '), sub]);
}
