import type { Registry } from './registry';
import type { TypeScope } from './type-scope';
import type { ExprDef, TypeDef, PathDef, PathStepDef, PropDef, GetSetDef, CallDef } from './schema';
import type { Expr } from './expr';
import { Value, val } from './value';
import type { Node, CodeOptions } from './node';
import type { Engine } from './engine';
import { Problems } from './problem';
import type { Scope } from './scope';
import type { JSONOf, RuntimeOf } from './json-type';
import { z } from 'zod';
import type { SchemaOptions, ValueSchemaOptions } from './node';

// ============================================================================
// RUNTIME SPEC SHAPES
// ============================================================================

/**
 * Runtime Prop — a named capability on a Type. Holds the prop's static
 * type, optional get/set Exprs, optional default, and a docstring.
 *
 * Behavior methods (runGet/runSet/invokeMethod/invokeMethodSet) live on
 * the Prop itself — moved here from path.ts so the logic is co-located
 * with the data.
 */
/**
 * Plain-object shape accepted anywhere a Prop is required. The matching
 * normalizer (`Prop.from`) wraps these into Prop instances. Used at call
 * sites that don't want to `new Prop(...)` just to pass a type.
 */
export interface PropSpec {
  type: Type;
  get?: ExprDef;
  set?: ExprDef;
  default?: ExprDef;
  docs?: string;
}

export class Prop {
  readonly type: Type;
  readonly get?: ExprDef;
  readonly set?: ExprDef;
  readonly default?: ExprDef;
  readonly docs?: string;

  constructor(spec: PropSpec) {
    this.type = spec.type;
    this.get = spec.get;
    this.set = spec.set;
    this.default = spec.default;
    this.docs = spec.docs;
  }

  /** Idempotent normalizer: Prop stays, PropSpec becomes a new Prop. */
  static from(x: Prop | PropSpec): Prop {
    return x instanceof Prop ? x : new Prop(x);
  }

  /** Serialize to PropDef JSON. Inverse of `decodeProp` in spec.ts. */
  toJSON(): PropDef {
    return {
      docs: this.docs,
      type: this.type.toJSON(),
      get: this.get,
      default: this.default,
      set: this.set,
    };
  }

  // ─── runtime ops (called by Path.walk) ─────────────────────────────────

  /** Read this prop on `self`: evaluate get Expr with {this, super?}, or
   *  fall back to direct object-field lookup. */
  async read(self: Value, name: string, scope: Scope, engine: Engine): Promise<Value> {
    if (this.get) {
      const bindings: Record<string, Value> = { this: self };
      const sup = self.type.propSuperFor(self, name, 'get', scope, engine);
      if (sup) bindings.super = sup;
      return engine.evaluate(this.get, scope.child(bindings));
    }
    const raw = (self.raw as Record<string, unknown> | null | undefined)?.[name];
    if (raw instanceof Value) return raw;
    return val(this.type, raw);
  }

  /** Write this prop on `self` with the given value. */
  async write(self: Value, name: string, value: Value, scope: Scope, engine: Engine): Promise<void> {
    if (!this.set) throw new Error(`path: prop '${name}' has no set expression`);
    const bindings: Record<string, Value> = { this: self, value };
    const sup = self.type.propSuperFor(self, name, 'set', scope, engine);
    if (sup) bindings.super = sup;
    await engine.evaluate(this.set, scope.child(bindings));
  }

  /**
   * Invoke this prop as a method: runs get Expr with {this, args, super?, recurse}.
   * `fnType` is the effective (possibly generic-bound) Fn type used for the
   * recurse Value's type; defaults to this.type.
   */
  async invokeMethod(
    self: Value,
    name: string,
    argsValue: Value,
    scope: Scope,
    engine: Engine,
    fnType?: Type,
  ): Promise<Value> {
    if (!this.get) throw new Error(`path: callable prop '${name}' has no get expression`);
    const effectiveType = fnType ?? this.type;
    const getExpr = this.get;
    const callable = async (newArgs: Value): Promise<Value> => {
      const recurseValue = new Value(effectiveType, callable);
      const bindings: Record<string, Value> = { this: self, args: newArgs, recurse: recurseValue };
      const sup = self.type.propSuperFor(self, name, 'get', scope, engine);
      if (sup) bindings.super = sup;
      return engine.evaluate(getExpr, scope.child(bindings));
    };
    return callable(argsValue);
  }

