/**
 * CORPUS: gin's model-facing grammar — the FULL `buildSchemas(registry,
 * overrides)` (packages/gin/src/schemas.ts:212) as one `a` module.
 *
 * gin today: every Type class and Expr class has `static toSchema(opts)`;
 * `buildSchemas` wires `opts.Type` / `opts.Expr` as `z.lazy` unions rebuilt
 * when the registry's counts change (the `keptLazy` workaround,
 * schemas.ts:222), with `aid` meta promoting each branch to `$defs`.
 *
 * Here: the grammar is STATIC defs (one per gin aid: `Type_num`,
 * `Expr_define`, `PathStep`, `PropDef`, ...), and ONE dynamic step supplies
 * what depends on the registry and the overrides:
 *   - `TypeDef`  — the Type union: the registry's named types (name-only
 *     branches, schemas.ts:231), the 24 class branches, the Extension branch
 *     and, with `namedRefs`, the bare named-type ref (schemas.ts:245);
 *   - `Type_Extension` — its `extends` is an enum of every known type name
 *     (schemas.ts:143);
 *   - `Expr_new` — default `{ type: TypeDef, value?: any }`, or with
 *     `newStrict` the union of per-class and per-named-type branches
 *     (exprs/new.ts:59).
 * The dynamic step is keyed by registry version + overrides, so the
 * `keptLazy` workaround disappears: a bind is cached, recursion is `a.ref`.
 *
 * Names: the union gin calls `Type` (aid) is `TypeDef` here, because that is
 * the name `fromGin` uses for `typ` values (and `Expr` for `fn` values), so
 * a converted value schema and this grammar share one module.
 */
import { expectTypeOf } from 'expect-type';
import { a, fromGin, UnionType, type AnySchema, type GinRegistryLike, type GinTypeDef, type SchemaOf } from '../../index';

// ============================================================================
// Code-side types (structurally gin's TypeDef / ExprDef, schema.ts:10-196,
// narrowed per class as each class's toSchema writes it)
// ============================================================================

/** schema.ts:31 */
export interface PropDefT { docs?: string; type: TypeDefT; get?: ExprDefT; default?: ExprDefT; set?: ExprDefT }
/** schema.ts:39 */
export interface GetSetDefT { docs?: string; key: TypeDefT; value: TypeDefT; get?: ExprDefT; set?: ExprDefT; loop?: ExprDefT; loopDynamic?: boolean }
/** schema.ts:59 */
export interface CallDefT { docs?: string; types?: Record<string, TypeDefT>; args: TypeDefT; returns?: TypeDefT; throws?: TypeDefT; get?: ExprDefT; set?: ExprDefT }
/** schema.ts:17 */
export interface InitDefT { docs?: string; args: TypeDefT; run: ExprDefT }
export type GenericT = Record<string, TypeDefT>;

export interface TypeAnyT { name: 'any' }
export interface TypeVoidT { name: 'void' }
export interface TypeNullT { name: 'null' }
export interface TypeBoolT { name: 'bool'; options?: { trueText?: string; falseText?: string } }
export interface TypeNumT {
  name: 'num';
  options?: { min?: number; max?: number; whole?: boolean; minPrecision?: number; maxPrecision?: number; prefix?: string; suffix?: string };
}
export interface TypeTextT { name: 'text'; options?: { minLength?: number; maxLength?: number; pattern?: string; flags?: string } }
export interface TypeListT { name: 'list'; generic?: { V: TypeDefT }; options?: { minLength?: number; maxLength?: number } }
export interface TypeMapT { name: 'map'; generic?: { K: TypeDefT; V: TypeDefT } }
export interface TypeTupleT { name: 'tuple'; options: { elements: TypeDefT[] } }
export interface TypeObjectT { name: 'obj'; props?: Record<string, PropDefT> }
export interface TypeOptionalT { name: 'optional'; generic?: { T: TypeDefT } }
export interface TypeNullableT { name: 'nullable'; generic?: { T: TypeDefT } }
export interface TypeNotT { name: 'not'; options: { excluded: TypeDefT } }
export interface TypeOrT { name: 'or'; options: { types: TypeDefT[] } }
export interface TypeAndT { name: 'and'; options: { types: TypeDefT[] } }
export interface TypeEnumT { name: 'enum'; generic?: { V: TypeDefT }; options: { values: Record<string, unknown> } }
export interface TypeLiteralT { name: 'literal'; generic?: { T: TypeDefT }; options: { value: unknown } }
export interface TypeFunctionT { name: 'fn'; call?: CallDefT }
export interface TypeInterfaceT { name: 'interface'; props?: Record<string, PropDefT>; get?: GetSetDefT; call?: CallDefT }
export interface TypeTypT { name: 'typ'; generic?: { T: TypeDefT } }
export interface TypeDateT { name: 'date'; options?: { min?: string; max?: string; utc?: boolean } }
export interface TypeTimestampT { name: 'timestamp'; options?: { min?: string; max?: string; utc?: boolean; precision?: 'ms' | 's' | 'us' } }
export interface TypeDurationT { name: 'duration' }
export interface TypeColorT { name: 'color'; options?: { hasAlpha?: boolean } }
/** schemas.ts:166 — a NEW named type declared inline. */
export interface TypeExtensionT {
  name: string;
  extends: string;
  docs?: string;
  satisfies?: string[];
  generic?: GenericT;
  options?: Record<string, unknown>;
  props?: Record<string, PropDefT>;
  get?: GetSetDefT;
  call?: CallDefT;
  init?: InitDefT;
  constraint?: ExprDefT;
}
/** schemas.ts:231 (a registered name; other keys pass through) / schemas.ts:245 (namedRefs). */
export interface TypeNamedT { name: string }

