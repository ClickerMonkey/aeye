import type { Registry } from './registry';
import { LocalScope, type TypeScope } from './type-scope';
import type { ExprDef, TypeDef, PathDef, PathStepDef, PropDef, GetSetDef, CallDef } from './schema';
import { Expr } from './expr';
import { Value, val } from './value';
import { Code, span as spanCode, type JSONEntry } from './code';
import type { Node, CodeOptions } from './node';
import type { Engine } from './engine';
import { Problems } from './problem';
import { walkValidate } from './analysis';
import { ReturnSignal } from './flow-control';
import type { Scope } from './scope';
import type { JSONOf, RuntimeOf } from './json-type';
import { z } from 'zod';
import type { SchemaOptions, ValueSchemaOptions } from './node';
import { Effects } from './effects';

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
  get?: Expr;
  set?: Expr;
  default?: Expr;
  docs?: string;
}

export class Prop {
  readonly type: Type;
  readonly get?: Expr;
  readonly set?: Expr;
  readonly default?: Expr;
  readonly docs?: string;

  constructor(spec: PropSpec) {
    this.type = spec.type;
    this.get = spec.get;
    this.set = spec.set;
    this.default = spec.default;
    this.docs = spec.docs;
  }

  /**
   * Normalize any Prop-shaped input into a `Prop` instance.
   *
   * Accepts:
   *   - `Prop` instance — returned as-is when fields are already
   *     canonical, otherwise rebuilt with defensive re-parsing
   *     (test fixtures sometimes bypass the type system with
   *     `as any` and end up with raw `ExprDef` in `.get`/`.set`/
   *     `.default`).
   *   - `PropSpec` — plain object with parsed `Type` and `Expr` fields.
   *   - `PropDef` — JSON-shape with `TypeDef` and `ExprDef` fields.
   *     Requires `scope` so types/exprs can be parsed.
   *
   * `scope` is optional for instance/spec inputs whose fields are
   * already parsed; mandatory when any field needs parsing.
   */
  static from(x: Prop | PropSpec | PropDef, scope?: TypeScope): Prop {
    const rawType = (x as { type: unknown }).type;
    const type = rawType instanceof Type
      ? rawType
      : (() => {
          if (!scope) throw new Error('Prop.from: type is TypeDef but no scope provided to parse it');
          return scope.parse(rawType as TypeDef);
        })();
    // `scope.parseExpr` is overloaded over `Expr | ExprDef | undefined`
    // — passthrough for instances, parse for ExprDefs, undefined for
    // missing. When no scope is passed (instance/spec passthrough call)
    // an instance field survives directly while an ExprDef field is
    // silently dropped — matches the legacy `as any` test-fixture
    // tolerance without needing a parallel `parseExprMaybe` helper.
    const toExpr = (v: Expr | ExprDef | undefined): Expr | undefined =>
      v instanceof Expr ? v : scope?.parseExpr(v);
    const get = toExpr((x as { get?: Expr | ExprDef }).get);
    const set = toExpr((x as { set?: Expr | ExprDef }).set);
    const def = toExpr((x as { default?: Expr | ExprDef }).default);
    if (x instanceof Prop && x.type === type && x.get === get && x.set === set && x.default === def) {
      return x;
    }
    return new Prop({ type, get, set, default: def, docs: (x as { docs?: string }).docs });
  }

  /** Map a record of `PropDef` / `PropSpec` / `Prop` values into a
   *  record of `Prop` instances. Idempotent per-entry via `Prop.from`. */
  static fromMap(
    defs: Record<string, Prop | PropSpec | PropDef>,
    scope?: TypeScope,
  ): Record<string, Prop> {
    const out: Record<string, Prop> = {};
    for (const [name, def] of Object.entries(defs)) out[name] = Prop.from(def, scope);
    return out;
  }

  /** Inverse of `fromMap` — encode a record of Prop/PropSpec values
   *  to their JSON `PropDef` form. */
  static toJSONMap(props: Record<string, Prop | PropSpec>): Record<string, PropDef> {
    const out: Record<string, PropDef> = {};
    for (const [name, prop] of Object.entries(props)) out[name] = Prop.from(prop).toJSON();
    return out;
  }

  /** Serialize to PropDef JSON. Inverse of `Prop.from`. */
  toJSON(): PropDef {
    return {
      docs: this.docs,
      type: this.type.toJSON(),
      get: this.get?.toJSON(),
      default: this.default?.toJSON(),
      set: this.set?.toJSON(),
    };
  }

  // ─── runtime ops (called by Path.walk) ─────────────────────────────────

  /** Read this prop on `self`: evaluate get Expr with {this, super?}, or
   *  delegate to the parent type's `propGet` fallback. */
  async read(self: Value, name: string, scope: Scope, engine: Engine): Promise<Value> {
    if (this.get) {
      const bindings: Record<string, Value> = { this: self };
      const sup = self.type.propSuperFor(self, name, 'get', scope, engine);
      if (sup) bindings.super = sup;
      return this.get.evaluate(engine, scope.child(bindings));
    }
    return self.type.propGet(self, name, this.type);
  }

  /**
   * Write this prop on `self` with the given value.
   *
   *   1. Prop declares an explicit `set` Expr → run it.
   *   2. Prop is COMPUTED (`get` Expr present, no `set`, type not
   *      callable) → throw; there's no slot to hold a written value.
   *   3. Otherwise → delegate to the parent type's `propSet`. Each
   *      Type subclass decides whether prop writes are meaningful
   *      against its raw shape (obj / iface / any: yes; num / text /
   *      list: no — `propSet` throws there).
   *
   * Method-typed props carry their body in `this.get`, so the
   * `!this.type.call()` guard keeps method assignment from being
   * mis-flagged as a computed-prop write.
   */
  async write(self: Value, name: string, value: Value, scope: Scope, engine: Engine): Promise<void> {
    if (this.set) {
      const bindings: Record<string, Value> = { this: self, value };
      const sup = self.type.propSuperFor(self, name, 'set', scope, engine);
      if (sup) bindings.super = sup;
      await this.set.evaluate(engine, scope.child(bindings));
      return;
    }
    if (this.get && !this.type.call()) {
      throw new Error(`path: prop '${name}' is computed (has 'get', no 'set') — cannot assign to it`);
    }
    self.type.propSet(self, name, value);
  }