  /**
   * Invoke this prop as a method-set target: runs CallDef.set with
   * {this, args, value, super?, recurse}.
   */
  async invokeMethodSet(
    self: Value,
    name: string,
    argsValue: Value,
    setValue: Value,
    scope: Scope,
    engine: Engine,
    fnType?: Type,
  ): Promise<void> {
    const effectiveType = fnType ?? this.type;
    const callSpec = effectiveType.call?.();
    if (!callSpec?.set) throw new Error(`path: method '${name}' has no call.set`);
    const setter = async (newArgs: Value): Promise<Value> => {
      const recurseValue = new Value(effectiveType, setter);
      const bindings: Record<string, Value> = {
        this: self, args: newArgs, value: setValue, recurse: recurseValue,
      };
      const sup = self.type.propSuperFor(self, name, 'callSet', scope, engine);
      if (sup) bindings.super = sup;
      await engine.evaluate(callSpec.set!, scope.child(bindings));
      return val(engine.registry.void(), undefined);
    };
    await setter(argsValue);
  }
}

/**
 * Runtime GetSet — indexed-access spec, with key/value Types resolved and
 * optional get/set/loop Exprs.
 */
export class GetSet<K = any, V = any> {
  readonly key: Type<K>;
  readonly value: Type<V>;
  readonly get?: ExprDef;
  readonly set?: ExprDef;
  readonly loop?: ExprDef;
  /** When true, `LoopExpr` re-evaluates `over` each iteration and
   *  exits on falsy `raw`. See `GetSetDef.loopDynamic`. */
  readonly loopDynamic?: boolean;
  readonly docs?: string;

  constructor(spec: {
    key: Type<K>;
    value: Type<V>;
    get?: ExprDef;
    set?: ExprDef;
    loop?: ExprDef;
    loopDynamic?: boolean;
    docs?: string;
  }) {
    this.key = spec.key;
    this.value = spec.value;
    this.get = spec.get;
    this.set = spec.set;
    this.loop = spec.loop;
    this.loopDynamic = spec.loopDynamic;
    this.docs = spec.docs;
  }

  /** Serialize to GetSetDef JSON. Inverse of `decodeGetSet` in spec.ts. */
  toJSON(): GetSetDef {
    return {
      docs: this.docs,
      key: this.key.toJSON(),
      value: this.value.toJSON(),
      get: this.get,
      set: this.set,
      loop: this.loop,
      loopDynamic: this.loopDynamic,
    };
  }

  /** Read this[key]: runs get Expr with {this, key, super?}. */
  async indexRead(self: Value, keyValue: Value, scope: Scope, engine: Engine): Promise<Value> {
    if (!this.get) throw new Error(`path: type '${self.type.name}' has no index get`);
    const bindings: Record<string, Value> = { this: self, key: keyValue };
    const sup = self.type.indexSuperFor(self, 'get', scope, engine);
    if (sup) bindings.super = sup;
    return engine.evaluate(this.get, scope.child(bindings));
  }

  /** Write this[key] = value: runs set Expr with {this, key, value, super?}. */
  async indexWrite(self: Value, keyValue: Value, value: Value, scope: Scope, engine: Engine): Promise<void> {
    if (!this.set) throw new Error(`path: type '${self.type.name}' has no index set`);
    const bindings: Record<string, Value> = { this: self, key: keyValue, value };
    const sup = self.type.indexSuperFor(self, 'set', scope, engine);
    if (sup) bindings.super = sup;
    await engine.evaluate(this.set, scope.child(bindings));
  }
}

/**
 * Runtime Call — callable spec, with arg/return/throws Types resolved.
 *
 * `args` / `returns` / `throws` are parsed inside the call's local
 * scope (a `LocalScope` carrying any `CallDef.types` aliases plus
 * declared generics). Bare alias references inside those Types are
 * `AliasType` instances that resolve via that scope; their `toJSON()`
 * emits the bare-name form, which decodeCall then rebuilds against a
 * freshly constructed LocalScope on round-trip. No source-form
 * preservation needed — the structure is symmetric.
 */
export class Call<TArgs extends object = any, TResult = any, TError = any> {
  readonly args: Type<TArgs>;
  readonly returns?: Type<TResult>;
  readonly throws?: Type<TError>;
  readonly get?: ExprDef;
  readonly set?: ExprDef;
  readonly docs?: string;

  /** Call-local type aliases declared on `CallDef.types`, parsed.
   *  Public so rendering (toCode / toCodeDefinition) can surface the
   *  alias header. Populated only when aliases were declared. */
  readonly types?: Record<string, Type>;