export type TypeClassT =
  | TypeAnyT | TypeVoidT | TypeNullT | TypeBoolT | TypeNumT | TypeTextT | TypeListT | TypeMapT | TypeTupleT | TypeObjectT
  | TypeOptionalT | TypeNullableT | TypeNotT | TypeOrT | TypeAndT | TypeEnumT | TypeLiteralT | TypeFunctionT | TypeInterfaceT
  | TypeTypT | TypeDateT | TypeTimestampT | TypeDurationT | TypeColorT;
export type TypeDefT = TypeNamedT | TypeClassT | TypeExtensionT;

/** schema.ts:93 */
export type PathStepT = { prop: string } | { args: Record<string, ExprDefT>; generic?: GenericT; catch?: ExprDefT } | { key: ExprDefT };

export interface BlockExprT { kind: 'block'; comment?: string; lines: ExprDefT[] }
export interface DefineExprT { kind: 'define'; comment?: string; vars: { name: string; type?: TypeDefT; value: ExprDefT }[]; body: ExprDefT }
export interface FlowExprT { kind: 'flow'; action: 'break' | 'continue' | 'return' | 'exit' | 'throw'; value?: ExprDefT; error?: ExprDefT }
export interface GetExprT { kind: 'get'; path: PathStepT[] }
export interface IfExprT { kind: 'if'; comment?: string; ifs: { condition: ExprDefT; body: ExprDefT }[]; else?: ExprDefT }
export interface LambdaExprT { kind: 'lambda'; comment?: string; type: TypeDefT; body: ExprDefT; constraint?: ExprDefT }
export interface LoopExprT {
  kind: 'loop'; comment?: string; over: ExprDefT; body: ExprDefT; key?: string; value?: string;
  parallel?: { concurrent?: ExprDefT; rate?: ExprDefT };
}
export interface NativeExprT { kind: 'native'; comment?: string; id: string; type?: TypeDefT }
export interface NewExprT { kind: 'new'; type: TypeDefT; value?: unknown }
export interface SetExprT { kind: 'set'; comment?: string; path: PathStepT[]; value: ExprDefT }
export interface SwitchExprT { kind: 'switch'; comment?: string; value: ExprDefT; cases: { equals: ExprDefT[]; body: ExprDefT }[]; else?: ExprDefT }
export interface TemplateExprT { kind: 'template'; template: ExprDefT | string; params?: ExprDefT }
export type ExprDefT =
  | NewExprT | GetExprT | SetExprT | DefineExprT | BlockExprT | IfExprT | SwitchExprT | LoopExprT | LambdaExprT | TemplateExprT | FlowExprT | NativeExprT;

// ============================================================================
// Shared parts (schemas.ts)
// ============================================================================

/** gin's TYPE_NAME (type-name.ts:20). */
export const TYPE_NAME = '^(?:\\w[\\w-]*\\/)*\\w+$';
const typeName = () => a.string().pattern(TYPE_NAME);

// schemas.ts:21 baseExprFields
const comment = a.string().optional().describe(
  'Optional one-line note explaining why this expression exists. Travels with the node, surfaces in `toCode` as a `/* … */` annotation, and shows up in error paths. Use for non-obvious steps; skip for trivial reads.',
);
/**
 * A union picked by a literal field whose options are NAMED (refs), so each
 * branch keeps its own `$defs` entry (gin's aids) and errors point inside
 * the branch the tag picks. GAP discriminated-union-refs:
 * `a.discriminatedUnion` only takes inline object options at the type level
 * (the runtime derefs refs fine), so this builds the class directly.
 */
