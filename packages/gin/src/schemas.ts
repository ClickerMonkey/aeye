import { z } from 'zod';
import type { Registry } from './registry';
import type { SchemaOptions } from './node';
import type { Expr } from './expr';
import type { Type } from './type';

/**
 * TypeDef/ExprDef Zod schemas.
 *
 * Every Type class and Expr class has a `static toSchema(opts): z.ZodTypeAny`
 * that produces its JSON shape as a Zod schema — with recursive positions
 * filled by `opts.Type` / `opts.Expr`. `buildSchemas(registry)` wires the
 * union using `z.lazy` so recursion resolves lazily.
 */

export type { SchemaOptions } from './node';

/** Shared TypeDef fields common to every Type (docs, extends, satisfies,
 *  generic). Concrete types mix this in via `.extend(...)`. */
export function baseTypeFields(opts: SchemaOptions): z.ZodRawShape {
  return {
    docs: z.string().optional(),
    extends: z.string().optional(),
    satisfies: z.array(z.string()).optional(),
    generic: z.record(z.string(), opts.Type).optional(),
  };
}

/** Shared ExprDef fields (just `comment`). */
export const baseExprFields: z.ZodRawShape = {
  comment: z.string().optional(),
};

/** Shared PathStep union used by GetExpr/SetExpr. */
export function pathStepSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.union([
    z.object({ prop: z.string() }),
    z.object({
      args: z.record(z.string(), opts.Expr),
      generic: z.record(z.string(), opts.Type).optional(),
      catch: opts.Expr.optional(),
    }),
    z.object({ key: opts.Expr }),
  ]);
}

/** Shared PropDef schema. */
export function propDefSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.object({
    docs: z.string().optional(),
    type: opts.Type,
    get: opts.Expr.optional(),
    default: opts.Expr.optional(),
    set: opts.Expr.optional(),
  });
}

/** Shared GetSetDef schema (for TypeDef.get). */
export function getSetDefSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.object({
    docs: z.string().optional(),
    key: opts.Type,
    value: opts.Type,
    get: opts.Expr.optional(),
    set: opts.Expr.optional(),
    loop: opts.Expr.optional(),
  });
}

/** Shared CallDef schema (for TypeDef.call). */
export function callDefSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.object({
    docs: z.string().optional(),
    args: opts.Type,
    returns: opts.Type.optional(),
    throws: opts.Type.optional(),
    get: opts.Expr.optional(),
    set: opts.Expr.optional(),
  });
}

/** Shared init schema (for TypeDef.init). */
export function initDefSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.object({
    docs: z.string().optional(),
    args: opts.Type,
    run: opts.Expr,
  });
}

/**
 * Extra per-call overrides for `buildSchemas`. `types`/`exprs` enumerate
 * the specific instances available to LLM consumers; `newStrict` locks
 * NewExpr's schema to a union over `types`.
 */
export interface BuildSchemasOverrides {
  types?: Type[];
  exprs?: Expr[];
  newStrict?: boolean;
}

/**
 * Build a pair of Zod schemas — Type and Expr — covering every class the
 * Registry knows about. Pass the pair to any `cls.toSchema(opts)` call;
 * the returned schemas are lazy, so recursion resolves on-demand.
 */
export function buildSchemas(registry: Registry, overrides: BuildSchemasOverrides = {}): SchemaOptions {
  const opts: SchemaOptions = {
    Type: null as unknown as z.ZodTypeAny,
    Expr: null as unknown as z.ZodTypeAny,
    types: overrides.types ?? [],
    exprs: overrides.exprs ?? [],
    newStrict: overrides.newStrict,
  };
  opts.Type = z.lazy(() => {
    const schemas = registry.typeClasses().map((c) => c.toSchema(opts));
    return schemas.length > 1
      ? (z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]))
      : (schemas[0] ?? z.never());
  });
  opts.Expr = z.lazy(() => {
    const schemas = registry.exprClassList().map((c) => c.toSchema(opts));
    return schemas.length > 1
      ? (z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]))
      : (schemas[0] ?? z.never());
  });
  return opts;
}