  constructor(spec: {
    args: Type<TArgs>;
    returns?: Type<TResult>;
    throws?: Type<TError>;
    get?: ExprDef;
    set?: ExprDef;
    docs?: string;
    types?: Record<string, Type>;
  }) {
    this.args = spec.args;
    this.returns = spec.returns;
    this.throws = spec.throws;
    this.get = spec.get;
    this.set = spec.set;
    this.docs = spec.docs;
    this.types = spec.types;
  }

  /** Serialize to CallDef JSON. Inverse of `decodeCall` in spec.ts. */
  toJSON(): CallDef {
    const types = this.types && Object.keys(this.types).length > 0
      ? Object.fromEntries(
          Object.entries(this.types).map(([k, t]) => [k, t.toJSON()]),
        )
      : undefined;
    return {
      docs: this.docs,
      types,
      args: this.args.toJSON(),
      returns: this.returns?.toJSON(),
      throws: this.throws?.toJSON(),
      get: this.get,
      set: this.set,
    };
  }
}

/**
 * Runtime Init — constructor spec for `{ kind: 'new' }` with args.
 */
export class Init<TArgs extends object = any> {
  readonly args: Type<TArgs>;
  readonly run: ExprDef;
  readonly docs?: string;

  constructor(spec: { args: Type<TArgs>; run: ExprDef; docs?: string }) {
    this.args = spec.args;
    this.run = spec.run;
    this.docs = spec.docs;
  }

  /** Serialize to InitDef JSON. Inverse of `decodeInit` in spec.ts. */
  toJSON(): NonNullable<TypeDef['init']> {
    return {
      docs: this.docs,
      args: this.args.toJSON(),
      run: this.run,
    };
  }
}

// ============================================================================
// COMPATIBILITY OPTIONS
// ============================================================================

export interface CompatOptions {
  /** Require same class (no cross-class structural match). */
  strict?: boolean;
  /** Enforce options constraints (ranges, regex, bounds). */
  value?: boolean;
  /** No unwrapping — Optional<T> is not compatible with T. */
  exact?: boolean;
}

// ============================================================================
// RANDOM VALUE GENERATOR
// ============================================================================

export type Rnd = (min: number, max: number, whole: boolean) => number;

// ============================================================================
// TYPE
// ============================================================================

/**
 * The abstract runtime Type class for gin.
 *
 * Every concrete type (num, text, list, or, extension, …) extends this.
 * The surface is intentionally small — see poc.ts for the full design.
 *
 * Key invariants:
 *  - Values in gin are (type, raw) pairs. This class defines behavior
 *    for the TYPE side; raw-value operations are minimal (valid, parse,
 *    dump, create, random). Everything else (eq, compare, add, map, …)
 *    lives on props() / get() / call() and is evaluated by the engine.
 *  - Nothing in this class or its subclasses inspects other types by
 *    name. Composite types (or, and, extension) receive their
 *    constituents and delegate to them polymorphically.
 *  - Every method returns new instances where applicable (no mutation).
 */
export abstract class Type<T = any, O = any> implements Node {
  constructor(
    /**
     * Type-name resolution scope. Usually the Registry (root scope);
     * Types parsed inside an FnType's generic-parameter scope or a
     * `CallDef.types` alias scope hold a `LocalScope` instead, so that
     * any `AliasType` captured in their tree can resolve through the
     * same chain at use time.
     */
    readonly scope: TypeScope,
    readonly options: O,
    /**
     * Generic parameter bindings (e.g. list<V> stores V here). Empty for
     * types that aren't generic-parameterized. The engine uses this map
     * when resolving Generic placeholders in props()/get()/call()/init().
     */
    readonly generic: Record<string, Type> = {},
  ) {}

  /** Underlying Registry — shortcut for `this.scope.registry`, used
   *  by subclasses for builder access (`this.registry.num()` etc.). */
  get registry(): Registry { return this.scope.registry; }

  /** Identifier of this type (e.g. 'num', 'text', 'list'). */
  abstract readonly name: string;

  /** describe() tiebreak — higher wins when inferring from sample data. */
  readonly priority: number = 0;

  readonly docs?: string;

  // ─── VALUE OPERATIONS ────────────────────────────────────────────────────
  //
  // Type parameter `T` is the LOGICAL type (e.g. `number[]` for list<num>).
  // `RuntimeOf<T>` derives the actual `.raw` storage shape (e.g. `Value<number>[]`
  // for list<num>, so per-element concrete types are preserved). `JSONOf<T>`
  // derives the dumped JSON shape, where each composite slot is wrapped as
  // `{type: TypeDef, value: ...}` so subtype info round-trips through JSON.