const byTag = <const O extends readonly [AnySchema, ...AnySchema[]]>(tag: string, options: O): UnionType<O> => new UnionType(options, tag);
// @ts-expect-error GAP discriminated-union-refs: refs are not accepted as options.
a.discriminatedUnion('kind', [a.ref('Expr_get'), a.ref('Expr_set')]);

const T = a.ref('TypeDef');
const E = a.ref('Expr');

const shared = {
  // schemas.ts:35 genericSchema
  Generic: a.record(T),
  // schemas.ts:40 pathStepSchema
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
  // schemas.ts:68 propDefSchema
  PropDef: a.object({ docs: a.string().optional(), type: T, get: E.optional(), default: E.optional(), set: E.optional() }),
  // schemas.ts:79 getSetDefSchema
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
  // schemas.ts:98 callDefSchema
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
  // schemas.ts:120 initDefSchema
  InitDef: a.object({ docs: a.string().optional(), args: T, run: E }),
} as const;

// ============================================================================
// Type classes (types/*.ts static toSchema), aid `Type_<class>`
// ============================================================================

export const TYPE_CLASS_NAMES = [
  'any', 'void', 'null', 'bool', 'num', 'text', 'list', 'map', 'tuple', 'obj', 'optional', 'nullable', 'not', 'or', 'and',
  'enum', 'literal', 'fn', 'interface', 'typ', 'date', 'timestamp', 'duration', 'color',
] as const;
export type TypeClassName = (typeof TYPE_CLASS_NAMES)[number];

/** gin's aid per class (obj → Type_object, fn → Type_function). */
export const TYPE_AID: { readonly [K in TypeClassName]: `Type_${string}` } = {
  any: 'Type_any', void: 'Type_void', null: 'Type_null', bool: 'Type_bool', num: 'Type_num', text: 'Type_text', list: 'Type_list',
  map: 'Type_map', tuple: 'Type_tuple', obj: 'Type_object', optional: 'Type_optional', nullable: 'Type_nullable', not: 'Type_not',
  or: 'Type_or', and: 'Type_and', enum: 'Type_enum', literal: 'Type_literal', fn: 'Type_function', interface: 'Type_interface',
  typ: 'Type_typ', date: 'Type_date', timestamp: 'Type_timestamp', duration: 'Type_duration', color: 'Type_color',
};

const typeClasses = {
  Type_any: a.object({ name: a.literal('any') }), // types/any.ts:28
  Type_void: a.object({ name: a.literal('void') }), // types/void.ts:28
  Type_null: a.object({ name: a.literal('null') }), // types/null.ts:29
  // types/bool.ts:28
  Type_bool: a.object({ name: a.literal('bool'), options: a.object({ trueText: a.string().optional(), falseText: a.string().optional() }).optional() }),
  // types/num.ts:37
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
  // types/text.ts:36
  Type_text: a.object({
    name: a.literal('text'),
    options: a.object({
      minLength: a.number().optional().describe('Only set when a real lower bound is part of the spec — e.g. "non-empty input" → minLength: 1. Do NOT default to 0.'),
      maxLength: a.number().optional().describe('Only set when there is an actual upper bound — a database column width, an API limit, an explicit "no longer than X chars" rule. Do NOT pick a generic ceiling like 100/200/1000 just to fill the field.'),
      pattern: a.string().optional().describe('Only set for actual format constraints (UUID, ISO date, slug, etc.). Do NOT use ".*" or other accept-anything patterns — they add zero validation and clutter the schema.'),
      flags: a.string().optional().describe('Regex flags (e.g. "i"). Omit unless `pattern` is set AND requires flags.'),
    }).optional().describe('Omit entirely for ordinary strings. Only include when the value has a real, named constraint worth enforcing on every parse.'),
  }),
  // types/list.ts:43
  Type_list: a.object({
    name: a.literal('list'),
    generic: a.object({ V: T }).optional(),
    options: a.object({ minLength: a.number().optional(), maxLength: a.number().optional() }).optional(),
  }),
  Type_map: a.object({ name: a.literal('map'), generic: a.object({ K: T, V: T }).optional() }), // types/map.ts:55
  Type_tuple: a.object({ name: a.literal('tuple'), options: a.object({ elements: a.array(T) }) }), // types/tuple.ts:63
  Type_object: a.object({ name: a.literal('obj'), props: a.record(a.ref('PropDef')).optional() }), // types/obj.ts:42
  Type_optional: a.object({ name: a.literal('optional'), generic: a.object({ T }).optional() }), // types/optional.ts:35
  Type_nullable: a.object({ name: a.literal('nullable'), generic: a.object({ T }).optional() }), // types/nullable.ts:34
  Type_not: a.object({ name: a.literal('not'), options: a.object({ excluded: T }) }), // types/not.ts:35
  Type_or: a.object({ name: a.literal('or'), options: a.object({ types: a.array(T) }) }), // types/or.ts:45
  Type_and: a.object({ name: a.literal('and'), options: a.object({ types: a.array(T) }) }), // types/and.ts:48
  // types/enum.ts:36
  Type_enum: a.object({ name: a.literal('enum'), generic: a.object({ V: T }).optional(), options: a.object({ values: a.record(a.unknown()) }) }),
  // types/literal.ts:49
  Type_literal: a.object({ name: a.literal('literal'), generic: a.object({ T }).optional(), options: a.object({ value: a.unknown() }) }),
  Type_function: a.object({ name: a.literal('fn'), call: a.ref('CallDef').optional() }), // types/fn.ts:66
  // types/iface.ts:58
  Type_interface: a.object({
    name: a.literal('interface'),
    props: a.record(a.ref('PropDef')).optional(),
    get: a.ref('GetSetDef').optional(),
    call: a.ref('CallDef').optional(),
  }),
  Type_typ: a.object({ name: a.literal('typ'), generic: a.object({ T }).optional() }), // types/typ.ts:41
  // types/date.ts:29
  Type_date: a.object({ name: a.literal('date'), options: a.object({ min: a.string().optional(), max: a.string().optional(), utc: a.boolean().optional() }).optional() }),
  // types/timestamp.ts:33
  Type_timestamp: a.object({
    name: a.literal('timestamp'),
    options: a.object({ min: a.string().optional(), max: a.string().optional(), utc: a.boolean().optional(), precision: a.enum(['ms', 's', 'us']).optional() }).optional(),
  }),
  Type_duration: a.object({ name: a.literal('duration') }), // types/duration.ts:29
  Type_color: a.object({ name: a.literal('color'), options: a.object({ hasAlpha: a.boolean().optional() }).optional() }), // types/color.ts:30
} as const;

