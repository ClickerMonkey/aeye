/**
 * gin's model-facing grammar as ONE `@aeye/schema` module.
 *
 * The TypeDef / ExprDef grammar a model writes types and programs in: static
 * named types (one per gin aid — `Type_num`, `Type_object`, `Expr_define`,
 * `New_list`, `PathStep`, `PropDef`, …), recursive through `a.ref('TypeDef')`
 * and `a.ref('Expr')`, plus ONE dynamic step for what depends on the
 * registry and the overrides:
 *
 *  - `TypeDef` — the Type union: the registry's named types (by name, other
 *    keys pass through), one branch per type class, the inline Extension
 *    branch and, with `namedRefs`, any type by its name alone;
 *  - `Type_Extension` — its `extends` is every known type name;
 *  - `Expr` — the union of the registry's expr kinds (tagged by `kind`);
 *  - `Expr_new` — `{ type: TypeDef, value?: any }`, or with `newStrict` one
 *    branch per named type (its own `toNewA()` value) and per class;
 *  - the registry's NAMED TYPES' value schemas, under their names — what a
 *    value schema's `a.ref(name)` (`Type.toA()`) resolves to.
 *
 * The step is keyed by the registry (identity + `version`) and the overrides,
 * so a bind is cached and re-rendering for the next request is free.
 *
 * Use:
 *   buildSchemas(registry).Expr                      // Bound<GinShapes.ExprDef>
 *   GinGrammar.result(a.object({ program: a.ref('Expr') }))
 *     .adapt((ctx: { registry: Registry }) => [ctx.registry, { newStrict: true }])  // a Tool's schema
 *   ginValue(type)                                   // a value of a gin type, bound
 */
import { a, type AnySchema, type Bound, type Bundle, type SchemaOf } from '@aeye/schema';
import type { Registry } from './registry';
import type { Type } from './type';
import type { ValueSchemaOptions } from './node';
import type * as S from './grammar-types';
import { BUILTIN_TYPE_AIDS, extensionA, namedRefA, typeBranchA } from './grammar-parts';

const T = a.ref('TypeDef');
const E = a.ref('Expr');

// schemas.ts baseExprFields
const comment = a.string().optional().describe(
  'Optional one-line note explaining why this expression exists. Travels with the node, surfaces in `toCode` as a `/* … */` annotation, and shows up in error paths. Use for non-obvious steps; skip for trivial reads.',
);

