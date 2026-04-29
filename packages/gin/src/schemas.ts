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
  comment: z
    .string()
    .optional()
    .describe(
      'Optional one-line note explaining why this expression exists. Travels with the node, surfaces in `toCode` as a `/* … */` annotation, and shows up in error paths. Use for non-obvious steps; skip for trivial reads.',
    )
    .meta({ aid: 'Comment' }),
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
    z.object({
      prop: z.string().describe(
        "Named-property access. First step looks up a scope variable by name; subsequent steps read the previous value's prop / method. Reject if the name isn't on the type's `props()`.",
      ),
    }).describe('PROP step — `.<name>` access (scope var on first step, prop/method on later steps).'),
    z.object({
      args: z.record(z.string(), opts.Expr).describe(
        'Map of arg-name → ExprDef. Calls the previous step (a method or any callable). Each arg expression is evaluated in the caller scope before the call; the result obj is bound as `args` inside the call body.',
      ),
      generic: genericSchema(opts).optional().describe(
        'Optional generic-parameter map for parameterized callables (e.g. `list.map<R>` binds `R` to the element type of the result list). Usually unnecessary — most callables infer generics.',
      ),
      catch: opts.Expr.optional().describe(
        'Optional handler expression evaluated if this call throws. The thrown value is bound under `error` in the handler scope.',
      ),
    }).describe('CALL step — invoke the previous step. Comes after a method (e.g. `list.push`) or any callable value.'),
    z.object({
      key: opts.Expr.describe(
        'Indexed-access key expression. Evaluated at run time and passed to the previous value\'s `[key]` get/set surface.',
      ),
    }).describe('INDEX step — `[<key>]` access for types with index signatures (lists by `num`, maps by their key type).'),
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
    loopDynamic: z
      .boolean()
      .optional()
      .describe(
        'When true, `loop over: <this-typed value>` re-evaluates the expression each iteration and exits when the result\'s raw is falsy. Bool uses this for while-loop semantics. The type may have either `loop` (for static iterables) OR `loopDynamic` set; with loopDynamic, no `loop` ExprDef is required.',
      ),
  }).meta({ aid: 'GetSetDef' });
}

/** Shared CallDef schema (for TypeDef.call). */
export function callDefSchema(opts: SchemaOptions): z.ZodTypeAny {
  return z.object({
    docs: z.string().optional(),
    types: z
      .record(z.string(), opts.Type)
      .optional()
      .describe(
        'Call-local type aliases. Declare reusable named types here ONCE and reference them inside `args` / `returns` / `throws` / `get` / `set` as a bare `{name: "<alias>"}`. ' +
        'Aliases process AFTER any enclosing generics (so they may reference generic placeholders) and BEFORE the call slots — the call slots resolve them at parse time. ' +
        'Sequential: later aliases may reference earlier ones; forward / self references throw. Use this whenever the same composite type appears more than once in a signature — instead of writing `num{whole:true, min:1}` four times, declare `{ counter: { name:"num", options:{whole:true,min:1} } }` once and reference `{name:"counter"}`.',
      ),
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
  return extensionSchemaNarrowed(registry, opts, Array.from(baseNames));
}

/**
 * Same as `extensionSchema` but restricts the `extends` enum to the given
 * list of base names. Used by TypType's `toValueSchema` to only permit
 * inline Extensions whose base is compatible with the constraint.
 *
 * If `allowedNames` is empty, the `extends` field becomes `z.never()` —
 * effectively disabling the inline-Extension branch.
 */
export function extensionSchemaNarrowed(
  _registry: Registry,
  opts: SchemaOptions,
  allowedNames: string[],
): z.ZodTypeAny {
  const extendsEnum = allowedNames.length > 0
    ? z.enum(allowedNames as [string, ...string[]])
    : z.never();
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