// ============================================================================
// Expr classes (exprs/*.ts static toSchema), aid `Expr_<kind>`
// ============================================================================

const exprs = {
  // exprs/block.ts:37
  Expr_block: a.object({
    kind: a.literal('block'),
    comment,
    lines: a.array(E).describe("Sequence of expressions evaluated in order. The block's value is the LAST line's value (an empty block returns void). Earlier lines run for their side effects (set, fns.fetch, etc.)."),
  }),
  // exprs/define.ts:50
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
  // exprs/flow.ts:46 (no `comment`)
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
  // exprs/get.ts:34 (no `comment`)
  Expr_get: a.object({
    kind: a.literal('get'),
    path: a.array(a.ref('PathStep')).describe(
      'Steps walked left-to-right starting from a scope variable. Step shapes: `{prop:"name"}` for prop/method access, `{args:{…}}` to call the previous step, `{key:Expr}` for index access. The first step MUST be a prop step (the scope-var name). A step names exactly ONE shape — a call is its own step, so a method with arguments is `[{"prop":"m"},{"args":{…}}]` and never `{"prop":"m","args":{…}}`. Result is the final step\'s value.',
    ),
  }),
  // exprs/if.ts:47
  Expr_if: a.object({
    kind: a.literal('if'),
    comment,
    ifs: a.array(a.object({
      condition: E.describe('Bool-typed expression. First branch whose condition is `true` wins; the rest are skipped.'),
      body: E.describe("Evaluated when this branch's condition is true. The if-expression's value is this body's value."),
    })).describe('Ordered list of `{condition, body}` branches — first true condition wins. Each `condition` must be bool-typed (warned otherwise). With multiple branches this is the gin equivalent of `if / else if / else if`.'),
    else: E.optional().describe('Optional fallback evaluated when every `ifs[i].condition` is false. Without an else, a no-match if-expression evaluates to void.'),
  }),
  // exprs/lambda.ts:55
  Expr_lambda: a.object({
    kind: a.literal('lambda'),
    comment,
    type: T.describe("The lambda's function type — `{ name: \"fn\", call: { args, returns } }` (or a registered named fn type). The `args` obj defines what the body sees under the `args` scope variable; `returns` is what the body must produce."),
    body: E.describe('The lambda body. At runtime, scope contains the lexical scope at definition site PLUS `args` (the call arguments) and `recurse` (this same lambda, for self-calls). Read params via `[{prop:"args"},{prop:"<name>"}]`.'),
    constraint: E.optional().describe('Optional bool-typed precondition evaluated before the body on every call (with `args` in scope). If it returns false, the call throws. Use for input invariants you want enforced regardless of caller.'),
  }),
  // exprs/loop.ts:59
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
  // exprs/native.ts:43
  Expr_native: a.object({
    kind: a.literal('native'),
    comment,
    id: a.string().describe('Identifier of a native impl registered via `registry.setNative(id, fn)` (e.g. `list.push`, `num.add`). The model should NOT generate `native` expressions directly — methods on built-in types are reached via `get` paths, which gin resolves to natives internally.'),
    type: T.optional().describe("Optional type to wrap the native's raw return value with when the impl returns a non-Value. Defaults to `any` if omitted."),
  }),
  // exprs/set.ts:38
  Expr_set: a.object({
    kind: a.literal('set'),
    comment,
    path: a.array(a.ref('PathStep')).describe('Steps walked left-to-right to a writable target. Single-step `[{prop:"x"}]` re-assigns scope variable `x`. Multi-step targets need the type to support set on the final step (a prop with a `set` ExprDef, an indexed slot, or a method whose call has `set:`).'),
    value: E.describe("The expression evaluated and assigned to the path target. Its type must be compatible with the target's declared type — checked statically as `set.type-mismatch`."),
  }),
  // exprs/switch.ts:54
  Expr_switch: a.object({
    kind: a.literal('switch'),
    comment,
    value: E.describe("Expression whose result is compared against each case's `equals` candidates. Evaluated once."),
    cases: a.array(a.object({
      equals: a.array(E).describe("Candidate values for this case. The case wins if `value` equals ANY one of them (logical OR). Each candidate's type must be compatible with `value`'s type — checked as `switch.case.type`."),
      body: E.describe("Evaluated when this case wins. The switch expression's value is this body's value."),
    })).describe("Ordered list of cases — first match wins. Cases are NOT fall-through; only the matching case's body runs."),
    else: E.optional().describe('Optional fallback evaluated when no case matches. Without an else, a no-match switch evaluates to void.'),
  }),
  // exprs/template.ts:45 (no `comment`)
  Expr_template: a.object({
    kind: a.literal('template'),
    template: a.union([E, a.string()]).describe('The template string — either a literal string (auto-wrapped as `new text`) or an Expr that evaluates to text. Placeholders use `{name}` syntax; each `name` is looked up first in `params` (when supplied) and then in the surrounding scope.'),
    params: E.optional().describe('Optional obj-typed expression supplying placeholder values. When omitted or when a key is missing, `{name}` falls back to a scope lookup of the same name — so a `${baseUrl}` placeholder resolves to a surrounding `define baseUrl = ...`. Provide `params` only when placeholders need values not already in scope (or to override scope values).'),
  }),
  // schemas.ts:264 — the Expr union, in registry order (registry.ts BUILTIN_EXPRS)
  Expr: byTag('kind', [
    a.ref('Expr_new'), a.ref('Expr_get'), a.ref('Expr_set'), a.ref('Expr_define'), a.ref('Expr_block'), a.ref('Expr_if'),
    a.ref('Expr_switch'), a.ref('Expr_loop'), a.ref('Expr_lambda'), a.ref('Expr_template'), a.ref('Expr_flow'), a.ref('Expr_native'),
  ]),
} as const;