const shared = {
  Generic: a.record(T).describe('Generic-parameter bindings: parameter name → TypeDef.'),
  PathStep: a.union([
    a.object({
      prop: a.string().describe("Named-property access. First step looks up a scope variable by name; subsequent steps read the previous value's prop / method. Reject if the name isn't on the type's `props()`."),
    }).describe('PROP step — `.<name>` access (scope var on first step, prop/method on later steps).'),
    a.object({
      args: a.record(E).describe('Map of arg-name → ExprDef. Calls the previous step (a method or any callable). Each arg expression is evaluated in the caller scope before the call; the result obj is bound as `args` inside the call body.'),
      generic: a.ref('Generic').optional().describe('Optional generic-parameter map for parameterized callables (e.g. `list.map<R>` binds `R` to the element type of the result list). Usually unnecessary — most callables infer generics.'),
      catch: E.optional().describe('Optional handler expression evaluated if this call throws. The thrown value is bound under `error` in the handler scope.'),
    }).describe('CALL step — invoke the previous step, as its OWN step. Comes after a method (e.g. `list.push`) or any callable value; never fused into the prop step as `{prop, args}`.'),
    a.object({
      key: E.describe("Indexed-access key expression. Evaluated at run time and passed to the previous value's `[key]` get/set surface."),
    }).describe('INDEX step — `[<key>]` access for types with index signatures (lists by `num`, maps by their key type).'),
  ]),
  PropDef: a.object({ docs: a.string().optional(), type: T, get: E.optional(), default: E.optional(), set: E.optional() }),
  GetSetDef: a.object({
    docs: a.string().optional(),
    key: T,
    value: T,
    get: E.optional(),
    set: E.optional(),
    loop: E.optional(),
    loopDynamic: a.boolean().optional().describe(
      "When true, `loop over: <this-typed value>` re-evaluates the expression each iteration and exits when the result's raw is falsy. Bool uses this for while-loop semantics. The type may have either `loop` (for static iterables) OR `loopDynamic` set; with loopDynamic, no `loop` ExprDef is required.",
    ),
  }),
  CallDef: a.object({
    docs: a.string().optional(),
    types: a.record(T).optional().describe(
      'Call-local type aliases. Declare reusable named types here ONCE and reference them inside `args` / `returns` / `throws` / `get` / `set` as a bare `{name: "<alias>"}`. '
      + 'Aliases process AFTER any enclosing generics (so they may reference generic placeholders) and BEFORE the call slots — the call slots resolve them at parse time. '
      + 'Sequential: later aliases may reference earlier ones. Use this whenever the same composite type appears more than once in a signature — instead of writing `num{whole:true, min:1}` four times, declare `{ counter: { name:"num", options:{whole:true,min:1} } }` once and reference `{name:"counter"}`.',
    ),
    args: T,
    returns: T.optional(),
    throws: T.optional(),
    get: E.optional(),
    set: E.optional(),
  }),
  InitDef: a.object({ docs: a.string().optional(), args: T, run: E }),
} as const;

/** The built-in type classes, in registry order. */
export const TYPE_CLASS_NAMES = [
  'any', 'void', 'null', 'bool', 'num', 'text', 'list', 'map', 'tuple', 'obj', 'optional', 'nullable', 'not', 'or', 'and',
  'enum', 'literal', 'fn', 'interface', 'typ', 'date', 'timestamp', 'duration', 'color',
] as const;
export type TypeClassName = (typeof TYPE_CLASS_NAMES)[number];