  /**
   * Runtime type guard over the raw (runtime-shaped) value. Returns plain
   * `boolean` (not a predicate) to keep TS's bidirectional inference from
   * solving `T` backwards through the refinement. Narrowing still works
   * — callers that need `Value<T>.raw` typed simply rely on the Value's
   * constructor contract.
   *
   * Optional `scope` overlays an extra TypeScope on top of any
   * AliasType resolutions inside this type — used by call-site
   * generics (path step `generic: {R: numDef}`) so AliasType('R')
   * resolves to num without rebuilding the type tree.
   */
  abstract valid(raw: unknown, scope?: TypeScope): boolean;

  /**
   * Parse a JSON-shape input into a Value of this type.
   * Throws if the input cannot be coerced to a valid raw value.
   * `scope` propagates the call-site TypeScope (see `valid`).
   */
  abstract parse(json: unknown, scope?: TypeScope): Value<T>;

  /**
   * Serialize a runtime raw value to its JSON shape.
   *
   * Composites (list/map/tuple/obj) recursively wrap each nested slot as
   * a `JSONValue` envelope so per-element concrete types survive JSON
   * round-trip. Primitives/leaf types just produce their JSON form.
   *
   * Called by `Value.toJSON()` to build the outer `{type, value}` wire
   * envelope. For logical primitive output (no type info) callers can
   * walk `.raw` and read the underlying Value contents directly.
   * `scope` propagates the call-site TypeScope (see `valid`).
   */
  abstract encode(raw: RuntimeOf<T>, scope?: TypeScope): JSONOf<T>;

  /** Default / zero raw value — used by { kind: 'new' } with no args. */
  abstract create(): RuntimeOf<T>;

  /** Random raw value respecting this type's options. */
  abstract random(rnd: Rnd): RuntimeOf<T>;

  // ─── TYPE RELATIONS ──────────────────────────────────────────────────────

  /**
   * Structural + (optional) strict compatibility check.
   * Concrete types implement this — the default impls below (accepts,
   * exact) compose it with pre-set option flags.
   * `scope` propagates the call-site TypeScope (see `valid`).
   */
  abstract compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean;

  /** Strict: another instance of the same class must match structurally. */
  accepts(other: Type, scope?: TypeScope): boolean {
    return this.compatible(other, { strict: true }, scope);
  }

  /** Strict + exact: no wrapper unwrapping, no value-mode. */
  exact(other: Type, scope?: TypeScope): boolean {
    return this.compatible(other, { strict: true, exact: true }, scope);
  }

  /** True if this type accepts instances of other classes structurally. */
  flexible(): boolean {
    return false;
  }

  /**
   * Given `other` is compatible with `this`, produce a version of `this`
   * narrowed by `other`. Default: `this` — identity preserves the caller's
   * refinements (e.g. `Positive.like(num)` keeps Positive).
   *
   * Container types override to recurse: `ListType.like(list<X>)` returns
   * `list<registry.like(X)>`, pulling in every registry type compatible
   * with X. When `other` is a different class, the default fallback returns
   * `this` unchanged.
   * `scope` propagates the call-site TypeScope (see `valid`).
   */
  like(_other: Type, _scope?: TypeScope): Type {
    return this;
  }

  /**
   * True when this type's `.compatible(other)` returns true for essentially
   * every `other` — i.e., this is a "top type" whose canonical instance is
   * too broad to participate usefully in `Registry.compatible(t)` unless the
   * query is specifically for this class.
   *
   * Examples: `any`, an unbound `generic`, `and<>` with no parts,
   * `iface<{}>` with no required contract, `optional<any>`/`nullable<any>`
   * whose canonical wraps `any`. Default: false.
   */
  isUniversal(): boolean {
    return false;
  }

  // ─── TYPE ALGEBRA ────────────────────────────────────────────────────────

  /**
   * Widen / merge same-class: fold another instance's options into this one.
   * Returns a new instance. Called during describe() when samples fold.
   */
  abstract or(other: Type<T>): Type<T>;

  /** Canonical form — collapse trivial wrappers. AliasType uses
   *  `scope` to consult call-site bindings before its captured scope. */
  simplify(_scope?: TypeScope): Type {
    return this;
  }

  /** Strip Optional / Nullable layers, revealing the required inner type. */
  required(): Type {
    return this;
  }

  /**
   * True when this type represents an undefined-bearing slot. Used by
   * toCode() for `name?` syntax on struct fields.
   * OptionalType overrides to true; everything else is false.
   */
  isOptional(): boolean {
    return false;
  }

  // ─── OPTIONS NARROWING (for Extension) ──────────────────────────────────