// ============================================================================
// newStrict: one `new` branch per type class (exprs/new.ts:83), aid `New_<class>`
// ============================================================================

const DATE_RE = '^\\d{4}-\\d{2}-\\d{2}';
const TIMESTAMP_RE = '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?$';

/** Each class's static `toNewSchema(opts)` (types/<class>.ts). */
const CLASS_NEW_VALUE: { readonly [K in TypeClassName]: AnySchema } = {
  any: a.unknown(), // any.ts:33
  void: a.null(), // void.ts:33
  null: a.null(), // null.ts:34
  bool: a.boolean(), // bool.ts:38
  num: a.number(), // num.ts:52
  text: a.string(), // text.ts:48
  list: a.array(E), // list.ts:54
  map: a.array(a.object({ key: E, value: E })), // map.ts:62
  tuple: a.array(E), // tuple.ts:70
  obj: a.record(E), // obj.ts:49
  optional: E, // optional.ts:42 (opts.Expr.optional(), optional again in the branch)
  nullable: a.nullable(E), // nullable.ts:41
  not: a.unknown(), // not.ts:42
  or: E, // or.ts:52
  and: E, // and.ts:55
  enum: a.union([a.string(), a.number()]), // enum.ts:44
  literal: a.unknown(), // literal.ts:57
  fn: a.union([a.string(), a.object({ kind: a.string() })]), // fn.ts:73 (passthrough object)
  interface: a.record(E), // iface.ts:67
  typ: T, // typ.ts:48
  date: a.string().pattern(DATE_RE), // date.ts:40
  timestamp: a.string().pattern(TIMESTAMP_RE), // timestamp.ts:45
  // duration.ts:34 → Type.toNewSchema from init.args: { days?, hours?, minutes?, seconds?, ms? }
  duration: a.object({ days: a.number().optional(), hours: a.number().optional(), minutes: a.number().optional(), seconds: a.number().optional(), ms: a.number().optional() }),
  // color.ts:37 → init.args: { r, g, b: 0..255 ints, a?: 0..1 }
  color: a.object({ r: a.int().min(0).max(255), g: a.int().min(0).max(255), b: a.int().min(0).max(255), a: a.number().min(0).max(1).optional() }),
};