const typeClasses = {
  Type_any: a.object({ name: a.literal('any') }),
  Type_void: a.object({ name: a.literal('void') }),
  Type_null: a.object({ name: a.literal('null') }),
  Type_bool: a.object({ name: a.literal('bool'), options: a.object({ trueText: a.string().optional(), falseText: a.string().optional() }).optional() }),
  Type_num: a.object({
    name: a.literal('num'),
    options: a.object({
      min: a.number().optional().describe('Only set when a real lower bound is part of the spec — e.g. "positive count" → min: 1, "age" → min: 0. Do NOT add `min: 0` to every num just because most numbers happen to be non-negative.'),
      max: a.number().optional().describe('Only set when there is an actual upper bound — a percentage capped at 100, a year capped at 9999. Do NOT pick a generic ceiling like 1000/9999 to fill the field.'),
      whole: a.boolean().optional().describe('Only set to true when the value is genuinely integral (counts, indices, ids). Leave unset (allow fractions) for measurements, ratios, etc.'),
      minPrecision: a.number().optional().describe('Decimal-place floor. Almost never needed; omit unless the spec explicitly requires N decimal places.'),
      maxPrecision: a.number().optional().describe('Decimal-place ceiling. Same rule as minPrecision — omit unless explicitly required.'),
      prefix: a.string().optional().describe('Display-only prefix (e.g. "$"). Has no effect on validation. Omit unless rendering needs it.'),
      suffix: a.string().optional().describe('Display-only suffix (e.g. "%"). Same as prefix — omit unless rendering needs it.'),
    }).optional().describe('Omit entirely for ordinary numbers. Only include when the value has a real, named constraint worth enforcing on every parse.'),
  }),
  Type_text: a.object({
    name: a.literal('text'),
    options: a.object({
      minLength: a.number().optional().describe('Only set when a real lower bound is part of the spec — e.g. "non-empty input" → minLength: 1. Do NOT default to 0.'),
      maxLength: a.number().optional().describe('Only set when there is an actual upper bound — a database column width, an API limit, an explicit "no longer than X chars" rule. Do NOT pick a generic ceiling like 100/200/1000 just to fill the field.'),
      pattern: a.string().optional().describe('Only set for actual format constraints (UUID, ISO date, slug, etc.). Do NOT use ".*" or other accept-anything patterns — they add zero validation and clutter the schema.'),
      flags: a.string().optional().describe('Regex flags (e.g. "i"). Omit unless `pattern` is set AND requires flags.'),
    }).optional().describe('Omit entirely for ordinary strings. Only include when the value has a real, named constraint worth enforcing on every parse.'),
  }),
  Type_list: a.object({
    name: a.literal('list'),
    generic: a.object({ V: T }).optional(),
    options: a.object({ minLength: a.number().optional(), maxLength: a.number().optional() }).optional(),
  }),
  Type_map: a.object({ name: a.literal('map'), generic: a.object({ K: T, V: T }).optional() }),
  Type_tuple: a.object({ name: a.literal('tuple'), options: a.object({ elements: a.array(T) }) }),
  Type_object: a.object({ name: a.literal('obj'), props: a.record(a.ref('PropDef')).optional() }),
  Type_optional: a.object({ name: a.literal('optional'), generic: a.object({ T }).optional() }),
  Type_nullable: a.object({ name: a.literal('nullable'), generic: a.object({ T }).optional() }),
  Type_not: a.object({ name: a.literal('not'), options: a.object({ excluded: T }) }),
  Type_or: a.object({ name: a.literal('or'), options: a.object({ types: a.array(T) }) }),
  Type_and: a.object({ name: a.literal('and'), options: a.object({ types: a.array(T) }) }),
  Type_enum: a.object({ name: a.literal('enum'), generic: a.object({ V: T }).optional(), options: a.object({ values: a.record(a.unknown()) }) }),
  Type_literal: a.object({ name: a.literal('literal'), generic: a.object({ T }).optional(), options: a.object({ value: a.unknown() }) }),
  Type_function: a.object({ name: a.literal('fn'), call: a.ref('CallDef').optional() }),
  Type_interface: a.object({
    name: a.literal('interface'),
    props: a.record(a.ref('PropDef')).optional(),
    get: a.ref('GetSetDef').optional(),
    call: a.ref('CallDef').optional(),
  }),
  Type_typ: a.object({ name: a.literal('typ'), generic: a.object({ T }).optional() }),
  Type_date: a.object({ name: a.literal('date'), options: a.object({ min: a.string().optional(), max: a.string().optional(), utc: a.boolean().optional() }).optional() }),
  Type_timestamp: a.object({
    name: a.literal('timestamp'),
    options: a.object({ min: a.string().optional(), max: a.string().optional(), utc: a.boolean().optional(), precision: a.enum(['ms', 's', 'us']).optional() }).optional(),
  }),
  Type_duration: a.object({ name: a.literal('duration') }),
  Type_color: a.object({ name: a.literal('color'), options: a.object({ hasAlpha: a.boolean().optional() }).optional() }),
} as const;

