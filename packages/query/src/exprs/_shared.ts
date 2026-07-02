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
} from '../resolved-type';
import { isScalar, sourcesOf } from '../resolved-type';
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