const newClassBranch = (cls: TypeClassName) =>
  a.object({
    kind: a.literal('new'),
    type: a.ref(TYPE_AID[cls]).describe(`Full TypeDef for a \`${cls}\` instance (name + options + per-class fields).`),
    value: a.optional(CLASS_NEW_VALUE[cls]).describe(`Initial value matching this \`${cls}\` instance. Composites accept Expr slots; primitives accept their raw form.`),
  });

const newClassBranches = Object.fromEntries(TYPE_CLASS_NAMES.map((c) => [`New_${c}`, newClassBranch(c)])) as unknown as { readonly [K in TypeClassName as `New_${K}`]: AnySchema };

// exprs/new.ts:100 — default (not strict): any TypeDef + any value.
const newDefault = a.object({
  kind: a.literal('new'),
  type: T.describe('TypeDef of the value being constructed. The `value` field is interpreted relative to this type — primitives take their raw form (`new num` → number), composites take Expr slots (`new list` → Expr[]).'),
  value: a.unknown().optional().describe('Initial value matching `type`. Optional when the type has a defined `init` constructor or a sensible default (empty list, zero num with no constraints, etc.).'),
});

// ============================================================================
// The registry-dependent part
// ============================================================================

/** `buildSchemas` overrides (schemas.ts:194) as the dynamic step reads them. */
export interface GrammarOverrides {
  /** Lock `new` to a union over every constructible type (exprs/new.ts:59). */
  readonly newStrict?: boolean;
  /** Accept a named type by its name alone (schemas.ts:245; what `schemaBag` uses for typ/fn values). */
  readonly namedRefs?: boolean;
  /** Named types to offer besides the registry's (explicit ones win, deduped by name). */
  readonly types?: readonly GinTypeDef[];
}

const BUILTIN = new Set<string>(TYPE_CLASS_NAMES);
const PLAIN = new Set(['text', 'num', 'bool', 'enum', 'literal', 'date', 'timestamp', 'duration', 'color', 'null']);

type Named = ReadonlyMap<string, GinTypeDef>;

/**
 * A named type's definition with its `extends` chain applied (gin's
 * Extension: base class or named base, props/options merged).
 */
export function resolveDef(def: GinTypeDef, named: Named, depth = 0): GinTypeDef {
  const ext = (def as { extends?: string }).extends;
  if (depth > 16) return def;
  if (ext !== undefined) {
    const base: GinTypeDef = BUILTIN.has(ext) ? { name: ext } : named.has(ext) ? resolveDef(named.get(ext)!, named, depth + 1) : { name: 'any' };
    // extension.ts:254 storedLocalProps — a computed prop (`get`) or a method (a callable type) is surface, not data.
    const stored = Object.entries(def.props ?? {}).filter(([, p]) => !(p as { get?: unknown }).get && p.type.name !== 'fn' && !(p.type as { call?: unknown }).call);
    const props = { ...(base.props ?? {}), ...Object.fromEntries(stored) };
    return {
      ...base,
      ...(def.docs ? { docs: def.docs } : {}),
      ...(Object.keys(props).length ? { props } : {}),
      ...(base.options || def.options ? { options: { ...(base.options ?? {}), ...(def.options ?? {}) } } : {}),
      ...(base.generic || def.generic ? { generic: { ...(base.generic ?? {}), ...(def.generic ?? {}) } } : {}),
    };
  }
  if (!BUILTIN.has(def.name) && named.has(def.name)) return resolveDef(named.get(def.name)!, named, depth + 1);
  return def;
}

/** new-slot.ts:24 `core` + `isPlainSlot`: unwrap optional/nullable/extension to the base class. */
function isPlain(def: GinTypeDef, named: Named): boolean {
  let d = resolveDef(def, named);
  for (let i = 0; i < 16 && (d.name === 'optional' || d.name === 'nullable'); i++) d = resolveDef(d.generic?.T ?? { name: 'any' }, named);
  return PLAIN.has(d.name);
}

/** new-slot.ts:24 `newSlotSchema`: a plain field takes its value or an Expr; anything else an Expr. */
function newSlot(def: GinTypeDef, named: Named): AnySchema {
  const present = def.name === 'optional' ? (def.generic?.T ?? { name: 'any' }) : def;
  if (!isPlain(present, named)) return E;
  return a.union([fromGin(resolveDef(present, named)) as AnySchema, E]);
}