const exprs = {
  Expr_block: a.object({
    kind: a.literal('block'),
    comment,
    lines: a.array(E).describe("Sequence of expressions evaluated in order. The block's value is the LAST line's value (an empty block returns void). Earlier lines run for their side effects (set, fns.fetch, etc.)."),
  }),
  Expr_define: a.object({
    kind: a.literal('define'),
    comment,
    vars: a.array(a.object({
      name: a.string().describe('Variable name. Must NOT be a reserved name (args, recurse, this, super, key, value, yield, error) and must NOT shadow anything already in scope.'),
      type: T.optional().describe("Optional declared type. OMIT this field when the value already determines the type — every value Expr (`new`, `get`, `if`, ...) is typed, and the var inherits that type. Set this only when you need to widen / narrow / annotate beyond what the value alone produces; a mismatch with the value's inferred type is reported as `define.var.type-mismatch`."),
      value: E.describe("The expression whose result is bound under `name`. May reference any earlier var in this define — each var is added to scope before the next var's value is evaluated."),
    })).describe('Bindings introduced before `body`. Evaluated sequentially, so `vars[i].value` may reference any of `vars[0..i-1]`.'),
    body: E,
  }),
  Expr_flow: a.object({
    kind: a.literal('flow'),
    action: a.enum(['break', 'continue', 'return', 'exit', 'throw']).describe(
      'Which control-flow signal to raise. '
      + '`break`/`continue` only valid inside a loop. '
      + '`return` only valid inside a fn body / lambda; unwinds to the enclosing call with `value`. '
      + '`exit` unwinds all the way to `engine.run`, returning `value` as the program result. '
      + "`throw` raises `error` (caught by a path step's `catch:` handler).",
    ),
    value: E.optional().describe('Required for `return` and `exit` (the value being returned). Ignored by `break` / `continue` / `throw`.'),
    error: E.optional().describe('Required for `throw` — the value to raise. Ignored otherwise.'),
  }),
  Expr_get: a.object({
    kind: a.literal('get'),
    path: a.array(a.ref('PathStep')).describe(
      'Steps walked left-to-right starting from a scope variable. Step shapes: `{prop:"name"}` for prop/method access, `{args:{…}}` to call the previous step, `{key:Expr}` for index access. The first step MUST be a prop step (the scope-var name). A step names exactly ONE shape — a call is its own step, so a method with arguments is `[{"prop":"m"},{"args":{…}}]` and never `{"prop":"m","args":{…}}`. Result is the final step\'s value.',
    ),
  }),
  Expr_if: a.object({
    kind: a.literal('if'),
    comment,
    ifs: a.array(a.object({
      condition: E.describe('Bool-typed expression. First branch whose condition is `true` wins; the rest are skipped.'),
      body: E.describe("Evaluated when this branch's condition is true. The if-expression's value is this body's value."),
    })).describe('Ordered list of `{condition, body}` branches — first true condition wins. Each `condition` must be bool-typed (warned otherwise). With multiple branches this is the gin equivalent of `if / else if / else if`.'),
    else: E.optional().describe('Optional fallback evaluated when every `ifs[i].condition` is false. Without an else, a no-match if-expression evaluates to void.'),
  }),
  Expr_lambda: a.object({
    kind: a.literal('lambda'),
    comment,
    type: T.describe("The lambda's function type — `{ name: \"fn\", call: { args, returns } }` (or a registered named fn type). The `args` obj defines what the body sees under the `args` scope variable; `returns` is what the body must produce."),
    body: E.describe('The lambda body. At runtime, scope contains the lexical scope at definition site PLUS `args` (the call arguments) and `recurse` (this same lambda, for self-calls). Read params via `[{prop:"args"},{prop:"<name>"}]`.'),
    constraint: E.optional().describe('Optional bool-typed precondition evaluated before the body on every call (with `args` in scope). If it returns false, the call throws. Use for input invariants you want enforced regardless of caller.'),
  }),
  Expr_loop: a.object({
    kind: a.literal('loop'),
    comment,
    over: E.describe(
      'The iterable expression. Two evaluation modes: '
      + '(1) iterable types (list, map, etc. — anything whose `get().loop` is defined) iterate once; the expression is evaluated ONCE at the start. '
      + '(2) bool — while-loop semantics: the expression is RE-EVALUATED each iteration; the loop continues while the value is `true` and exits the moment it becomes `false`. '
      + 'Use `flow:break` / `flow:continue` inside the body to control iteration regardless of mode.',
    ),
    body: E.describe("Evaluated once per iteration with the current `key` and `value` bound in scope. Use `{kind:'flow', action:'break'}` or `'continue'` for early-exit. The loop expression itself returns void."),
    key: a.string().optional().describe('Override the scope-variable name the iteration index/key is bound under (default: `key`). Must NOT be reserved or shadow an outer scope var. Use to disambiguate when looping inside another loop.'),
    value: a.string().optional().describe('Override the scope-variable name the iteration value is bound under (default: `value`). Same rules as `key`.'),
    parallel: a.object({
      concurrent: E.optional().describe('Max in-flight iterations as a num (omit / 1 → strictly sequential). Use when iterations are independent I/O — e.g. fetching N URLs concurrently.'),
      rate: E.optional().describe('Minimum interval between iteration starts. Accepts a num (milliseconds) or a duration. Use to rate-limit fan-out (e.g. avoid hammering an API).'),
    }).optional().describe(
      'Opt-in parallelism. Both fields are optional and independent: `concurrent` caps fan-out width, `rate` paces start times. Iterations may finish out of order; the body should not assume sequential ordering. '
      + 'Composes with dynamic (bool while-loop) iteration: the body fans out up to `concurrent`, and `over` is re-evaluated against the outer scope each time a task completes — so accumulating side effects of earlier tasks decide whether more tasks spawn.',
    ),
  }),
  Expr_native: a.object({
    kind: a.literal('native'),
    comment,
    id: a.string().describe('Identifier of a native impl registered via `registry.setNative(id, fn)` (e.g. `list.push`, `num.add`). The model should NOT generate `native` expressions directly — methods on built-in types are reached via `get` paths, which gin resolves to natives internally.'),
    type: T.optional().describe("Optional type to wrap the native's raw return value with when the impl returns a non-Value. Defaults to `any` if omitted."),
  }),
  Expr_set: a.object({
    kind: a.literal('set'),
    comment,
    path: a.array(a.ref('PathStep')).describe('Steps walked left-to-right to a writable target. Single-step `[{prop:"x"}]` re-assigns scope variable `x`. Multi-step targets need the type to support set on the final step (a prop with a `set` ExprDef, an indexed slot, or a method whose call has `set:`).'),
    value: E.describe("The expression evaluated and assigned to the path target. Its type must be compatible with the target's declared type — checked statically as `set.type-mismatch`."),
  }),
  Expr_switch: a.object({
    kind: a.literal('switch'),
    comment,
    value: E.describe("Expression whose result is compared against each case's `equals` candidates. Evaluated once."),
    cases: a.array(a.object({
      equals: a.array(E).describe("Candidate values for this case. The case wins if `value` equals ANY one of them (logical OR). Each candidate's type must be compatible with `value`'s type — checked as `switch.case.type`."),
      body: E.describe("Evaluated when this case wins. The switch expression's value is this body's value."),
    })).describe('Ordered list of cases — first match wins. Cases are NOT fall-through; only the matching case\'s body runs.'),
    else: E.optional().describe('Optional fallback evaluated when no case matches. Without an else, a no-match switch evaluates to void.'),
  }),
  Expr_template: a.object({
    kind: a.literal('template'),
    template: a.union([E, a.string()]).describe('The template string — either a literal string (auto-wrapped as `new text`) or an Expr that evaluates to text. Placeholders use `{name}` syntax; each `name` is looked up first in `params` (when supplied) and then in the surrounding scope.'),
    params: E.optional().describe('Optional obj-typed expression supplying placeholder values. When omitted or when a key is missing, `{name}` falls back to a scope lookup of the same name — so a `${baseUrl}` placeholder resolves to a surrounding `define baseUrl = ...`. Provide `params` only when placeholders need values not already in scope (or to override scope values).'),
  }),
} as const;