  /**
   * Merge `local` options on top of this.options, enforcing per-type
   * directional rules (Num.min ≥, Num.max ≤, regex ⊂, length bounds,
   * etc.). Throws TypeError on a widening attempt. Returns the merged,
   * narrower options — the invariant "every narrowed value is also a
   * valid base value" must hold.
   */
  abstract narrow(local: Partial<O>): O;

  // ─── EFFECTIVE ACCESS SPECS ──────────────────────────────────────────────

  /**
   * Effective props map — names available via .prop access. Implementations
   * may return raw PropSpec values; `prop(name)` normalizes to Prop.
   * Composite types (or, and, optional, extension) override to derive.
   *
   * The base defines universal props that every type inherits — `toAny`
   * is always available. Subclasses spread `super.props()` into their
   * return to pick these up.
   * `scope` propagates the call-site TypeScope (see `valid`).
   */
  props(_scope?: TypeScope): Record<string, Prop | PropSpec> {
    return {
      toAny: this.registry.method({}, this.registry.any(), 'type.toAny'),
    };
  }

  /** Names of props defined universally on every Type (via base `props()`).
   *  Consumers that treat callables as "pure" despite having these entries
   *  (e.g. `toCodeDefinition`'s method-vs-field heuristic) filter by this. */
  protected static readonly UNIVERSAL_PROP_NAMES: ReadonlySet<string> = new Set(['toAny']);

  /**
   * Runtime constraint predicates that every value of this type must
   * satisfy, evaluated with `this` bound to the value. Base types have no
   * constraints (invariants live in `options`); `Extension` overrides to
   * include its local constraint and chain to the base. Consumed by
   * `Engine.validateValue` and `describeType` (LLM schema description).
   */
  constraints(): Expr[] {
    return [];
  }

  /** Effective GetSet — present iff this type supports [key] access. */
  get(_scope?: TypeScope): GetSet | undefined {
    return undefined;
  }

  /** Effective Call — present iff this type is invocable. */
  call(_scope?: TypeScope): Call | undefined {
    return undefined;
  }

  /** Effective Init — present iff this type has a custom constructor. */
  init(_scope?: TypeScope): Init | undefined {
    return undefined;
  }

  /** Convenience over props() — single-name lookup, normalized to Prop. */
  prop(name: string, scope?: TypeScope): Prop | undefined {
    const raw = this.props(scope)[name];
    return raw ? Prop.from(raw) : undefined;
  }

  // ─── PATH WALKING ────────────────────────────────────────────────────────

  /**
   * Resolve a single PathStep against this type, returning the sub-type
   * reached by that step (or undefined if the step doesn't apply here).
   * Concrete types with positional semantics (Tuple) may override.
   * `scope` propagates the call-site TypeScope (see `valid`).
   */
  follow(step: PathStepDef, scope?: TypeScope): Type | undefined {
    if ('prop' in step) {
      return this.prop(step.prop, scope)?.type;
    }
    if ('args' in step) {
      return this.call(scope)?.returns;
    }
    if ('key' in step) {
      return this.get(scope)?.value;
    }
    return undefined;
  }

  /** Fold follow() over a whole Path. */
  at(path: PathDef, scope?: TypeScope): Type | undefined {
    let current: Type | undefined = this;
    for (const step of path) {
      if (!current) return undefined;
      current = current.follow(step, scope);
    }
    return current;
  }

  // ─── GENERIC RESOLUTION (scope-based; no bind/substitute) ───────────────
  //
  // Generic placeholders are AliasType instances whose `scope` chain
  // includes the binding (see `FnType.from`'s LocalScope, decodeCall's
  // alias map, etc.). To specialize a generic at a call site, callers
  // pass an extra `scope: TypeScope` (a LocalScope layered on top of
  // the captured scope, with call-site bindings) into the methods
  // that resolve types — `parse`, `valid`, `compatible`, `props`,
  // `call`, etc. AliasType.resolve consults `extra` first, falling
  // back to its captured scope. No type tree is rebuilt.

  // ─── SCHEMA ROUND-TRIP ───────────────────────────────────────────────────

  /**
   * Emit the JSON schema (TypeDef) for this Type. Inverse of the registry's
   * parse(): registry.parse(someType.toJSON()) should yield an equivalent
   * Type instance.
   */
  abstract toJSON(): TypeDef;

  /** Deep copy this Type (NOT a raw value). */
  abstract clone(): Type<T, O>;

  // ─── VALUE SCHEMA (Zod) ──────────────────────────────────────────────────