/** A named type instance's `toNewSchema(opts)` (Type.toNewSchema, type.ts:1381, and each composite's override). */
export function newValueOf(def0: GinTypeDef, named: Named): AnySchema {
  const def = resolveDef(def0, named);
  const init = (def as { init?: { args: GinTypeDef } }).init;
  if (init) return fromGin(resolveDef(init.args, named)) as AnySchema;
  const o = (def.options ?? {}) as Record<string, any>;
  switch (def.name) {
    case 'obj': { // obj.ts:325
      const shape: Record<string, AnySchema> = {};
      for (const [k, p] of Object.entries(def.props ?? {})) {
        const slot = newSlot(p.type, named);
        shape[k] = resolveDef(p.type, named).name === 'optional' ? a.optional(slot) : slot;
      }
      return a.object(shape);
    }
    case 'interface': { // iface.ts:279 (passthrough)
      const shape: Record<string, AnySchema> = {};
      for (const k of Object.keys(def.props ?? {})) shape[k] = E;
      return a.object(shape);
    }
    case 'list': { // list.ts:281
      let s = a.array(E);
      if (typeof o.minLength === 'number') s = s.min(o.minLength);
      if (typeof o.maxLength === 'number') s = s.max(o.maxLength);
      return s;
    }
    case 'map': return a.array(a.object({ key: E, value: E })); // map.ts:273
    case 'tuple': { // tuple.ts:251
      const els = (o.elements ?? []) as GinTypeDef[];
      return els.length ? a.tuple(els.map(() => E) as unknown as [AnySchema, ...AnySchema[]]) : a.array(E).max(0);
    }
    case 'optional': return newValueOf(def.generic?.T ?? { name: 'any' }, named); // optional.ts:175
    case 'nullable': return a.nullable(newValueOf(def.generic?.T ?? { name: 'any' }, named)); // nullable.ts:166
    case 'or': { // or.ts:232
      const parts = ((o.types ?? []) as GinTypeDef[]).map((t) => newValueOf(t, named));
      return parts.length === 1 ? parts[0]! : a.union(parts as unknown as [AnySchema, ...AnySchema[]]);
    }
    case 'and': { // and.ts:319
      const parts = ((o.types ?? []) as GinTypeDef[]).map((t) => newValueOf(t, named));
      return parts.length === 1 ? parts[0]! : a.intersection(parts as unknown as [AnySchema, ...AnySchema[]]);
    }
    case 'duration': return CLASS_NEW_VALUE.duration;
    case 'color': return CLASS_NEW_VALUE.color;
    case 'typ': return T; // typ.ts:195 (its value schema: a TypeDef)
    case 'fn': return a.union([a.string(), E]); // fn.ts:242 via Type.toNewSchema → toValueSchema
    default: return fromGin(def) as AnySchema;
  }
}

/** The named types the grammar offers: explicit `types` first, then the registry's (schemas.ts:228). */
function namedList(registry: GinRegistryLike, o: GrammarOverrides | undefined): Map<string, GinTypeDef> {
  const byName = new Map<string, GinTypeDef>();
  for (const t of o?.types ?? []) byName.set(t.name, t);
  for (const [n, t] of registry.named()) if (!byName.has(n)) byName.set(n, t);
  return byName;
}

/** The dynamic step: TypeDef, Type_Extension and Expr_new for this registry and these overrides. */
export function grammarDefs(registry: GinRegistryLike, o?: GrammarOverrides) {
  const named = namedList(registry, o);
  const names = [...named.keys()];
  // schemas.ts:231 — a registered name, other keys pass through (gin's aid: the type name).
  const instanceBranches = names.map((n) => a.object({ name: a.literal(n) }));
  const branches: AnySchema[] = [...instanceBranches, ...TYPE_CLASS_NAMES.map((c) => a.ref(TYPE_AID[c])), a.ref('Type_Extension')];
  // schemas.ts:245 — namedRefs: any type name, nothing else.
  if (o?.namedRefs) branches.push(a.object({ name: typeName() }).strict().describe('A named type, by its name.'));
  // schemas.ts:139 extensionSchema: `extends` is every class name + every named type.
  const baseNames = [...new Set<string>([...TYPE_CLASS_NAMES, ...names])] as [string, ...string[]];
  const Type_Extension = a.object({
    name: typeName(),
    extends: a.enum(baseNames),
    docs: a.string().optional(),
    satisfies: a.array(typeName()).optional(),
    generic: a.ref('Generic').optional(),
    options: a.record(a.unknown()).optional(),
    props: a.record(a.ref('PropDef')).optional(),
    get: a.ref('GetSetDef').optional(),
    call: a.ref('CallDef').optional(),
    init: a.ref('InitDef').optional(),
    constraint: E.optional(),
  });
  let Expr_new: AnySchema = newDefault;
  if (o?.newStrict) {
    // exprs/new.ts:61 — per named instance, then per class.
    const inst = [...named].map(([n, def]) =>
      a.object({
        kind: a.literal('new'),
        type: a.object({ name: a.literal(n) }).describe(`Reference to the registered named type \`${n}\` — name-only, the registry resolves it to its full definition.`),
        value: a.optional(newValueOf(def, named)).describe(`Initial value for the new \`${n}\` instance. Each composite slot accepts an Expr (Get, NewExpr, etc.); per-slot type correctness is enforced at runtime.`),
      }) as AnySchema,
    );
    Expr_new = a.union([...inst, ...TYPE_CLASS_NAMES.map((c) => a.ref(`New_${c}`))] as unknown as [AnySchema, ...AnySchema[]]);
  }
  return {
    TypeDef: byTag('name', branches as unknown as [AnySchema, ...AnySchema[]]) as SchemaOf<TypeDefT>,
    Type_Extension,
    Expr_new: Expr_new as SchemaOf<NewExprT>,
  };
}