/** The built-in expr kinds, in registry order. */
export const EXPR_KINDS = ['new', 'get', 'set', 'define', 'block', 'if', 'switch', 'loop', 'lambda', 'template', 'flow', 'native'] as const;

const DATE_RE = '^\\d{4}-\\d{2}-\\d{2}';
const TIMESTAMP_RE = '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?$';

/** Each built-in class's class-level `new` value (its static `toNewSchema`). */
const CLASS_NEW_VALUE: { readonly [K in TypeClassName]: AnySchema } = {
  any: a.unknown(),
  void: a.null(),
  null: a.null(),
  bool: a.boolean(),
  num: a.number(),
  text: a.string(),
  list: a.array(E),
  map: a.array(a.object({ key: E, value: E })),
  tuple: a.array(E),
  obj: a.record(E),
  optional: E,
  nullable: a.nullable(E),
  not: a.unknown(),
  or: E,
  and: E,
  enum: a.union([a.string(), a.number()]),
  literal: a.unknown(),
  fn: a.union([a.string(), a.object({ kind: a.string() })]),
  interface: a.record(E),
  typ: T,
  date: a.string().pattern(DATE_RE),
  timestamp: a.string().pattern(TIMESTAMP_RE),
  // duration / color: their init args
  duration: a.object({ days: a.number().optional(), hours: a.number().optional(), minutes: a.number().optional(), seconds: a.number().optional(), ms: a.number().optional() }),
  color: a.object({ r: a.int().min(0).max(255), g: a.int().min(0).max(255), b: a.int().min(0).max(255), a: a.number().min(0).max(1).optional() }),
};

