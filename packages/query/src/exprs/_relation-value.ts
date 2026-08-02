/**
 * A relation's VALUE — its IDENTITY, read off the caller's OWN row.
 *
 * A belongs-to relation physically stores the target's identity in one (or,
 * with a composite backing, several) columns on the referencing row. That value
 * had no expression that could read it: a bare relation field-ref was refused
 * everywhere except an FK comparison, so the only way to see who a row pointed
 * at was to JOIN the target and project its id — which is RLS-scoped, so a
 * target the reader cannot see nulls the id along with the rest of the row and
 * "unset" becomes indistinguishable from "hidden". Reading the LOCAL columns
 * discloses nothing: they are data the reader's own row already holds.
 *
 * The value is a KEYED OBJECT, not a positional tuple — `{ id: 'userB' }`,
 * `{ tenantId: 3, userId: 1 }` — keyed by the TARGET's identity field names.
 * A tuple's meaning would depend on element order, and that order derives from
 * index order; baking that into stored query defs would persist exactly the
 * fragility an explicit `identity` declaration exists to remove.
 *
 * UNSET is NULL. If ANY key column is null the relation does not point at a row
 * (a partial composite key can never join), so the identity is SQL NULL rather
 * than an object with null members — which is what makes `IS NULL` mean "unset"
 * and keeps an unset audit column readable as unset.
 */
import type { Expr } from '../expr';
import type { QueryEngine } from '../engine';
import type { Type } from '../type';
import type { JsonValue } from '../schema';
import { Value } from '../runtime/value';
import type { RuntimeContext } from '../runtime/context';
import type { SourceRow } from '../runtime/row';
import type { Dialect } from '../sql/dialect';
import { type SqlContext, SqlText } from '../sql/emit';
import { FieldRefExpr } from './field-ref';
import { OutputRefExpr } from './output-ref';
import { relationCompare, runtimeTypeOf, sqlTypeOf, type RelationCompare } from './_relation-compare';

/**
 * The identity a relation field-ref reads off its own row, or `undefined` when
 * `expr` is not a relation field-ref or is a HAS-MANY (which has no key on this
 * row at all — see `hasManyValueMessage`).
 */
export function relationIdentity(
  expr: Expr,
  engine: QueryEngine,
  typeOf: (source: string) => Type | undefined,
): RelationCompare | undefined {
  const rel = relationCompare(expr, engine, typeOf);
  return rel && rel.belongsTo ? rel : undefined;
}

/** The identity of a relation field-ref at RUNTIME, or `undefined` when it is not one. */
export function relationIdentityValue(expr: Expr, ctx: RuntimeContext, row: SourceRow): Value | undefined {
  const rel = relationIdentity(expr, ctx.engine, runtimeTypeOf(ctx));
  if (!rel) return undefined;
  const rec = row[rel.source] ?? ctx.correlation?.[rel.source];
  /* v8 ignore next -- defensive: a validated relation ref is always bound on the row or in the correlation */
  if (!rec) return Value.null();
  const out: { [key: string]: JsonValue } = {};
  for (const k of rel.keys) {
    const raw = rec[k.local] ?? null;
    // Any null key column ⇒ the relation is unset (a partial composite key
    // cannot join), so the whole identity is NULL rather than a half-object.
    if (raw === null) return Value.null();
    out[k.foreign] = raw;
  }
  return Value.of(out);
}

/**
 * The identity of a relation field-ref in SQL, or `undefined` when it is not
 * one. Emits `CASE WHEN <any key column IS NULL> THEN NULL ELSE <json object>
 * END`, so an unset relation projects as SQL NULL exactly as the runtime
 * evaluates it. NO join is planned and no scope is applied — every column read
 * is on the referencing row itself.
 */
export function relationIdentitySql(expr: Expr, dialect: Dialect, ctx: SqlContext): SqlText | undefined {
  const rel = relationIdentity(expr, ctx.engine, sqlTypeOf(ctx));
  if (!rel) return undefined;
  const object = dialect.jsonObject(rel.keys.map((k) => ({ key: k.foreign, value: dialect.field(rel.source, k.local) })));
  const anyNull = SqlText.join(
    rel.keys.map((k) => SqlText.concat([dialect.field(rel.source, k.local), SqlText.raw(' IS NULL')])),
    ' OR ',
  );
  return SqlText.join([SqlText.raw('CASE WHEN'), anyNull, SqlText.raw('THEN NULL ELSE'), object, SqlText.raw('END')], ' ');
}

/**
 * The ordered LOCAL key-column field-refs a relation field-ref expands to in an
 * ORDER BY / GROUP BY position, or `undefined` when `expr` is not a belongs-to
 * relation ref.
 *
 * Ordering an identity is lexicographic over the declared key order and
 * grouping it is structural, and BOTH are exactly what the underlying key
 * columns already give — with the added benefit that the columns are what an
 * index is declared on. Sorting or grouping the assembled JSON object instead
 * would order by the JSON encoding (and, in most dialects, would not even have
 * an operator to do it with).
 */
export function relationKeyRefs(
  expr: Expr,
  engine: QueryEngine,
  typeOf: (source: string) => Type | undefined,
): FieldRefExpr[] | undefined {
  const rel = relationIdentity(expr, engine, typeOf);
  if (!rel) return undefined;
  return rel.keys.map((k) => new FieldRefExpr(rel.source, k.local));
}

/**
 * See through an `output` reference to the select item it names, so a GROUP BY /
 * ORDER BY written as `{kind:'output', name:'author'}` expands to the same key
 * columns a direct field-ref would. `resolve` returns the referenced expr, or
 * the input unchanged for anything else (including an unbound reference, which
 * validation reports on its own).
 */
function throughOutput(expr: Expr, resolve: (name: string) => Expr | undefined): Expr {
  return expr instanceof OutputRefExpr ? resolve(expr.name) ?? expr : expr;
}

/**
 * The ordered SQL key-column fragments an ORDER BY / GROUP BY expands a relation
 * ref to. Emitted via `columnSQL` — a plain `toSQL` would see the relation field
 * again (its key column shares its name) and rebuild the identity object.
 */
export function relationKeySqls(expr: Expr, dialect: Dialect, ctx: SqlContext): SqlText[] | undefined {
  const target = throughOutput(expr, (n) => ctx.scope.output(n));
  return relationKeyRefs(target, ctx.engine, sqlTypeOf(ctx))?.map((r) => r.columnSQL(dialect, ctx));
}

/** The ordered runtime key-column readers a sort/group over a relation expands to. */
export function relationKeyRefsRun(expr: Expr, ctx: RuntimeContext): FieldRefExpr[] | undefined {
  const target = throughOutput(expr, (n) => ctx.outputExpr(n));
  return relationKeyRefs(target, ctx.engine, runtimeTypeOf(ctx));
}