/** A registry's version + the overrides: what the bind cache is keyed by. */
export const grammarKey = (registry: GinRegistryLike, o?: GrammarOverrides): string =>
  `${registry.version}|${o?.newStrict ? 's' : ''}${o?.namedRefs ? 'r' : ''}|${(o?.types ?? []).map((t) => t.name).join(',')}`;

/** The gin grammar module: static grammar + the registry part. */
export const GinGrammarStatic = a
  .define(shared)
  .define(typeClasses)
  .define(exprs)
  .define(newClassBranches)
  .declare<GrammarDeclared>();

/** What the dynamic step supplies, typed. */
export type GrammarDeclared = { TypeDef: TypeDefT; Type_Extension: TypeExtensionT; Expr_new: NewExprT };

/** The static grammar, before the registry part: a ctx-driven module (ginny tools) adds its own dynamic step. */
export const GinGrammar = GinGrammarStatic
  .dynamic((registry: GinRegistryLike, overrides?: GrammarOverrides) => grammarDefs(registry, overrides), { key: grammarKey, cacheSize: 8 });

// ---- results of the one module ----

/** `opts.Type` — a TypeDef (ginny edit_type `def`, architect `create[]`, designer args/returns). */
export const TypeResult = GinGrammar.result('TypeDef');
/** `opts.Expr` — a program (ginny `write`). */
export const Program = GinGrammar.result('Expr');
/** ginny write.ts:35 — `{ program: opts.Expr }`. */
export const WriteArgs = GinGrammar.result(a.object({ program: a.ref('Expr') }));

// ============================================================================
// Type proofs
// ============================================================================

expectTypeOf<a.infer<typeof TypeResult>>().toEqualTypeOf<TypeDefT>();
expectTypeOf<a.infer<typeof WriteArgs>>().toEqualTypeOf<{ program: ExprDefT }>();
expectTypeOf(Program.bind).parameters.toEqualTypeOf<[registry: GinRegistryLike, overrides?: GrammarOverrides]>();

// Each class branch infers exactly its code-side member.
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_num'>>>>().toEqualTypeOf<TypeNumT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_object'>>>>().toEqualTypeOf<TypeObjectT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_interface'>>>>().toEqualTypeOf<TypeInterfaceT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_function'>>>>().toEqualTypeOf<TypeFunctionT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_timestamp'>>>>().toEqualTypeOf<TypeTimestampT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_enum'>>>>().toEqualTypeOf<TypeEnumT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'CallDef'>>>>().toEqualTypeOf<CallDefT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'GetSetDef'>>>>().toEqualTypeOf<GetSetDefT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'PathStep'>>>>().toEqualTypeOf<PathStepT>();
// Each Expr kind too.
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_define'>>>>().toEqualTypeOf<DefineExprT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_loop'>>>>().toEqualTypeOf<LoopExprT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_flow'>>>>().toEqualTypeOf<FlowExprT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_template'>>>>().toEqualTypeOf<TemplateExprT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_switch'>>>>().toEqualTypeOf<SwitchExprT>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_native'>>>>().toEqualTypeOf<NativeExprT>();

/** Narrowing works on the decoded program. */
export function __narrow(e: a.infer<typeof Program>): void {
  if (e.kind === 'define') expectTypeOf(e.vars[0]!.value).toEqualTypeOf<ExprDefT>();
  if (e.kind === 'get') {
    const step = e.path[0]!;
    if ('args' in step) expectTypeOf(step.args).toEqualTypeOf<Record<string, ExprDefT>>();
  }
  if (e.kind === 'template' && typeof e.template !== 'string') expectTypeOf(e.template).toEqualTypeOf<ExprDefT>();
}