  /**
   * Produce a Zod schema for a PRIMITIVE JSON value that conforms to
   * this type — i.e., the shape an LLM should produce when asked for a
   * value of this type. Options on the type are folded in (num.min →
   * `.min()`, text.pattern → `.regex()`, list.maxLength → `.max()`, etc.).
   *
   * Composites emit LLM-friendly shapes: `list<V>` → `z.array(V)`,
   * `map<K,V>` → `z.array(z.object({ key, value }))` (NOT a `[K, V]`
   * tuple — LLMs handle object keys more reliably than positional pairs),
   * `obj` → `z.object({ per-field schemas })`, and so on.
   *
   * Distinct from `toSchema(opts)` (which schemas the TypeDef JSON for
   * registry round-trip). `toValueSchema()` schemas the RUNTIME DATA.
   *
   * Opts honored:
   *  - `includeDocs: 'type' | 'all'` — attach `.describe(this.docs)` if
   *    set. 'all' also describes individual props / fields / get / call.
   */
  abstract toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny;

  /**
   * Produce a Zod schema for the VALUE side of a `{ kind: 'new' }` Expr of
   * this type. Same as `toValueSchema()` for primitives (e.g. `new num`
   * takes a bare number). Composites differ: each nested slot is any Expr
   * (`opts.Expr`) — Get, NewExpr, function-call path, etc. — and per-slot
   * type correctness is enforced at evaluate/validate time rather than in
   * the Zod shape. So `new obj { x: text, y: num }` accepts
   * `{ x: <any expr>, y: <any expr> }`.
   *
   * Default = `toValueSchema(opts)`; composites override.
   */
  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.toValueSchema(opts);
  }

  /**
   * Attach the Type's own `.docs` as a Zod `.describe()` when opts ask for
   * it, and optionally a stable `aid` so the schema lands in `$defs` under
   * a readable name. `aidPrefix` distinguishes the value-schema aid
   * (`Value_<name>`) from the new-schema aid (`NewValue_<name>`) — both
   * call this helper, so without the prefix they collide. Anonymous class
   * instances (e.g. `num({min:0})` without a name) skip the aid so
   * differently-optioned instances don't collide.
   */
  protected describeType(
    schema: z.ZodTypeAny,
    opts?: ValueSchemaOptions,
    aidPrefix: 'Value_' | 'NewValue_' | null = 'Value_',
  ): z.ZodTypeAny {
    const mode = opts?.includeDocs ?? 'none';
    const parts: string[] = [];
    if (mode !== 'none' && this.docs) parts.push(this.docs);
    // Constraints always describe — they're runtime invariants the LLM
    // must satisfy, separate from cosmetic docs.
    const cs = this.constraints();
    if (cs.length > 0) {
      const text = cs
        .map((c) => `must satisfy ${c.toCode(this.registry, { expectsValue: true })}`)
        .join('; ');
      parts.push(text);
    }
    let out = parts.length > 0 ? schema.describe(parts.join(' — ')) : schema;
    if (aidPrefix) {
      const isRegistered = this.registry.namedTypeList().some((t) => t.name === this.name);
      if (isRegistered) out = out.meta({ aid: `${aidPrefix}${this.name}` });
    }
    return out;
  }

  /**
   * Produce a Zod schema for a `{ kind: 'new' }` Expr that constructs a
   * value of THIS specific type — `{ kind: 'new', type: <this type's
   * literal>, value: <this type's new schema> }`. Used by composite
   * `toNewSchema` overrides to recursively constrain nested slots, and by
   * `NewExpr.toSchema` in strict mode.
   */
  toNewExprSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Match the type by NAME only (same matcher used by `opts.Type` and
    // `NewExpr.toSchema` strict branches). Callers that need a strict
    // deep-equal match should use `toInstanceSchema()` directly.
    return z.object({
      kind: z.literal('new'),
      type: z.object({ name: z.literal(this.name) }).passthrough(),
      value: this.toNewSchema(opts).optional(),
    });
  }

  /**
   * Produce a Zod schema that matches ONLY this specific Type instance's
   * encoded TypeDef — used by NewExpr's strict schema to lock the `type`
   * field to a pre-chosen instance. Implementation: deep-JSON equality
   * against `this.toJSON()`.
   */
  toInstanceSchema(): z.ZodTypeAny {
    const expected = JSON.stringify(this.toJSON());
    const typeName = this.name;
    return z.custom<unknown>(
      (val) => JSON.stringify(val) === expected,
      { message: `must match type '${typeName}'` },
    );
  }

  // ─── CODE EMISSION ───────────────────────────────────────────────────────

  /**
   * Emit a TypeScript-like textual representation of this type. Intended
   * for docs, error messages, and LLM prompting — not for parse round-trip
   * (use encode() for that).
   *
   * Accepts optional Registry + CodeOptions for uniformity with Expr.toCode;
   * most Types ignore both (a type is always a single expression).
   */
  abstract toCode(registry?: Registry, options?: CodeOptions): string;

  /**
   * Inline `/* docs * /` prefix for `toCode` output when this type has docs.
   * Mirrors `Expr.commentPrefix`. Subclasses that want docs rendered call
   * `this.docsPrefix() + <body>` from their `toCode` implementation.
   */
  protected docsPrefix(): string {
    return this.docs ? `/* ${this.docs} */ ` : '';
  }

  /** ` extends <base>` clause on the `type <name>` header — empty for
   *  built-in classes; Extension overrides to show its base type. */
  protected extendsClause(): string {
    return '';
  }

  // ─── toCodeDefinition hooks (overridable in Extension) ─────────────
  //
  // An Extension's definition block shows ONLY its local additions —
  // anything inherited from the base is left implicit under the
  // `extends <base>` clause. Built-in types expose their full surface.

  protected definitionInit():  Init    | undefined { return this.init(); }
  protected definitionCall():  Call    | undefined { return this.call(); }
  protected definitionGet():   GetSet  | undefined { return this.get(); }
  protected definitionProps(): Record<string, Prop | PropSpec> { return this.props(); }

  /**
   * TypeScript-style definition block — surfaces this type's full public
   * surface to an LLM: fields, methods (via props whose type is callable),
   * index signature (via `get()`), and call signature (via `call()`).
   *
   *   type Task {
   *     // short headline
   *     title: string
   *     // completed?
   *     done: boolean
   *     due?: Date | undefined
   *     // object.has
   *     has(key: string): boolean
   *     [key: "title" | "done" | "due"]: string | boolean | Date | undefined
   *   }
   */
  toCodeDefinition(): string {
    const lines: string[] = [];

    // Call-local type aliases — rendered first so they read like
    // class-level type-alias declarations and can be referenced when
    // reading the constructor / call signature lines below.
    const call = this.definitionCall();
    if (call?.types) {
      for (const [name, t] of Object.entries(call.types)) {
        lines.push(`  type ${name} = ${t.toCode()};`);
      }
    }

    // Constructor — rendered first so the shape reads like a class.
    const init = this.definitionInit();
    if (init) {
      if (init.docs) lines.push(`  // ${init.docs}`);
      lines.push(`  new(${formatParams(init.args)})`);
    }

    // Call signature (`fn` / iface with call / Extension with call).
    if (call) {
      const ret = call.returns?.toCode() ?? 'void';
      lines.push(`  (${formatParams(call.args)}): ${ret}`);
    }

    // Index signature.
    const gs = this.definitionGet();
    if (gs) lines.push(`  [key: ${gs.key.toCode()}]: ${gs.value.toCode()}`);

    // Fields + methods.
    const ownGenerics = new Set(Object.keys(this.generic));
    for (const [name, raw] of Object.entries(this.definitionProps())) {
      const prop = raw instanceof Prop ? raw : Prop.from(raw);
      if (prop.docs) lines.push(`  // ${prop.docs}`);
      const optional = prop.type.isOptional();
      const t = optional ? prop.type.required() : prop.type;
      const opt = optional ? '?' : '';
      // "Method" shape = pure callable: has call() and nothing else. An
      // Extension that adds get/props/fields atop a fn still has data;
      // render it as a field so those surfaces aren't hidden.
      const propCall = t.call();
      const nonUniversalKeys = Object.keys(t.props())
        .filter((k) => !Type.UNIVERSAL_PROP_NAMES.has(k));
      const pureCallable = !!propCall
        && !t.get()
        && nonUniversalKeys.length === 0;
      if (pureCallable) {
        const ret = propCall!.returns?.toCode() ?? 'void';
        // Method-level generics — declared on the fn's `.generic`, filtered
        // to those NOT inherited from the outer type's own generics.
        const methodGen = Object.fromEntries(
          Object.entries(t.generic).filter(([k]) => !ownGenerics.has(k)),
        );
        const gParams = renderGenerics(methodGen);
        lines.push(`  ${name}${opt}${gParams}(${formatParams(propCall!.args)}): ${ret}`);
      } else {
        lines.push(`  ${name}${opt}: ${t.toCode()}`);
      }
    }

    const docLine = this.docs ? `// ${this.docs}\n` : '';
    const header = `${docLine}type ${this.name}${renderGenerics(this.generic)}${this.extendsClause()}`;
    return lines.length === 0 ? `${header} {}` : `${header} {\n${lines.join('\n')}\n}`;
  }

  // ─── SUPER HOOKS (for Extension overrides) ───────────────────────────────

  /**
   * If `self`'s type is an Extension whose local override covers prop `name`,
   * build a Fn Value that delegates to the base impl for the given
   * direction ('get' | 'set' | 'callSet'). Non-Extension types return
   * undefined. Moved here so Prop's runtime methods can call it
   * polymorphically without instanceof checks.
   */
  propSuperFor(
    _self: Value,
    _name: string,
    _direction: 'get' | 'set' | 'callSet',
    _scope: Scope,
    _engine: Engine,
  ): Value | undefined {
    return undefined;
  }

  /** Analogous hook for indexed-access overrides. */
  indexSuperFor(
    _self: Value,
    _direction: 'get' | 'set',
    _scope: Scope,
    _engine: Engine,
  ): Value | undefined {
    return undefined;
  }

  // ─── VALIDATE ────────────────────────────────────────────────────────────

  /**
   * Walk this Type collecting structural problems (round-trip encode/parse
   * as a minimum sanity check). Types may override to add deeper checks.
   * Matches the Node interface shared with Expr.
   */
  validate(_engine: Engine): Problems {
    const p = new Problems();
    try {
      this.registry.parse(this.toJSON());
    } catch (err) {
      p.error('type.invalid', (err as Error).message);
    }
    return p;
  }

  // ─── DESCRIBE (optional) ─────────────────────────────────────────────────

  /**
   * Optionally infer a Type from sample data. Returns undefined if this
   * type class cannot represent the sample. describe() tiebreaks use
   * priority — higher priority = tried first.
   */
  describe?(data: unknown, cache?: Map<unknown, Type>): Type | undefined;
}