  /**
   * Invoke this prop as a method: runs get Expr with {this, args, super?, recurse}.
   * `fnType` is the effective (possibly generic-bound) Fn type used for the
   * recurse Value's type; defaults to this.type.
   *
   * When the prop has no `get` expression — the case for natively-installed
   * globals like `fns.fetch` / `fns.llm` whose obj-field raw is a JS
   * callable — fall back to invoking the raw value directly. This mirrors
   * `Prop.read`'s direct-field fallback and the value-call branch in
   * `Path.walk` (which is the path taken when the call follows a value
   * read, not a method dispatch).
   */
  async invokeMethod(
    self: Value,
    name: string,
    argsValue: Value,
    scope: Scope,
    engine: Engine,
    fnType?: Type,
  ): Promise<Value> {
    const effectiveType = fnType ?? this.type;
    if (!this.get) {
      const raw = (self.raw as Record<string, unknown> | null | undefined)?.[name];
      const target = raw instanceof Value ? raw.raw : raw;
      if (typeof target === 'function') {
        return await (target as (a: Value) => Promise<Value>)(argsValue);
      }
      // Stored ExprDef (a lambda saved as JSON) — evaluate it to a callable
      // Value first, then invoke. Mirrors how saved-fn globals dispatch.
      if (target && typeof target === 'object' && 'kind' in (target as Record<string, unknown>)) {
        const lambdaValue = await engine.evaluate(target as ExprDef, scope);
        if (typeof lambdaValue.raw === 'function') {
          return await (lambdaValue.raw as (a: Value) => Promise<Value>)(argsValue);
        }
      }
      throw new Error(`path: callable prop '${name}' has no get expression and raw is not a callable`);
    }
    const getExpr = this.get;
    const callable = async (newArgs: Value): Promise<Value> => {
      const recurseValue = new Value(effectiveType, callable);
      const bindings: Record<string, Value> = { this: self, args: newArgs, recurse: recurseValue };
      const sup = self.type.propSuperFor(self, name, 'get', scope, engine);
      if (sup) bindings.super = sup;
      // Catch `ReturnSignal` here so a saved fn body or method body
      // can use `flow: 'return'` for early-exit. The body is the call
      // boundary even though it's not literally wrapped in a
      // LambdaExpr — same semantics as Lambda.evaluate's catch.
      try {
        return await getExpr.evaluate(engine, scope.child(bindings));
      } catch (sig) {
        if (sig instanceof ReturnSignal) {
          return sig.value ?? new Value(engine.registry.void(), undefined);
        }
        throw sig;
      }
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
      await callSpec.set!.evaluate(engine, scope.child(bindings));
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
  readonly get?: Expr;
  readonly set?: Expr;
  readonly loop?: Expr;
  /** When true, `LoopExpr` re-evaluates `over` each iteration and
   *  exits on falsy `raw`. See `GetSetDef.loopDynamic`. */
  readonly loopDynamic?: boolean;
  readonly docs?: string;

  constructor(spec: {
    key: Type<K>;
    value: Type<V>;
    get?: Expr;
    set?: Expr;
    loop?: Expr;
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

  /**
   * Normalize any GetSet-shaped input into a `GetSet` instance.
   * Mirrors `Prop.from`: accepts an instance, a spec (key/value as Type),
   * or a GetSetDef (key/value as TypeDef). `scope` is required when any
   * field needs parsing.
   */
  static from(
    x: GetSet | {
      key: Type;
      value: Type;
      get?: Expr | ExprDef;
      set?: Expr | ExprDef;
      loop?: Expr | ExprDef;
      loopDynamic?: boolean;
      docs?: string;
    } | GetSetDef,
    scope?: TypeScope,
  ): GetSet {
    const rawKey = (x as { key: unknown }).key;
    const rawValue = (x as { value: unknown }).value;
    const key = rawKey instanceof Type ? rawKey
      : (() => { if (!scope) throw new Error('GetSet.from: key is TypeDef but no scope provided'); return scope.parse(rawKey as TypeDef); })();
    const value = rawValue instanceof Type ? rawValue
      : (() => { if (!scope) throw new Error('GetSet.from: value is TypeDef but no scope provided'); return scope.parse(rawValue as TypeDef); })();
    const toExpr = (v: Expr | ExprDef | undefined): Expr | undefined =>
      v instanceof Expr ? v : scope?.parseExpr(v);
    const get = toExpr((x as { get?: Expr | ExprDef }).get);
    const set = toExpr((x as { set?: Expr | ExprDef }).set);
    const loop = toExpr((x as { loop?: Expr | ExprDef }).loop);
    if (x instanceof GetSet
      && x.key === key && x.value === value
      && x.get === get && x.set === set && x.loop === loop) {
      return x;
    }
    return new GetSet({
      key, value, get, set, loop,
      loopDynamic: (x as { loopDynamic?: boolean }).loopDynamic,
      docs: (x as { docs?: string }).docs,
    });
  }

  /** Serialize to GetSetDef JSON. Inverse of `GetSet.from`. */
  toJSON(): GetSetDef {
    return {
      docs: this.docs,
      key: this.key.toJSON(),
      value: this.value.toJSON(),
      get: this.get?.toJSON(),
      set: this.set?.toJSON(),
      loop: this.loop?.toJSON(),
      loopDynamic: this.loopDynamic,
    };
  }

  /** Read this[key]: runs get Expr with {this, key, super?}. */
  async indexRead(self: Value, keyValue: Value, scope: Scope, engine: Engine): Promise<Value> {
    if (!this.get) throw new Error(`path: type '${self.type.name}' has no index get`);
    const bindings: Record<string, Value> = { this: self, key: keyValue };
    const sup = self.type.indexSuperFor(self, 'get', scope, engine);
    if (sup) bindings.super = sup;
    return this.get.evaluate(engine, scope.child(bindings));
  }

  /** Write this[key] = value: runs set Expr with {this, key, value, super?}. */
  async indexWrite(self: Value, keyValue: Value, value: Value, scope: Scope, engine: Engine): Promise<void> {
    if (!this.set) throw new Error(`path: type '${self.type.name}' has no index set`);
    const bindings: Record<string, Value> = { this: self, key: keyValue, value };
    const sup = self.type.indexSuperFor(self, 'set', scope, engine);
    if (sup) bindings.super = sup;
    await this.set.evaluate(engine, scope.child(bindings));
  }
}

/**
 * Runtime Call — callable spec, with arg/return/throws Types resolved.
 *
 * `args` / `returns` / `throws` are parsed inside the call's local
 * scope (a `LocalScope` carrying any `CallDef.types` aliases plus
 * declared generics). Bare alias references inside those Types are
 * `AliasType` instances that resolve via that scope; their `toJSON()`
 * emits the bare-name form, which `Call.from` then rebuilds against
 * a freshly constructed LocalScope on round-trip. No source-form
 * preservation needed — the structure is symmetric.
 */
export class Call<TArgs extends object = any, TResult = any, TError = any> {
  readonly args: Type<TArgs>;
  readonly returns?: Type<TResult>;
  readonly throws?: Type<TError>;
  readonly get?: Expr;
  readonly set?: Expr;
  readonly docs?: string;

  /** Call-local type aliases declared on `CallDef.types`, parsed.
   *  Public so rendering (toCode / toCodeDefinition) can surface the
   *  alias header. Populated only when aliases were declared. */
  readonly types?: Record<string, Type>;

  constructor(spec: {
    args: Type<TArgs>;
    returns?: Type<TResult>;
    throws?: Type<TError>;
    get?: Expr;
    set?: Expr;
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

  /**
   * Normalize any Call-shaped input into a `Call` instance.
   *
   * Accepts an instance, a parsed spec (args/returns as Type), or a
   * `CallDef` JSON. When `def.types` is non-empty a `LocalScope` is
   * built and each alias is sequentially parsed — earlier aliases are
   * visible to later ones AND to the call's args/returns/throws/get/set.
   * The resolved alias map is retained on the Call so `toJSON()` can
   * round-trip it.
   *
   * `scope` is required when args/returns/throws are TypeDefs or
   * get/set are ExprDefs; optional when everything is already parsed.
   */
  static from(
    x: Call | (ConstructorParameters<typeof Call>[0] & { get?: Expr | ExprDef; set?: Expr | ExprDef }) | CallDef,
    scope?: TypeScope,
  ): Call {
    // Build the effective scope for nested resolution. When the input
    // carries a `types` alias map (CallDef shape), bind each alias in
    // a LocalScope layered on top of the caller's scope.
    const rawTypes = (x as { types?: Record<string, Type | TypeDef> }).types;
    let inner: TypeScope | undefined = scope;
    let aliases: Record<string, Type> | undefined;
    if (rawTypes && Object.keys(rawTypes).length > 0) {
      // If every value is already a parsed Type, the instance/spec is
      // pre-resolved — surface it verbatim. Otherwise build the
      // LocalScope (requires scope).
      const allParsed = Object.values(rawTypes).every((t) => t instanceof Type);
      if (allParsed) {
        aliases = rawTypes as Record<string, Type>;
      } else {
        if (!scope) throw new Error('Call.from: types contain TypeDef but no scope provided');
        const local = new LocalScope(scope);
        inner = local;
        aliases = {};
        for (const [name, aliasDef] of Object.entries(rawTypes)) {
          const t = aliasDef instanceof Type ? aliasDef : local.parse(aliasDef);
          local.bind(name, t);
          aliases[name] = t;
        }
      }
    }

    const rawArgs = (x as { args: unknown }).args;
    const rawReturns = (x as { returns?: unknown }).returns;
    const rawThrows = (x as { throws?: unknown }).throws;
    const args = rawArgs instanceof Type ? rawArgs
      : (() => { if (!inner) throw new Error('Call.from: args is TypeDef but no scope provided'); return inner.parse(rawArgs as TypeDef); })();
    const returns = rawReturns === undefined ? undefined
      : rawReturns instanceof Type ? rawReturns
      : (() => { if (!inner) throw new Error('Call.from: returns is TypeDef but no scope provided'); return inner.parse(rawReturns as TypeDef); })();
    const throws = rawThrows === undefined ? undefined
      : rawThrows instanceof Type ? rawThrows
      : (() => { if (!inner) throw new Error('Call.from: throws is TypeDef but no scope provided'); return inner.parse(rawThrows as TypeDef); })();
    const toExpr = (v: Expr | ExprDef | undefined): Expr | undefined =>
      v instanceof Expr ? v : inner?.parseExpr(v);
    const get = toExpr((x as { get?: Expr | ExprDef }).get);
    const set = toExpr((x as { set?: Expr | ExprDef }).set);
    const docs = (x as { docs?: string }).docs;
    if (x instanceof Call
      && x.args === args && x.returns === returns && x.throws === throws
      && x.get === get && x.set === set && x.types === aliases) {
      return x;
    }
    return new Call({ args: args as Type<any>, returns, throws, get, set, docs, types: aliases });
  }

  /** Serialize to CallDef JSON. Inverse of `Call.from`. */
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
      get: this.get?.toJSON(),
      set: this.set?.toJSON(),
    };
  }

  /**
   * Render the call-local type aliases (`this.types`) as a header
   * block `{a: <code>; b: <code>}`, suitable for placement between
   * the fn-type's generic params and parameter list. Returns the
   * empty string when there are no aliases.
   */
  renderTypes(options?: CodeOptions): string {
    if (!this.types) return '';
    const keys = Object.keys(this.types);
    if (keys.length === 0) return '';
    const parts = keys.map((k) => `${k}: ${this.types![k]!.toCode(undefined, options)}`);
    return `{${joinAuto(parts, { sep: '; ' })}}`;
  }

  /** OR of effects from the parsed `get` / `set` bodies — invoking
   *  this call runs one of them, so their `effects()` IS the call's
   *  effects. Returns NONE for purely-declared (body-less) calls. */
  effects(): Effects {
    let acc: Effects = 0;
    if (this.get) acc |= this.get.effects();
    if (this.set) acc |= this.set.effects();
    return acc;
  }
}

/**
 * Runtime Init — constructor spec for `{ kind: 'new' }` with args.
 */
export class Init<TArgs extends object = any> {
  readonly args: Type<TArgs>;
  readonly run: Expr;
  readonly docs?: string;

  constructor(spec: { args: Type<TArgs>; run: Expr; docs?: string }) {
    this.args = spec.args;
    this.run = spec.run;
    this.docs = spec.docs;
  }

  /**
   * Normalize any Init-shaped input into an `Init` instance.
   *
   * Accepts an instance, a spec (args as Type, run as Expr), or an
   * InitDef JSON (args as TypeDef, run as ExprDef). `scope` is
   * required when any field needs parsing. Throws when `run`
   * fundamentally can't be resolved — Init's body is mandatory.
   */
  static from(
    x: Init | { args: Type; run: Expr | ExprDef; docs?: string } | NonNullable<TypeDef['init']>,
    scope?: TypeScope,
  ): Init {
    const rawArgs = (x as { args: unknown }).args;
    const args = rawArgs instanceof Type ? rawArgs
      : (() => { if (!scope) throw new Error('Init.from: args is TypeDef but no scope provided'); return scope.parse(rawArgs as TypeDef); })();
    const rawRun = (x as { run: unknown }).run;
    const run = rawRun instanceof Expr ? rawRun
      : (() => { if (!scope) throw new Error('Init.from: run is ExprDef but no scope provided'); return scope.parseExpr(rawRun as ExprDef); })();
    if (x instanceof Init && x.args === args && x.run === run) return x;
    return new Init({ args: args as Type<any>, run, docs: (x as { docs?: string }).docs });
  }

  /** Serialize to InitDef JSON. Inverse of `Init.from`. */
  toJSON(): NonNullable<TypeDef['init']> {
    return {
      docs: this.docs,
      args: this.args.toJSON(),
      run: this.run.toJSON(),
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
    // Universal props every type carries.
    const base: Record<string, Prop | PropSpec> = {
      toAny: this.registry.method({}, this.registry.any(), 'type.toAny'),
    };
    // Spread registry-augmentation props BEFORE returning. Subclasses
    // override `props()` and prepend `super.props()` to their own —
    // so augmentation lands BEFORE the subclass's intrinsic methods,
    // i.e. intrinsic wins on name conflict (`num.add` can't be
    // accidentally replaced by augmenting `num` with another `add`).
    const aug = this.registry.augmentation(this.name);
    if (!aug?.props) return base;
    return { ...base, ...aug.props };
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

  /** Effective GetSet — present iff this type supports [key] access.
   *  Falls back to a registry-augmentation when the type itself
   *  declares none. Augmentation NEVER overrides an intrinsic — it
   *  only fills the gap. (Subclasses that declare their own `get`
   *  override this method and don't consult augmentation.) */
  get(_scope?: TypeScope): GetSet | undefined {
    return this.registry.augmentation(this.name)?.get;
  }

  /** Effective Call — present iff this type is invocable. Augmented
   *  via `registry.augment(name, { call })` for types that aren't
   *  natively callable (e.g. making `timestamp` invocable). */
  call(_scope?: TypeScope): Call | undefined {
    return this.registry.augmentation(this.name)?.call;
  }

  /** Effective Init — present iff this type has a custom constructor.
   *  Augmented via `registry.augment(name, { init })` for types that
   *  don't natively define one. When `init` is set on a type, `new T(args)`
   *  routes through it — see `NewExpr.evaluate`. */
  init(_scope?: TypeScope): Init | undefined {
    return this.registry.augmentation(this.name)?.init;
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
  // includes the binding (see `FnType.from`'s LocalScope, `Call.from`'s
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
   * Default behaviour:
   *   - When the type defines `init()` (a constructor), the value
   *     slot IS the init's args obj. `new <T>(args)` literally calls
   *     `init.run` with `args` parsed against `init.args`, so the
   *     schema the LLM sees should be that args type.
   *   - Otherwise fall through to `toValueSchema(opts)`.
   *
   * Composites still override (list / map / obj / tuple / typ / ...
   * have richer Expr-slot shapes that don't fit the init mould).
   */
  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    const init = this.init();
    if (init) {
      return this.describeType(init.args.toValueSchema(opts), opts, 'NewValue_');
    }
    return this.toValueSchema(opts);
  }

  /**
   * Effects produced when a `new <ThisType>{value}` expression is
   * evaluated — used by `NewExpr.effects()`. The default impl combines
   * two contributions:
   *
   *   1. `init.run` effects — if this Type has an `init` constructor,
   *      parse its body and OR in its effects.
   *   2. If `value` is itself a recognizable ExprDef (e.g. someone
   *      threaded a `get` or another `new` directly into the value
   *      slot), parse it and OR its effects.
   *
   * Composite Types (list, obj, tuple, map) override to additionally
   * walk their declared slot structure and OR each slot's effects
   * through the appropriate child type's `newEffects`. That keeps the
   * walk type-driven — each Type knows the shape of its value payload,
   * so we don't have to play "guess the ExprDef" on raw JSON.
   *
   * Performance: parses on every call. Effects analysis runs at
   * validate time (once per write), not per-eval, so this is fine.
   */
  newEffects(value: unknown): Effects {
    const init = this.initEffects();
    return init | this.exprValueEffects(value);
  }

  /**
   * Helper for `newEffects`: if `value` is shaped like an Expr (an
   * object with `kind: string` matching a registered Expr class),
   * parse and return its effects. Otherwise NONE. Used both by the
   * base `newEffects` and by composite overrides handling "value slot
   * is itself an ExprDef" before recursing.
   */
  protected exprValueEffects(value: unknown): Effects {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Effects.NONE;
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind !== 'string') return Effects.NONE;
    if (!this.registry.exprClass(kind)) return Effects.NONE;
    try {
      return this.registry.parseExpr(value as ExprDef, this.scope).effects();
    } catch {
      return Effects.NONE;
    }
  }

  /**
   * Helper for `newEffects`: parse the type's `init.run` and return
   * its effects. NONE when the type has no init.
   */
  protected initEffects(): Effects {
    const i = this.init();
    if (!i) return Effects.NONE;
    try {
      return this.registry.parseExpr(i.run, this.scope).effects();
    } catch {
      return Effects.NONE;
    }
  }

  /**
   * Structural complexity of a `new <T>{value: ...}` construction.
   * Composite types (`list`, `map`, `obj`, `tuple`) override to walk
   * their value-slot shape and sum nested-Expr complexity; scalar /
   * opaque types fall through to this base implementation which adds
   * a flat 1 + `initComplexity()` + any Expr embedded directly in
   * `value`. Mirrors the `newEffects` / `exprValueEffects` /
   * `initEffects` pattern.
   */
  newComplexity(value: unknown): number {
    return 1 + this.initComplexity() + this.exprValueComplexity(value);
  }

  /**
   * Helper for `newComplexity`: if `value` is an embedded ExprDef,
   * parse it and return its complexity. 0 otherwise. Used both by
   * the base `newComplexity` and by composite overrides that need to
   * handle the "value slot is itself an Expr" case before walking
   * their container shape.
   */
  protected exprValueComplexity(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    const kind = (value as { kind?: unknown }).kind;
    if (typeof kind !== 'string') return 0;
    if (!this.registry.exprClass(kind)) return 0;
    try {
      return this.registry.parseExpr(value as ExprDef, this.scope).complexity();
    } catch {
      return 0;
    }
  }

  /** Complexity of the type's own `init.run` body. 0 when the type
   *  has no init. */
  protected initComplexity(): number {
    const i = this.init();
    if (!i) return 0;
    try {
      return this.registry.parseExpr(i.run, this.scope).complexity();
    } catch {
      return 0;
    }
  }

  /**
   * Per-element / per-slot complexity contribution used by composite
   * Types (`list`, `map`, `obj`, `tuple`) when walking their value
   * shape. If the slot is an embedded Expr (`{kind:..., ...}`), parse
   * it and return its complexity. Otherwise the slot is a raw
   * literal — treat it as cost 1. This is distinct from
   * `newComplexity`, which always adds a `1` for the construction
   * envelope; element slots inside a composite already have their
   * envelope cost counted by the parent's `1 + init`.
   */
  // `public` (not `protected`): container types (list / map / obj / tuple) sum
  // this over their ELEMENT types, i.e. call it on OTHER `Type` instances — which
  // a base-typed reference cannot do for a `protected` member.
  public elementComplexity(value: unknown): number {
    const exprCost = this.exprValueComplexity(value);
    return exprCost > 0 ? exprCost : 1;
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
   *
   * Subclasses MUST implement this; the base `toGinCode` reaches into
   * the subclass's `toCode` to produce a coarse-span fallback.
   */
  abstract toCode(registry?: Registry, options?: CodeOptions): string;

  /**
   * Render as gin's TS-pseudocode form as a structured `Code` value
   * carrying spans. Default: wrap the legacy `toCode` output in a
   * single coarse span tagged with `path` + `type: this`. Composite
   * types (obj/list/map/tuple/fn/iface) override to thread child
   * paths through.
   */
  toGinCode(
    registry?: Registry,
    options?: CodeOptions,
    path: ReadonlyArray<string | number> = [],
  ): Code {
    const text = this.toCode(registry, options);
    return spanCode(text, { path, type: this });
  }

  /**
   * Render as the JSON form of `toJSON()` with spans aligned to JSON
   * positions. Walks the standard `TypeDef` structure (props / get /
   * call / init / generic / options / constraint / etc.) so each
   * sub-slot — and every embedded ExprDef inside Prop.get,
   * GetSet.get/set/loop, Call.get/set, Init.run, constraint — gets
   * its own span, with nested types recursing into their own
   * `toJSONCode`. This makes `formatProblem` / `formatProblems` able
   * to underline the precise offending range inside a type
   * definition (the same way they already do inside Expr trees).
   *
   * Subclasses can override for custom shapes; otherwise this default
   * suffices for every TypeDef-shaped JSON.
   */
  toJSONCode(
    path: ReadonlyArray<string | number> = [],
    indent: number = 2,
    level: number = 0,
  ): Code {
    return renderTypeDefJSONCode(this.toJSON(), this.registry, path, indent, level, this);
  }

  /**
   * Inline `/* docs * /` prefix for `toCode` output. Always returns empty
   * by default — type docs would otherwise repeat at every reference,
   * burying real signal in noise (every `args.x: T` annotation, every
   * `new T {...}`, every type parameter would carry the full prose). Docs
   * stay on the type definition (rendered as a `/// docs` header by
   * `toCodeDefinition`) where they describe the type ONCE. The hook
   * exists so a subclass could opt back in with policy if needed; today
   * none do.
   */
  protected docsPrefix(_options?: CodeOptions): string {
    return '';
  }

  /** ` extends <base>` clause on the `type <name>` header — empty for
   *  built-in classes; Extension overrides to show its base type. */
  protected extendsClause(_options?: CodeOptions): string {
    return '';
  }

  /**
   * This type as a REFERENCE rather than a declaration — how it should
   * appear in an `extends <base>` clause. Defaults to `toCode()`, which
   * is already the reference form for all but two classes: `obj` and
   * `interface` inline their whole MEMBER BLOCK, and that block on a
   * header line is the defect this hook exists for (`type todo_task
   * extends obj{id: text, due_date?: timestamp, …}` — 250 characters
   * before the body even starts).
   *
   * Note what is deliberately NOT elided: option narrowing stays
   * (`extends text{pattern="^\\d+$"}`) because it is compact, it is not
   * a member, and there is nowhere else in the definition to put it;
   * and `list<T>` / `map<K,V>` / `tuple<…>` / fn signatures stay whole
   * because their arguments are a type EXPRESSION, not a member block.
   *
   * The contract with {@link refProps}: whatever this elides, the
   * definition body recovers. See `Extension.definitionProps`.
   */
  toCodeRef(registry?: Registry, options?: CodeOptions): string {
    return this.toCode(registry, options);
  }

  /**
   * The props {@link toCodeRef} elides — this type's OWN declared
   * structural surface, excluding the universal props every type carries.
   * Empty by default; `obj` returns its fields and `interface` its
   * declared props.
   *
   * Public (not protected) because `Extension` reads it off `this.base`,
   * which is typed as the base class.
   */
  refProps(): Record<string, Prop | PropSpec> {
    return {};
  }

  /**
   * The index signature {@link toCodeRef} elides, if its `toCode` showed
   * one. Undefined by default — and notably undefined on `obj`, whose
   * `get()` is DERIVED from its fields and never appeared in the inlined
   * form, so recovering it would add a per-field key union nobody wrote.
   */
  refGet(): GetSet | undefined {
    return undefined;
  }

  /** The call signature {@link toCodeRef} elides, if its `toCode` showed
   *  one. Undefined by default; `interface` overrides. */
  refCall(): Call | undefined {
    return undefined;
  }

  /**
   * Render a generic-parameter map as `<T, U: Bound>`. `T` alone when
   * its bound is `any` (unconstrained) or a self-referencing
   * `AliasType` placeholder; `T: code` otherwise. Shared by type
   * headers (`type Foo<T> ...`) and fn signatures (`<T>(x: T): T`).
   */
  static renderGenerics(
    generic: Record<string, Type>,
    options?: CodeOptions,
  ): string {
    const keys = Object.keys(generic);
    if (keys.length === 0) return '';
    const parts = keys.map((k) => {
      const t = generic[k]!;
      const selfRef = t.name === 'alias'
        && (t.options as { name?: string } | undefined)?.name === k;
      return t.name === 'any' || selfRef ? k : `${k}: ${t.toCode(undefined, options)}`;
    });
    return `<${joinAuto(parts, { indent: indentOf(options) })}>`;
  }

  /**
   * Render a generic-parameter map as the ARGUMENT list at a use site —
   * `<obj{id: text}>`, the bindings alone, no parameter names. Empty when
   * every entry is still an unbound declaration placeholder (a self-
   * referencing `AliasType`, or `any`), because an unspecialized
   * reference has no bindings to show.
   *
   * The counterpart to {@link renderGenerics}, which renders the same map
   * as a DECLARATION (`<Row>` / `<Row: Bound>`) on a type header. One map,
   * two positions: `type QueryResult<Row> …` declares, `QueryResult<obj{id:
   * text}>` uses. Without this a bound reference printed bare, losing the
   * row type — which is the entire point of naming the envelope.
   */
  static renderGenericArgs(
    generic: Record<string, Type>,
    options?: CodeOptions,
  ): string {
    const keys = Object.keys(generic);
    if (keys.length === 0) return '';
    const bound = keys.some((k) => !Type.isGenericPlaceholder(k, generic[k]!));
    if (!bound) return '';
    const parts = keys.map((k) => generic[k]!.toCode(undefined, options));
    return `<${joinAuto(parts, { indent: indentOf(options) })}>`;
  }

  /** True when `t` is `k`'s unbound DECLARATION placeholder rather than a
   *  binding for it — `any` (unconstrained) or the self-referencing
   *  `AliasType` that `registry.alias(k)` produces. */
  static isGenericPlaceholder(k: string, t: Type): boolean {
    if (t.name === 'any') return true;
    return t.name === 'alias' && (t.options as { name?: string } | undefined)?.name === k;
  }

  /**
   * Render a function-args type as a flattened param list for TS-ish
   * signatures (`a: T, b?: U`). `r.method({...})` always builds an
   * obj type for args, so duck-typing on `.fields` covers the common
   * case; anything else falls back to a single `args: <code>` param.
   *
   * `layout: 'lines'` puts every parameter on its own line (newline as
   * the separator, no commas) whenever there is more than one, regardless
   * of width. That is the DECLARATION layout — see `toCodeDefinition` for
   * why a declaration is line-oriented unconditionally. `'auto'` (the
   * default, and what every expression-position caller keeps) wraps only
   * when the compact form gets long.
   */
  static formatParams(
    args: Type,
    options?: CodeOptions,
    layout: 'auto' | 'lines' = 'auto',
  ): string {
    const fields = (args as unknown as { fields?: Record<string, Prop> }).fields;
    if (!fields) return args.name === 'void' || args.name === 'any'
      ? ''
      : `args: ${args.toCode(undefined, options)}`;
    const parts = Object.entries(fields).map(([name, prop]) => {
      const optional = prop.type.isOptional();
      const t = optional ? prop.type.required() : prop.type;
      const docs = prop.docs && options?.includeComments !== false ? `/* ${prop.docs} */ ` : '';
      return `${docs}${name}${optional ? '?' : ''}: ${t.toCode(undefined, options)}`;
    });
    const indent = indentOf(options);
    if (layout === 'auto') return joinAuto(parts, { indent });
    // A lone parameter stays on the method's line whatever its length —
    // there is nothing to line it up against, so breaking it out costs two
    // lines and buys nothing. (`joinAuto` splits at 32 characters, which is
    // why `filter(fn: (value: num, index: num): bool)` used to wrap.)
    if (parts.length <= 1) return parts.join('');
    // Newline IS the separator — a trailing comma on a line-oriented list
    // is pure noise, and the body of a definition already reads this way.
    return `\n${parts.map((p) => indentBlock(p, indent)).join('\n')}\n`;
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
   *   type Task extends obj {
   *     /// short headline
   *     title: text
   *     /// completed?
   *     done: bool
   *     due?: timestamp
   *     /// object.has
   *     has(key: text): bool
   *     [key: "title" | "done" | "due"]: text | bool | timestamp
   *   }
   *
   * **The body is line-oriented UNCONDITIONALLY** — one member per line,
   * and a method's parameters one per line whenever there is more than
   * one, with the closing paren on its own line. Not width-triggered.
   * A definition is a DECLARATION, not an expression: predictability
   * beats compactness for something a reader (a model, mostly) scans
   * top-to-bottom, and a stable one-fact-per-line layout diffs cleanly
   * when a type gains a field. Type EXPRESSIONS keep the width-triggered
   * `joinAuto` wrap, because there the compact form is usually the
   * readable one.
   *
   * Members are rendered anchored at column 0 and stepped in ONCE here,
   * so a wrapped parameter list nests under its method instead of
   * colliding with it (see {@link indentBlock}). `CodeOptions.indent`
   * chooses the step.
   */
  toCodeDefinition(options?: CodeOptions): string {
    /** One rendered member, anchored at column 0. Indented as a block below. */
    const members: string[] = [];
    const includeComments = options?.includeComments !== false;
    const indent = indentOf(options);
    /** `///` — a DOC line, distinguishable at a glance from an ordinary
     *  `//` comment by the same reader convention TS and Rust use. */
    const doc = (text: string): string => `/// ${text}`;

    // Call-local type aliases — rendered first so they read like
    // class-level type-alias declarations and can be referenced when
    // reading the constructor / call signature lines below.
    const call = this.definitionCall();
    if (call?.types) {
      for (const [name, t] of Object.entries(call.types)) {
        members.push(`type ${name} = ${t.toCode(undefined, options)};`);
      }
    }

    // Constructor — rendered first so the shape reads like a class.
    const init = this.definitionInit();
    if (init) {
      if (init.docs && includeComments) members.push(doc(init.docs));
      members.push(`new(${Type.formatParams(init.args, options, 'lines')})`);
    }

    // Call signature (`fn` / iface with call / Extension with call).
    if (call) {
      const ret = call.returns?.toCode(undefined, options) ?? 'void';
      members.push(`(${Type.formatParams(call.args, options, 'lines')}): ${ret}`);
    }

    // Index signature.
    const gs = this.definitionGet();
    if (gs) members.push(`[key: ${gs.key.toCode(undefined, options)}]: ${gs.value.toCode(undefined, options)}`);

    // Fields + methods.
    const ownGenerics = new Set(Object.keys(this.generic));
    for (const [name, raw] of Object.entries(this.definitionProps())) {
      const prop = raw instanceof Prop ? raw : Prop.from(raw);
      if (prop.docs && includeComments) members.push(doc(prop.docs));
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
        const ret = propCall!.returns?.toCode(undefined, options) ?? 'void';
        // Method-level generics — declared on the fn's `.generic`, filtered
        // to those NOT inherited from the outer type's own generics.
        const methodGen = Object.fromEntries(
          Object.entries(t.generic).filter(([k]) => !ownGenerics.has(k)),
        );
        const gParams = Type.renderGenerics(methodGen, options);
        members.push(`${name}${opt}${gParams}(${Type.formatParams(propCall!.args, options, 'lines')}): ${ret}`);
      } else {
        members.push(`${name}${opt}: ${t.toCode(undefined, options)}`);
      }
    }

    const docLine = this.docs && includeComments ? `${doc(this.docs)}\n` : '';
    const header = `${docLine}type ${this.name}${Type.renderGenerics(this.generic, options)}${this.extendsClause(options)}`;
    if (members.length === 0) return `${header} {}`;
    const body = members.map((m) => indentBlock(m, indent)).join('\n');
    return `${header} {\n${body}\n}`;
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

  // ─── STRUCTURAL PROP ACCESS (default fallbacks) ─────────────────────────
  //
  // `Prop.read` and `Prop.write` delegate to these when the prop has no
  // explicit `get` / `set` Expr. Each Type subclass decides whether prop
  // access against its raw shape is meaningful:
  //
  //   - obj / iface / any / extension: yes — raw is structurally a
  //     `Record<string, …>`. The default implementations below already
  //     do the right thing for those.
  //   - num / text / bool / list / map / fn / tuple / enum / literal /
  //     date / duration / timestamp / color / void / null: no — raw
  //     isn't an object. `propGet` returns `Value(propType, undefined)`
  //     (which gracefully turns into undefined / null reads); `propSet`
  //     throws with a clear message.
  //
  // Subclasses can override either method to enforce stricter semantics
  // (e.g. an immutable type rejecting `propSet`, or a typed accessor
  // that wraps raw values according to a per-slot schema).

  /**
   * Read the structural slot at `name` from `self`. The `propType` is
   * the prop's declared type, used to wrap a non-Value raw into a
   * typed Value.
   *
   * Default behaviour: treat `self.raw` as object-shaped, look up
   * `raw[name]`, and return either the stored Value (already typed)
   * or wrap a raw scalar into `val(propType, raw)`. For raws that
   * aren't object-shaped this returns `val(propType, undefined)` —
   * which is what `Prop.read` would have produced before. Types
   * with non-object raws should generally not have props declared
   * against them, so this branch is rarely exercised.
   */
  propGet(self: Value, name: string, propType: Type): Value {
    const raw = self.raw && typeof self.raw === 'object'
      ? (self.raw as Record<string, unknown>)[name]
      : undefined;
    if (raw instanceof Value) return raw;
    return val(propType, raw);
  }

  /**
   * Write `value` into the structural slot at `name` on `self`.
   *
   * Default behaviour: assign directly into `self.raw[name]` for
   * object-shaped raws (works for `obj`, `iface`, `any`, plus any
   * Value backed by a plain JS object — including the `vars` proxy,
   * which observes the assignment via its `set` trap and marks the
   * slot dirty for persistence). Types with non-object raws throw
   * with a clear message — there's nowhere to put the value.
   */
  propSet(self: Value, name: string, value: Value): void {
    if (self.raw && typeof self.raw === 'object') {
      (self.raw as Record<string, unknown>)[name] = value;
      return;
    }
    throw new Error(`type '${this.name}': cannot set prop '${name}' — value's raw is not an object`);
  }

  // ─── VALIDATE ────────────────────────────────────────────────────────────

  /**
   * Walk this Type collecting structural problems:
   *
   *   1. Round-trip encode/parse — catches malformed serialization.
   *   2. Walk the type's full surface (`props()`, `get()`, `call()`,
   *      `init()`) and validate every embedded Expr — method bodies,
   *      getters/setters, indexed-access handlers, init runs.
   *
   * Each embedded Expr is validated with the runtime scope it'll
   * actually see (`this`, `args`, `recurse`, `super`, `key`, `value`)
   * pre-bound, then its inferred type is compared against the slot's
   * declared shape (`Prop.type`, `Call.returns`, `GetSet.value`, etc.)
   * — mismatches surface as warnings.
   *
   * Most slots on built-in types hold a `{kind:'native', id:'…'}`
   * marker, which validates trivially (NativeExpr just checks impl
   * registration). User-supplied bodies on Extensions /
   * `registry.augment(...)` go through the full walker.
   *
   * `engine.validate(programExpr)` does NOT call this — programs
   * are scoped to their own tree. To catch issues in user-supplied
   * type surface, call `type.validate(engine)` directly or
   * `registry.validate(engine)` to sweep every named type +
   * augmentation.
   */
  validate(engine: Engine): Problems {
    const p = new Problems();
    try {
      this.registry.parse(this.toJSON());
    } catch (err) {
      p.error('type.invalid', (err as Error).message);
    }
    validateTypeSurface(this, engine, p);
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
 * Serialize a type's `options` as gin's `{key=value, …}` suffix. Empty
 * / all-undefined options render as the empty string, so primitives
 * without narrowing (`num`, `text`) stay bare.
 *
 * Skips noise that adds no information:
 *   - undefined values
 *   - empty strings (`prefix=""`, `suffix=""`)
 *   - entries equal to the optional `defaults` map (per-type
 *     "uninteresting default" — e.g. `minPrecision=1` on num is rarely
 *     worth surfacing; if equal to the default, don't render it)
 *
 * Values use JSON encoding for strings / null / arrays / objects;
 * numbers and booleans render as literals.
 */
export function optionsCode(
  opts: object | undefined | null,
  defaults?: Record<string, unknown>,
): string {
  if (!opts) return '';
  const entries = Object.entries(opts as Record<string, unknown>).filter(([k, v]) => {
    if (v === undefined) return false;
    if (v === '') return false;
    if (defaults && k in defaults && deepEqual(defaults[k], v)) return false;
    return true;
  });
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
  return `{${joinAuto(parts)}}`;
}

/** Cheap deep-equality for `optionsCode`'s defaults skip. Stable JSON
 *  stringify is good enough — option values are small primitives /
 *  arrays / records, not class instances or functions. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); }
  catch { return false; }
}

// `renderCallTypes` moved to `Call.renderTypes()` instance method
// (see the `Call` class above).
//
// `renderGenerics` moved to `Type.renderGenerics(generic, options?)`
// static method, and `formatParams` to `Type.formatParams(args,
// options?)` static method — both live on the `Type` class above as
// shared rendering helpers for fn signatures and type headers.

/**
 * Delimiter-join with automatic wrapping for long content. Used by
 * every comma- or semicolon-delimited renderer (params, call args,
 * new-list / new-obj literals, call.types alias headers, …) so they
 * stay readable at any depth.
 *
 * Compact form: `a<sep> b<sep> c` — when every item is short and
 * single-line. Default separator is `, ` for comma-lists; pass `'; '`
 * for semicolon-lists (e.g. `call.types` alias headers).
 *
 * Wrapped form: leading `\n`, each item indented by two spaces and
 * followed by `<sep-trim><\n>`, trailing `\n` before the caller's
 * closing delimiter:
 *
 *   `(\n  a: very-long-type,\n  b: another-long-type\n)`
 *
 * Triggers when ANY of:
 *   - an item exceeds `threshold` characters (default 32),
 *   - an item itself contains a newline (already wrapped deeper),
 *   - the compact joined form would exceed `totalThreshold` characters
 *     (default 80) — keeps long-but-numerous arg lists from rendering
 *     as one mega-line just because each item is individually short.
 *     80 leaves headroom for the caller's surrounding delimiters /
 *     indent so finished lines tend to land near a 100-char target.
 * Already-multi-line items get their newlines indented so nesting
 * doesn't lose alignment.
 */
export function joinAuto(
  items: string[],
  opts: { sep?: string; threshold?: number; totalThreshold?: number; indent?: string } = {},
): string {
  if (items.length === 0) return '';
  const sep = opts.sep ?? ', ';
  const threshold = opts.threshold ?? 32;
  const totalThreshold = opts.totalThreshold ?? 80;
  const compact = items.join(sep);
  const wrap = compact.length > totalThreshold
    || items.some((i) => i.length > threshold || i.includes('\n'));
  if (!wrap) return compact;
  // Strip trailing whitespace from the separator so the wrapped form
  // emits e.g. `,\n` (not `, \n`) — newline already does the spacing.
  const wrapSep = sep.replace(/\s+$/, '');
  const indent = opts.indent ?? DEFAULT_INDENT;
  return `\n${items.map((i) => indentBlock(i, indent)).join(`${wrapSep}\n`)}\n`;
}

/**
 * The one-level indent every wrapped / line-oriented render steps in by.
 * Overridable per call through `CodeOptions.indent` — resolved in exactly
 * one place (`indentOf`) so the option cannot be honoured by some
 * renderers and silently ignored by others, which is what it did before.
 */
export const DEFAULT_INDENT = '  ';

/** `CodeOptions.indent`, or {@link DEFAULT_INDENT}. */
export function indentOf(options?: CodeOptions): string {
  return options?.indent ?? DEFAULT_INDENT;
}

/**
 * Indent EVERY line of `text` — the first one included — by `prefix`.
 *
 * Every line, not just the continuations, because **a renderer emits its
 * block anchored at column 0 and its PARENT steps the whole thing in**.
 * That is what makes indentation compose with nesting instead of each
 * renderer hard-coding an absolute column. Before this, `joinAuto`
 * indented continuations by a literal two spaces no matter where the
 * block was spliced in, so a method's wrapped parameters landed at the
 * same column as the method itself and its closing paren landed at
 * column 0 — visible in gin's own `list.reduce` definition.
 */
export function indentBlock(text: string, prefix: string): string {
  return prefix + text.replace(/\n/g, `\n${prefix}`);
}

// ============================================================================
// SURFACE VALIDATION (Type.validate's deep walk)
// ============================================================================

/**
 * Walk a Type's surface — props, get/set, call, init — and validate every
 * embedded ExprDef. Each slot's body is parsed via the registry, then run
 * through `walkValidate` with the runtime scope it'll see at evaluation
 * time (`this`, `args`, `recurse`, `super`, `key`, `value`). Inferred
 * body types are compared against the slot's declared shape; mismatches
 * surface as warnings.
 *
 * Built-in slots usually hold `{kind:'native', id:'…'}` which validates
 * trivially. Real Expr bodies attached via `registry.extend()` /
 * `registry.augment()` get the full walk.
 */
function validateTypeSurface(type: Type, engine: Engine, p: Problems): void {
  const reg = type.registry;
  const ctx = { inLoop: false, inLambda: false } as const;

  // ─── Props (named methods + getters + defaults) ────────────────────────
  const props = type.props();
  for (const [name, raw] of Object.entries(props)) {
    const prop = raw instanceof Prop ? raw : Prop.from(raw);
    p.at(['props', name], () => {
      validateEmbedded(prop.get, propGetScope(prop, type, reg), declaredOf(prop), 'get', engine, p, ctx);
      validateEmbedded(prop.set, propSetScope(prop, type, reg), reg.void(), 'set', engine, p, ctx);
      // Default has no `this` — it builds a fresh value of the prop's type.
      validateEmbedded(prop.default, new Map(), prop.type, 'default', engine, p, ctx);
    });
  }

  // ─── GetSet (indexed-access spec) ──────────────────────────────────────
  const gs = type.get();
  if (gs) {
    p.at('get', () => {
      const baseGetScope = new Map<string, Type>([['this', type], ['key', gs.key]]);
      const baseSetScope = new Map<string, Type>([['this', type], ['key', gs.key], ['value', gs.value]]);
      validateEmbedded(gs.get, baseGetScope, gs.value, 'get', engine, p, ctx);
      validateEmbedded(gs.set, baseSetScope, reg.void(), 'set', engine, p, ctx);
      // Loop body — `key` and `value` are the iteration variables yielded
      // by the loop driver. Validate without an output-type expectation
      // (loop drives via `yield` flow signals; its return type is not
      // directly checked here).
      validateEmbedded(gs.loop, baseGetScope, undefined, 'loop', engine, p, ctx);
    });
  }

  // ─── Call (invocable spec) ─────────────────────────────────────────────
  const call = type.call();
  if (call) {
    p.at('call', () => {
      // call.get is the method body — runs with this/args/recurse bound.
      const callScope = new Map<string, Type>([
        ['this', type],
        ['args', call.args],
        ['recurse', reg.fn({ args: call.args, returns: call.returns ?? reg.any() })],
      ]);
      validateEmbedded(call.get, callScope, call.returns, 'get', engine, p, { ...ctx, inLambda: true });
      const callSetScope = new Map<string, Type>([
        ['this', type], ['args', call.args], ['value', call.returns ?? reg.any()],
        ['recurse', reg.fn({ args: call.args, returns: call.returns ?? reg.any() })],
      ]);
      validateEmbedded(call.set, callSetScope, reg.void(), 'set', engine, p, { ...ctx, inLambda: true });
    });
  }

  // ─── Init (constructor) ────────────────────────────────────────────────
  const init = type.init();
  if (init) {
    p.at('init', () => {
      const initScope = new Map<string, Type>([['this', type], ['args', init.args]]);
      // Init body returns a representation of `this` — most often it
      // mutates in place and returns void/undefined. We don't enforce a
      // specific return shape here.
      validateEmbedded(init.run, initScope, undefined, 'run', engine, p, ctx);
    });
  }

  // ─── Constraint (Extension's runtime invariant) ────────────────────────
  for (const constraint of type.constraints()) {
    p.at('constraint', () => {
      const constraintScope = new Map<string, Type>([['this', type]]);
      const inferred = walkValidate(engine, constraint, constraintScope, p, ctx);
      const boolT = reg.bool();
      if (inferred.name !== 'any' && !boolT.compatible(inferred)) {
        p.warn('type.surface.return-type',
          `constraint must return bool, got '${inferred.name}'`);
      }
    });
  }
}

/** Build the scope for a Prop's `get` slot. Method-typed props see
 *  `args` + `recurse`; plain getters just see `this`. */
function propGetScope(prop: Prop, owner: Type, reg: Registry): Map<string, Type> {
  const m = new Map<string, Type>([['this', owner]]);
  const c = prop.type.call?.();
  if (c) {
    m.set('args', c.args);
    m.set('recurse', reg.fn({ args: c.args, returns: c.returns ?? reg.any() }));
  }
  return m;
}

/** Build the scope for a Prop's `set` slot. Always carries `this` and
 *  the incoming `value`. */
function propSetScope(prop: Prop, owner: Type, _reg: Registry): Map<string, Type> {
  return new Map<string, Type>([['this', owner], ['value', prop.type]]);
}

/** Resolve the declared output type for a Prop's `get` slot. Callable
 *  props (methods) effectively return `call.returns`; plain props
 *  return the prop's declared `type`. */
function declaredOf(prop: Prop): Type | undefined {
  const c = prop.type.call?.();
  if (c) return c.returns;
  return prop.type;
}

/** Validate a single embedded ExprDef. Skips when the slot is empty.
 *  Parses through the registry, runs the validator with the supplied
 *  Locals scope, and (when an `expected` Type is given) warns if the
 *  inferred body type isn't compatible with what the slot declares.
 *
 *  `any` is treated as a universal escape hatch — when the body's
 *  inferred type is `any` (the default for unattributed
 *  `{kind:'native', id:'…'}` markers), trust the slot's declared
 *  return type. The native impl is responsible for producing a value
 *  that matches the declaration; the validator can't see through the
 *  TS function. */
function validateEmbedded(
  expr: ExprDef | undefined,
  scope: Map<string, Type>,
  expected: Type | undefined,
  slot: string,
  engine: Engine,
  p: Problems,
  ctx: { inLoop: boolean; inLambda: boolean },
): void {
  if (!expr) return;
  // Wrap the body's walk under `slot` so problems carry the slot path
  // (`['props', name, 'get', …]` rather than `['props', name, …]`),
  // making them addressable to the type's JSON form via `spanFor`.
  p.at(slot, () => {
    const inferred = walkValidate(engine, expr, scope, p, ctx);
    if (expected && inferred.name !== 'any' && !expected.compatible(inferred)) {
      p.warn('type.surface.return-type',
        `${slot} body returns '${inferred.name}', not compatible with declared '${expected.name}'`);
    }
  });
}

// ============================================================================
// JSON CODE (Type.toJSONCode's structural walk)
// ============================================================================

/**
 * Render a TypeDef as Code with fine-grained spans tied to validator
 * paths. Each known structural slot (`name`, `extends`, `docs`,
 * `options`, `generic`, `props`, `get`, `set`, `call`, `init`,
 * `constraint`, `satisfies`) becomes its own JSON entry whose value
 * is rendered with span(s) aligned to its slot path. Recurses into
 * nested TypeDefs and parses embedded ExprDefs through the registry
 * so `Expr.toJSONCode` produces the inner spans.
 *
 * Used by `Type.toJSONCode` so `formatProblem(typeJsonCode, problem)`
 * can underline precisely inside a type definition the way it does
 * inside an Expr tree.
 */
function renderTypeDefJSONCode(
  def: TypeDef,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
  type: Type | undefined,
): Code {
  const childLevel = level + 1;
  const entries: JSONEntry[] = [];

  if (def.name !== undefined) {
    entries.push({ key: 'name', value: Code.jsonString(def.name) });
  }
  if (def.extends !== undefined) {
    entries.push({ key: 'extends', value: Code.jsonString(def.extends) });
  }
  if (def.satisfies !== undefined && def.satisfies.length > 0) {
    entries.push({
      key: 'satisfies',
      value: rawJSON(def.satisfies, [...path, 'satisfies'], indent, childLevel),
    });
  }
  if (def.docs !== undefined) {
    entries.push({ key: 'docs', value: Code.jsonString(def.docs) });
  }
  if (def.options !== undefined && Object.keys(def.options as object).length > 0) {
    // Options are a free-form per-type record (no embedded Exprs in
    // any built-in's options); render as plain JSON with a span.
    entries.push({
      key: 'options',
      value: rawJSON(def.options, [...path, 'options'], indent, childLevel),
    });
  }
  if (def.generic !== undefined && Object.keys(def.generic).length > 0) {
    entries.push({
      key: 'generic',
      value: renderTypeMapJSON(def.generic, registry, [...path, 'generic'], indent, childLevel),
    });
  }
  if (def.props !== undefined && Object.keys(def.props).length > 0) {
    entries.push({
      key: 'props',
      value: renderPropsMapJSON(def.props, registry, [...path, 'props'], indent, childLevel),
    });
  }
  if (def.get !== undefined) {
    entries.push({
      key: 'get',
      value: renderGetSetJSON(def.get, registry, [...path, 'get'], indent, childLevel),
    });
  }
  if (def.call !== undefined) {
    entries.push({
      key: 'call',
      value: renderCallJSON(def.call, registry, [...path, 'call'], indent, childLevel),
    });
  }
  if (def.init !== undefined) {
    entries.push({
      key: 'init',
      value: renderInitJSON(def.init, registry, [...path, 'init'], indent, childLevel),
    });
  }
  if (def.constraint !== undefined) {
    entries.push({
      key: 'constraint',
      value: renderEmbeddedExprJSON(def.constraint, registry, [...path, 'constraint'], indent, childLevel),
    });
  }

  return Code.jsonObject(entries, { path, type }, level, indent);
}

/** Render `{name: TypeDef, …}` map (used by `generic` and `call.types`). */
function renderTypeMapJSON(
  map: Record<string, TypeDef>,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  const entries: JSONEntry[] = Object.entries(map).map(([name, def]) => ({
    key: name,
    value: renderTypeDefJSONCode(def, registry, [...path, name], indent, level + 1, undefined),
  }));
  return Code.jsonObject(entries, { path }, level, indent);
}

/** Render `{name: PropDef, …}` map under `props`. */
function renderPropsMapJSON(
  props: Record<string, PropDef>,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  const entries: JSONEntry[] = Object.entries(props).map(([name, prop]) => ({
    key: name,
    value: renderPropDefJSON(prop, registry, [...path, name], indent, level + 1),
  }));
  return Code.jsonObject(entries, { path }, level, indent);
}

/** Render a single `PropDef = { docs?, type, get?, set?, default? }`. */
function renderPropDefJSON(
  prop: PropDef,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  const childLevel = level + 1;
  const entries: JSONEntry[] = [];
  if (prop.docs !== undefined) entries.push({ key: 'docs', value: Code.jsonString(prop.docs) });
  entries.push({
    key: 'type',
    value: renderTypeDefJSONCode(prop.type, registry, [...path, 'type'], indent, childLevel, undefined),
  });
  if (prop.get !== undefined) {
    entries.push({
      key: 'get',
      value: renderEmbeddedExprJSON(prop.get, registry, [...path, 'get'], indent, childLevel),
    });
  }
  if (prop.set !== undefined) {
    entries.push({
      key: 'set',
      value: renderEmbeddedExprJSON(prop.set, registry, [...path, 'set'], indent, childLevel),
    });
  }
  if (prop.default !== undefined) {
    entries.push({
      key: 'default',
      value: renderEmbeddedExprJSON(prop.default, registry, [...path, 'default'], indent, childLevel),
    });
  }
  return Code.jsonObject(entries, { path }, level, indent);
}

function renderGetSetJSON(
  gs: GetSetDef,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  const childLevel = level + 1;
  const entries: JSONEntry[] = [];
  if (gs.docs !== undefined) entries.push({ key: 'docs', value: Code.jsonString(gs.docs) });
  entries.push({
    key: 'key',
    value: renderTypeDefJSONCode(gs.key, registry, [...path, 'key'], indent, childLevel, undefined),
  });
  entries.push({
    key: 'value',
    value: renderTypeDefJSONCode(gs.value, registry, [...path, 'value'], indent, childLevel, undefined),
  });
  if (gs.get !== undefined) {
    entries.push({
      key: 'get',
      value: renderEmbeddedExprJSON(gs.get, registry, [...path, 'get'], indent, childLevel),
    });
  }
  if (gs.set !== undefined) {
    entries.push({
      key: 'set',
      value: renderEmbeddedExprJSON(gs.set, registry, [...path, 'set'], indent, childLevel),
    });
  }
  if (gs.loop !== undefined) {
    entries.push({
      key: 'loop',
      value: renderEmbeddedExprJSON(gs.loop, registry, [...path, 'loop'], indent, childLevel),
    });
  }
  if (gs.loopDynamic !== undefined) {
    entries.push({ key: 'loopDynamic', value: String(gs.loopDynamic) });
  }
  return Code.jsonObject(entries, { path }, level, indent);
}

function renderCallJSON(
  call: CallDef,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  const childLevel = level + 1;
  const entries: JSONEntry[] = [];
  if (call.docs !== undefined) entries.push({ key: 'docs', value: Code.jsonString(call.docs) });
  if (call.types !== undefined && Object.keys(call.types).length > 0) {
    entries.push({
      key: 'types',
      value: renderTypeMapJSON(call.types, registry, [...path, 'types'], indent, childLevel),
    });
  }
  entries.push({
    key: 'args',
    value: renderTypeDefJSONCode(call.args, registry, [...path, 'args'], indent, childLevel, undefined),
  });
  if (call.returns !== undefined) {
    entries.push({
      key: 'returns',
      value: renderTypeDefJSONCode(call.returns, registry, [...path, 'returns'], indent, childLevel, undefined),
    });
  }
  if (call.throws !== undefined) {
    entries.push({
      key: 'throws',
      value: renderTypeDefJSONCode(call.throws, registry, [...path, 'throws'], indent, childLevel, undefined),
    });
  }
  if (call.get !== undefined) {
    entries.push({
      key: 'get',
      value: renderEmbeddedExprJSON(call.get, registry, [...path, 'get'], indent, childLevel),
    });
  }
  if (call.set !== undefined) {
    entries.push({
      key: 'set',
      value: renderEmbeddedExprJSON(call.set, registry, [...path, 'set'], indent, childLevel),
    });
  }
  return Code.jsonObject(entries, { path }, level, indent);
}

function renderInitJSON(
  init: NonNullable<TypeDef['init']>,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  const childLevel = level + 1;
  const entries: JSONEntry[] = [];
  if (init.docs !== undefined) entries.push({ key: 'docs', value: Code.jsonString(init.docs) });
  entries.push({
    key: 'args',
    value: renderTypeDefJSONCode(init.args, registry, [...path, 'args'], indent, childLevel, undefined),
  });
  entries.push({
    key: 'run',
    value: renderEmbeddedExprJSON(init.run, registry, [...path, 'run'], indent, childLevel),
  });
  return Code.jsonObject(entries, { path }, level, indent);
}

/** Render an embedded ExprDef. Parses through the registry and
 *  delegates to the parsed Expr's `toJSONCode` so the inner span
 *  structure mirrors what `engine.toJSONCode(expr)` produces at the
 *  top level. Falls back to a plain-JSON span when parse fails (e.g.
 *  malformed kind, unknown class) — better to render something than
 *  to throw mid-render. */
function renderEmbeddedExprJSON(
  expr: ExprDef,
  registry: Registry,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  try {
    const parsed = registry.parseExpr(expr);
    return parsed.toJSONCode(path, indent, level);
  } catch {
    return rawJSON(expr, path, indent, level);
  }
}

/** Render an arbitrary JSON value verbatim (with re-indent for
 *  embedding) wrapped in a single span tagged with `path`. Used for
 *  `options` and other free-form leaf objects. */
function rawJSON(
  value: unknown,
  path: ReadonlyArray<string | number>,
  indent: number,
  level: number,
): Code {
  let text = JSON.stringify(value, null, indent);
  if (level > 0) {
    const lead = ' '.repeat(level * indent);
    text = text.replace(/\n/g, '\n' + lead);
  }
  return spanCode(text, { path });
}
