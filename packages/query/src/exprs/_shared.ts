/**
 * Shared helpers for the concrete `Expr` classes: small builders for
 * `ComputedResolved` results and source/nullability/aggregate gathering.
 * Keeps each expr file focused on its own semantics.
 */
import { z } from 'zod';
import type { FieldType } from '../field-type';
import type { QueryDef } from '../schema';
import type {
  ResolvedType,
  FieldResolved,
  ComputedResolved,
  RelationResolved,
} from '../resolved-type';
import { isScalar, sourcesOf, relationOf } from '../resolved-type';
import type { Dialect } from '../sql/dialect';
import type { SqlContext, SqlText } from '../sql/emit';
import {
  BoolFieldType,
  NumberFieldType,
  TextFieldType,
} from '../field-types/index';

/** Build a `ComputedResolved` of an explicit field type. */
export function computed(
  fieldType: FieldType,
  sources: readonly FieldResolved[],
  nullable: boolean,
  aggregate: boolean,
): ComputedResolved {
  return { kind: 'computed', fieldType, sources, nullable, aggregate };
}

/** Build a boolean computed result. */
export function boolResult(
  sources: readonly FieldResolved[],
  nullable: boolean,
  aggregate: boolean = false,
): ComputedResolved {
  return computed(new BoolFieldType(), sources, nullable, aggregate);
}

/** Build a numeric computed result. */
export function numberResult(
  sources: readonly FieldResolved[],
  nullable: boolean,
  aggregate: boolean = false,
): ComputedResolved {
  return computed(new NumberFieldType(), sources, nullable, aggregate);
}

/** Build a text computed result. */
export function textResult(
  sources: readonly FieldResolved[],
  nullable: boolean,
  aggregate: boolean = false,
): ComputedResolved {
  return computed(new TextFieldType(), sources, nullable, aggregate);
}

/** Flatten the backing fields of several resolved types. */
export function gatherSources(rts: ReadonlyArray<ResolvedType>): FieldResolved[] {
  const out: FieldResolved[] = [];
  for (const rt of rts) out.push(...sourcesOf(rt));
  return out;
}

/** Whether any resolved type is a nullable scalar. */
export function anyNullable(rts: ReadonlyArray<ResolvedType>): boolean {
  return rts.some((rt) => isScalar(rt) && rt.nullable);
}

/** Whether any resolved type is (or contains) an aggregate. */
export function anyAggregate(rts: ReadonlyArray<ResolvedType>): boolean {
  return rts.some((rt) => rt.kind === 'computed' && rt.aggregate);
}

/**
 * The category of a resolved value, when scalar (`number` / `text` / …).
 * Types have none.
 */
export function categoryOf(rt: ResolvedType): string | undefined {
  if (rt.kind === 'type') return undefined;
  if (rt.kind === 'field') return rt.field.fieldType.resolve();
  return rt.fieldType.resolve();
}

/**
 * Diagnostic code for a RELATION field-ref used as a scalar VALUE — the
 * correlation bug the join-based model fixes. Shared by every scalar operator.
 */
export const RELATION_VS_VALUE = 'compare.relation-vs-value';

/** The "join it / compare to another relation" hint for a relation-as-value. */
function relationHint(rel: RelationResolved, tail: string): string {
  return (
    `'${rel.source}.${rel.field}' is a relation, not a value — ` +
    `join it (\`{on:{kind:'relation',source:'${rel.source}',field:'${rel.field}',as:'…'}}\`) ` +
    `and compare the joined key, ${tail}`
  );
}

/**
 * The `compare.relation-vs-value` message for a SINGLE relation operand used
 * where only a scalar value is valid (e.g. an arithmetic operand). A relation
 * is never a value in such a position — join it and use the joined scalar key.
 */
export function relationAsValueMessage(rel: RelationResolved): string {
  return relationHint(rel, 'or compare it to another relation of the same target.');
}

/**
 * Check two operands of a scalar operator for a RELATION used as a value.
 * Returns a `compare.relation-vs-value` MESSAGE when the pair is invalid, else
 * `undefined` (the operator then applies its normal scalar checks):
 *  - relation vs a NON-relation operand (a scalar value, or a whole synthetic
 *    Type) → invalid (the correlation bug — join the relation and compare the
 *    joined key instead);
 *  - relation vs a relation of a DIFFERENT target Type → invalid;
 *  - relation vs a relation of the SAME target Type → OK (compared by FK key).
 * The caller exempts params / null literals before calling this.
 */
export function relationValueProblem(a: ResolvedType, b: ResolvedType): string | undefined {
  const ra = relationOf(a);
  const rb = relationOf(b);
  if (!ra && !rb) return undefined;
  if (ra && rb) {
    // Two relations: allowed iff they point at the SAME target Type.
    if (ra.to === rb.to) return undefined;
    return relationHint(
      ra,
      `or compare it to another relation of the same target (it is '${ra.to}', but '${rb.source}.${rb.field}' is '${rb.to}').`,
    );
  }
  // Exactly one side is a relation, compared against a non-relation value.
  const rel = ra ?? rb;
  /* v8 ignore next -- one of ra/rb is defined here (the `!ra && !rb` case returned above) */
  if (!rel) return undefined;
  return relationAsValueMessage(rel);
}

/** A loose `{ kind: string }` placeholder schema for child-expr slots. */
export function looseExprSchema(): z.ZodTypeAny {
  return z.looseObject({ kind: z.string() });
}

/** A child-expr schema slot: the caller's lazy Expr schema, else a loose one. */
export function childExprSchema(Expr?: z.ZodTypeAny): z.ZodTypeAny {
  return Expr ?? looseExprSchema();
}

/** A child-query schema slot: the caller's lazy Query schema, else a loose one. */
export function childQuerySchema(Query?: z.ZodTypeAny): z.ZodTypeAny {
  return Query ?? looseExprSchema();
}

/**
 * Emit a subquery `QueryDef` as a parenthesized SQL fragment. The parsed query
 * derives its own scope (a child of `ctx.scope`, so correlated refs resolve)
 * and its own join/CTE planner, keeping its joins / CTEs scoped to itself.
 */
export function emitSubquerySQL(dialect: Dialect, ctx: SqlContext, def: QueryDef): SqlText {
  return ctx.engine.parseQuery(def).toSQL(dialect, ctx).parens();
}