/**
 * Serialize a type's `options` as gin's `{key=value, …}` suffix. Empty /
 * all-undefined options render as the empty string, so primitives without
 * narrowing (`num`, `text`) stay bare. Values use JSON encoding for
 * strings / null / arrays / objects; numbers and booleans render literal.
 */
export function optionsCode(opts: object | undefined | null): string {
  if (!opts) return '';
  const entries = Object.entries(opts as Record<string, unknown>)
    .filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    const encoded = typeof v === 'string'
      ? JSON.stringify(v)
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : v === null
          ? 'null'
          : JSON.stringify(v);
    return `${k}=${encoded}`;
  });
  return `{${parts.join(', ')}}`;
}

/**
 * Render a Call's `types` (call-local type aliases) as a header block
 * `{a: <code>; b: <code>}` immediately after the generic params and
 * before the parameter list. Empty / missing map → empty string.
 */
export function renderCallTypes(
  types: Record<string, Type> | undefined,
): string {
  if (!types) return '';
  const keys = Object.keys(types);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => `${k}: ${types[k]!.toCode()}`);
  return `{${parts.join('; ')}}`;
}

/**
 * Render a type's generic-parameter map as `<T, U: Bound>`. `T` when
 * bound is `any` (unconstrained) or a self-referencing AliasType
 * placeholder, `T: code` otherwise. Shared by type headers and fn
 * signatures.
 */
