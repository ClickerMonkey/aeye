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

/** Shared ExprDef fields (just `comment`). */
export const baseExprFields: z.ZodRawShape = {
  comment: z.string().optional().meta({ aid: 'Comment' }),
};

/** Shared generic-parameter map (`{ [name]: Type }`). Used inline by
 *  list/map/optional/etc. for their specific shapes, and by the Extension
 *  schema for user-declared type parameters. */
export function genericSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.record(z.string(), opts.Type).meta({ aid: 'Generic' });
}

/** Shared PathStep union used by GetExpr/SetExpr. */
export function pathStepSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.union([
    z.object({ prop: z.string() }),
    z.object({
      args: z.record(z.string(), opts.Expr),
      generic: genericSchema(opts).optional(),
      catch: opts.Expr.optional(),
    }),
    z.object({ key: opts.Expr }),
  ]).meta({ aid: 'PathStep' });
}

/** Shared PropDef schema. */
export function propDefSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.object({
    docs: z.string().optional(),
    type: opts.Type,
    get: opts.Expr.optional(),
    default: opts.Expr.optional(),
    set: opts.Expr.optional(),
  }).meta({ aid: 'PropDef' });
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
  }).meta({ aid: 'GetSetDef' });
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
  }).meta({ aid: 'CallDef' });
}

/** Shared init schema (for TypeDef.init). */
export function initDefSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.object({
    docs: z.string().optional(),
    args: opts.Type,
    run: opts.Expr,
  }).meta({ aid: 'InitDef' });
}

/**
 * Extension TypeDef — defines a NEW named type atop an existing one.
 * `extends` is an enum of every known base type (class names + registered
 * named types) so the LLM can't reference a name that doesn't exist.
 *
 * Shape:
 *   {
 *     name: <user-chosen>,
 *     extends: <one of the registry's known type names>,
 *     satisfies?, docs?, generic?, options?,
 *     props?, get?, call?, init?, constraint?,
 *   }
 */
function extensionSchema(registry: Registry, opts: SchemaOptions): z.ZodTypeAny {
  const baseNames = new Set<string>();
  for (const c of registry.typeClasses()) baseNames.add(c.NAME);
  for (const t of registry.namedTypeList()) baseNames.add(t.name);
  const names = Array.from(baseNames);
  const extendsEnum = names.length > 0
    ? z.enum(names as [string, ...string[]])
    : z.string();
  return z.object({
    name: z.string(),
    extends: extendsEnum,
    docs: z.string().optional(),
    satisfies: z.array(z.string()).optional(),
    generic: genericSchema(opts).optional(),
    options: z.record(z.string(), z.any()).optional(),
    props: z.record(z.string(), propDefSchema(opts)).optional(),
    get: getSetDefSchema(opts).optional(),
    call: callDefSchema(opts).optional(),
    init: initDefSchema(opts).optional(),
    constraint: opts.Expr.optional(),
  }).meta({ aid: 'Type_Extension' });
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
    registry,
    newStrict: overrides.newStrict,
  };
  opts.Type = z.lazy(() => {
    // Named-instance branches come first so the LLM sees registered user
    // types (e.g. `Task`) as first-class choices. Dedup by name — explicit
    // `opts.types` wins over the registry's registered list.
    const byName = new Map<string, Type>();
    for (const t of opts.types) byName.set(t.name, t);
    for (const t of registry.namedTypeList()) {
      if (!byName.has(t.name)) byName.set(t.name, t);
    }
    const instanceBranches = Array.from(byName.values()).map((t) =>
      z.object({ name: z.literal(t.name) }).passthrough()
        .meta({ aid: t.name }),
    );
    // Class-level fallback branches keep built-in structural types working
    // (num, object, list, etc.). Each class's `toSchema` already attaches
    // its own `aid` — we don't wrap here.
    const classBranches = registry.typeClasses().map((c) => c.toSchema(opts));
    // Extension branch — for the LLM to declare a NEW named type inline.
    const all = [...instanceBranches, ...classBranches, extensionSchema(registry, opts)];
    return all.length > 1
      ? (z.union(all as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]))
      : (all[0] ?? z.never());
  }).meta({ aid: 'Type' });
  opts.Expr = z.lazy(() => {
    const schemas = registry.exprClassList().map((c) => c.toSchema(opts));
    return schemas.length > 1
      ? (z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]))
      : (schemas[0] ?? z.never());
  }).meta({ aid: 'Expr' });
  return opts;
}