const newClassBranch = (cls: string, type: AnySchema, value: AnySchema) =>
  a.object({
    kind: a.literal('new'),
    type: type.describe(`Full TypeDef for a \`${cls}\` instance (name + options + per-class fields).`),
    value: a.optional(value).describe(`Initial value matching this \`${cls}\` instance. Composites accept Expr slots; primitives accept their raw form.`),
  });

const newClassBranches = Object.fromEntries(
  TYPE_CLASS_NAMES.map((c) => [`New_${c}`, newClassBranch(c, a.ref(BUILTIN_TYPE_AIDS[c]!), CLASS_NEW_VALUE[c])]),
) as unknown as { readonly [K in TypeClassName as `New_${K}`]: AnySchema };

const newDefault = a.object({
  kind: a.literal('new'),
  type: T.describe('TypeDef of the value being constructed. The `value` field is interpreted relative to this type — primitives take their raw form (`new num` → number), composites take Expr slots (`new list` → Expr[]).'),
  value: a.unknown().optional().describe('Initial value matching `type`. Optional when the type has a defined `init` constructor or a sensible default (empty list, zero num with no constraints, etc.).'),
});

// ============================================================================
// The registry part
// ============================================================================

/** `buildSchemas` overrides. */
export interface BuildSchemasOverrides {
  /** Offer these named types too (explicit ones win over the registry's of the same name). */
  types?: Type[];
  /** Lock `new` to a union over every constructible type: each named type with its own value, each class. */
  newStrict?: boolean;
  /**
   * Also accept a named type by its name alone (`{ name: 'ns/Name' }`), for types a scope resolves that the registry
   * doesn't hold (a host's stored types). The name is checked when the TypeDef is parsed, not by the schema.
   */
  namedRefs?: boolean;
  /** Deprecated (unused): reserved for constraining get paths. */
  exprs?: unknown[];
}

/** What the dynamic step supplies, typed. */
export type GrammarDeclared = { TypeDef: S.TypeDef; Type_Extension: S.TypeExtension; Expr_new: S.NewExpr; Expr: S.ExprDef };

const STATIC_NAMES = new Set<string>([
  ...Object.keys(shared), ...Object.keys(typeClasses), ...Object.keys(exprs), ...Object.keys(newClassBranches),
  'TypeDef', 'Type_Extension', 'Expr_new', 'Expr',
]);

const tagged = (tag: string, options: readonly AnySchema[]): AnySchema =>
  options.length === 0 ? a.never() : options.length === 1 ? options[0]! : a.discriminatedUnion(tag, options as never);