export function renderGenerics(generic: Record<string, Type>): string {
  const keys = Object.keys(generic);
  if (keys.length === 0) return '';
  const parts = keys.map((k) => {
    const t = generic[k]!;
    const selfRef = t.name === 'alias'
      && (t.options as { name?: string } | undefined)?.name === k;
    return t.name === 'any' || selfRef ? k : `${k}: ${t.toCode()}`;
  });
  return `<${parts.join(', ')}>`;
}

/**
 * Render a function-args type as a flattened param list for TS-ish
 * signatures (`a: T, b?: U`). `r.method({...})` always builds an obj
 * type for args, so duck-typing on `.fields` covers the common case;
 * anything else falls back to a single `args: <code>` param.
 */
export function formatParams(args: Type): string {
  const fields = (args as unknown as { fields?: Record<string, Prop> }).fields;
  if (!fields) return args.name === 'void' || args.name === 'any'
    ? ''
    : `args: ${args.toCode()}`;
  const parts = Object.entries(fields).map(([name, prop]) => {
    const optional = prop.type.isOptional();
    const t = optional ? prop.type.required() : prop.type;
    const docs = prop.docs ? `/* ${prop.docs} */ ` : '';
    return `${docs}${name}${optional ? '?' : ''}: ${t.toCode()}`;
  });
  return parts.join(', ');
}