/** The named types the grammar offers: explicit `types` first, then the registry's. */
function namedList(registry: Registry, o: BuildSchemasOverrides | undefined): Map<string, Type> {
  const byName = new Map<string, Type>();
  for (const t of o?.types ?? []) byName.set(t.name, t);
  for (const t of registry.namedTypeList()) if (!byName.has(t.name)) byName.set(t.name, t);
  return byName;
}

/** The dynamic step: what the registry and the overrides decide. */
export function grammarDefs(registry: Registry, o?: BuildSchemasOverrides) {
  const named = namedList(registry, o);
  const names = [...named.keys()];
  const classes = registry.typeClasses();
  const branches: AnySchema[] = [
    ...names.map((n) => a.object({ name: a.literal(n) }).describe(`The registered named type \`${n}\`, by name.`)),
    ...classes.map((c) => typeBranchA(registry, c.NAME)),
    a.ref('Type_Extension'),
  ];
  if (o?.namedRefs) branches.push(namedRefA());
  const Type_Extension = extensionA([...classes.map((c) => c.NAME), ...names]);

  const exprBranches = registry.exprClassList().map((cls) =>
    (EXPR_KINDS as readonly string[]).includes(cls.KIND) && cls.KIND !== 'new'
      ? a.ref(`Expr_${cls.KIND}`)
      : cls.KIND === 'new'
        ? a.ref('Expr_new')
        : (cls.toA?.() ?? a.object({ kind: a.literal(cls.KIND) }).describe(`A \`${cls.KIND}\` expression.`)));

  let Expr_new: AnySchema = newDefault;
  const newNamed: Record<string, AnySchema> = {};
  if (o?.newStrict) {
    const inst = [...named].map(([n, t]): AnySchema => {
      const branch = a.object({
        kind: a.literal('new'),
        type: a.object({ name: a.literal(n) }).describe(`Reference to the registered named type \`${n}\` — name-only, the registry resolves it to its full definition.`),
        value: a.optional(t.toNewA()).describe(`Initial value for the new \`${n}\` instance. Each composite slot accepts an Expr (Get, NewExpr, etc.); per-slot type correctness is enforced at runtime.`),
      });
      // Named `New_<name>` (gin's aid), so it is written once.
      if (STATIC_NAMES.has(`New_${n}`) || named.has(`New_${n}`)) return branch;
      newNamed[`New_${n}`] = branch;
      return a.ref(`New_${n}`);
    });
    const cls = classes.map((c) =>
      BUILTIN_TYPE_AIDS[c.NAME] !== undefined && (TYPE_CLASS_NAMES as readonly string[]).includes(c.NAME)
        ? a.ref(`New_${c.NAME}`)
        : newClassBranch(c.NAME, typeBranchA(registry, c.NAME), c.toNewA?.() ?? a.unknown()));
    Expr_new = a.union([...inst, ...cls]);
  }

  // The named types' own value schemas: what `Type.toA()`'s refs resolve to.
  const values: Record<string, AnySchema> = {};
  for (const [n, t] of named) {
    if (STATIC_NAMES.has(n)) continue;
    values[n] = t.defineA({ includeDocs: 'all' });
  }

  return {
    ...values,
    ...newNamed,
    TypeDef: tagged('name', branches) as SchemaOf<S.TypeDef>,
    Type_Extension: Type_Extension as SchemaOf<S.TypeExtension>,
    Expr_new: Expr_new as SchemaOf<S.NewExpr>,
    Expr: tagged('kind', exprBranches) as SchemaOf<S.ExprDef>,
  };
}

const registryIds = new WeakMap<Registry, number>();
let nextRegistryId = 0;
const registryId = (r: Registry): number => {
  let id = registryIds.get(r);
  if (id === undefined) registryIds.set(r, (id = ++nextRegistryId));
  return id;
};

/** The bind cache key: the registry (identity + version) and the overrides. */
export const grammarKey = (registry: Registry, o?: BuildSchemasOverrides): string =>
  `${registryId(registry)}:${registry.version}|${o?.newStrict ? 's' : ''}${o?.namedRefs ? 'r' : ''}|${(o?.types ?? []).map((t) => t.name).join(',')}`;

/** The static grammar, before the registry part (for a module that adds its own dynamic step). */
export const GinGrammarStatic = a
  .define(shared)
  .define(typeClasses)
  .define(exprs)
  .define(newClassBranches)
  .declare<GrammarDeclared>();

/**
 * gin's grammar module: the static grammar plus the registry part, bound per
 * `(registry, overrides?)`. Pick results from it (`GinGrammar.result('Expr')`,
 * `GinGrammar.result(a.object({ name: a.string(), def: a.ref('TypeDef') }))`).
 */
export const GinGrammar = GinGrammarStatic
  .dynamic((registry: Registry, overrides?: BuildSchemasOverrides) => grammarDefs(registry, overrides), { key: grammarKey, cacheSize: 8 });

/** A TypeDef (`buildSchemas(r).Type`). */
export const TypeDefSchema: Bundle<S.TypeDef, [Registry, BuildSchemasOverrides?]> = GinGrammar.result('TypeDef');
/** A program (`buildSchemas(r).Expr`). */
export const ExprSchema: Bundle<S.ExprDef, [Registry, BuildSchemasOverrides?]> = GinGrammar.result('Expr');

/** `buildSchemas`' result: the grammar's two roots, bound for one registry. */
export interface GinSchemas {
  /** Any TypeDef. */
  readonly Type: Bound<S.TypeDef>;
  /** Any program (ExprDef). */
  readonly Expr: Bound<S.ExprDef>;
}

/**
 * The grammar bound for a registry: `Type` (a TypeDef) and `Expr` (a
 * program), as `@aeye/schema` bounds (render per model, decode, errors for
 * the model). Cached per registry version and overrides. To compose a tool's
 * arguments, use `GinGrammar.result(...)` instead.
 */
export function buildSchemas(registry: Registry, overrides: BuildSchemasOverrides = {}): GinSchemas {
  return { Type: TypeDefSchema.bind(registry, overrides), Expr: ExprSchema.bind(registry, overrides) };
}

const valueBundles = new WeakMap<Type, Map<string, { readonly version: number; readonly bundle: Bundle<unknown, [Registry, BuildSchemasOverrides?]> }>>();

/**
 * A value of a gin type, as a bound `a` schema: `type.toA(opts)` resolved
 * against the grammar (its `typ` / `fn` slots, its named types) for the
 * type's registry, named types accepted by name (`namedRefs`). Memoized per
 * type and options (not with a `scope`) until the registry changes.
 */
export function ginValue<T = unknown>(type: Type, opts?: ValueSchemaOptions): Bound<T> {
  return ginValueBundle(type, opts).bind(type.registry, { namedRefs: true }) as Bound<T>;
}

/** `ginValue`'s bundle, before binding: for a module or tool that binds it itself. */
export function ginValueBundle(type: Type, opts?: ValueSchemaOptions): Bundle<unknown, [Registry, BuildSchemasOverrides?]> {
  const version = type.registry.version;
  const key = opts?.scope ? undefined : `${opts?.includeDocs ?? 'none'}|${opts?.unknownKeys ?? 'strip'}`;
  const memo = key === undefined ? undefined : valueBundles.get(type)?.get(key);
  if (memo && memo.version === version) return memo.bundle;
  const bundle = GinGrammar.result(type.toA(opts) as never) as unknown as Bundle<unknown, [Registry, BuildSchemasOverrides?]>;
  if (key !== undefined) {
    let m = valueBundles.get(type);
    if (!m) valueBundles.set(type, (m = new Map()));
    m.set(key, { version, bundle });
  }
  return bundle;
}
