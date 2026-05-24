import type { ExprDef, TypeDef } from './schema';
import { Call, GetSet, Init, Prop, type PropSpec, Type } from './type';
import { Extension, type ExtensionLocal } from './extension';
import {
  type BoolOptions,
  type ColorOptions,
  type DateOptions,
  type IfaceSpec,
  type ListOptions,
  type NumOptions,
  type ObjPropsInput,
  type TextOptions,
  type TimestampOptions,
  type TypeBuilder,
} from './builder';
import { Expr, type ExprClass } from './expr';
import type { CodeOptions, SchemaOptions } from './node';
import type { Code } from './code';
import type { JSONValue } from './json-type';
import type { Engine } from './engine';
import { Problems } from './problem';
import { Effects } from './effects';
import type { z } from 'zod';

import { AnyType } from './types/any';
import { AndType } from './types/and';
import { AliasType } from './types/alias';
import { BoolType } from './types/bool';
import { ColorType } from './types/color';
import { DateType } from './types/date';
import { DurationType } from './types/duration';
import { EnumType } from './types/enum';
import { FnType } from './types/fn';
import { IfaceType } from './types/iface';
import { LiteralType } from './types/literal';
import { ListType } from './types/list';
import { MapType } from './types/map';
import { NotType } from './types/not';
import { NullType } from './types/null';
import { NullableType } from './types/nullable';
import { NumType } from './types/num';
import { ObjType } from './types/obj';
import { OptionalType } from './types/optional';
import { OrType } from './types/or';
import { TextType } from './types/text';
import { TimestampType } from './types/timestamp';
import { TupleType } from './types/tuple';
import { TypType } from './types/typ';
import { VoidType } from './types/void';
import type { Scope } from './scope';
import type { TypeScope } from './type-scope';
import { Value } from './value';
import { registerBuiltinNatives } from './natives';

/**
 * Type-class constructor — each built-in type exposes this static shape
 * so the registry can dispatch JSON parsing by name.
 *
 * `consumes` lists TypeDef fields beyond the defaults (name, options,
 * generic, docs, satisfies, extends) that this class natively handles
 * as part of its STRUCTURAL definition. Anything OUTSIDE the consumed
 * set (props / get / call / init on a class that doesn't list them)
 * triggers an auto-Extension wrap during parse().
 *
 * Defaults: no custom fields consumed. Overrides:
 *   ObjType    consumes: 'props'                  (obj's fields are its structure)
 *   FnType     consumes: 'call'                   (fn's signature is its structure)
 *   IfaceType  consumes: 'props', 'get', 'call'   (iface's contract is its structure)
 */
export interface TypeClass {
  readonly NAME: string;
  readonly consumes?: readonly CustomField[];
  /** Build a Type from its JSON. `scope` is the type-name resolution
   *  scope (Registry as the root, LocalScope layers above for fn
   *  generics / call.types aliases). Use `scope.registry` to access
   *  the underlying Registry for child-type construction; use
   *  `scope.parse` (i.e. `scope.registry.parse(child, scope)`) to
   *  recursively parse children with the same scope. */
  from(json: TypeDef, scope: TypeScope): Type;
  /** JSON-shape Zod schema for this Type's TypeDef. */
  toSchema(opts: SchemaOptions): z.ZodTypeAny;
  /**
   * CLASS-level value schema used by `NewExpr.toSchema` strict mode when
   * the LLM references this type's class (e.g. `{name:'num'}` or
   * `{name:'list', generic: {...}}`). Represents the most-permissive
   * value shape for ANY instance of the class:
   *  - Primitives emit their concrete Zod (num → number, text → string).
   *  - Composites emit `opts.Expr`-based shapes (list → `Expr[]`, map →
   *    `{key:Expr, value:Expr}[]`, obj → `Record<string, Expr>`).
   * Instance-specific tightenings (num with min/max, obj with declared
   * fields) go through a named-instance branch instead.
   */
  toNewSchema(opts: SchemaOptions): z.ZodTypeAny;
}

/** TypeDef fields that, unless `consumes`-d by the class, force Extension. */
export type CustomField = 'props' | 'get' | 'call' | 'init';
const ALL_CUSTOM_FIELDS: readonly CustomField[] = ['props', 'get', 'call', 'init'];

/** Native implementation — the actual JS function that runs a native op.
 *  Receives the current runtime scope plus the registry for convenient
 *  access to built-in types when wrapping a returned raw back into a
 *  Value. */
export type NativeImpl = (scope: Scope, registry: Registry) => Value | unknown | Promise<Value | unknown>;

/**
 * Registry — central authority for the gin type system.
 *
 *  1. Map `name → Type class` for built-in JSON parse dispatch.
 *  2. Map `name → Type instance` for user-registered named types
 *     (typically Extensions), enabling ref() lookup and parse() resolution.
 *  3. Map `id → NativeImpl` for native op defaults and overrides.
 *  4. Implements TypeBuilder — the factory everyone uses to construct Types.
 *
 * No per-type inspection lives here. parse() dispatches by name, delegates
 * to each class's static `from` method, and recurses through nested types
 * via the same entry point.
 */
/**
 * Augmentations a developer can attach to a Type by name (e.g. 'num',
 * 'text', 'Email'). Stored on the Registry; consulted by every Type's
 * `props()` / `get()` / `call()` / `init()` so the additions are
 * visible at runtime path-walks, in static analysis, and in code
 * rendering — without subclassing or wrapping the type in an
 * Extension.
 *
 * Composition rules:
 *   - `props`: ADDED to the type's intrinsic props. Intrinsic names
 *     win on conflict (you can't replace `num.add` via augmentation).
 *     Use this to introduce NEW methods / fields.
 *   - `get` / `call` / `init`: applied IFF the type has none of its
 *     own. Augmentation can introduce a missing surface (e.g. give
 *     `date` a `get/loop`, make `timestamp` callable, give `text` an
 *     init constructor) but does not override one the type already
 *     declares.
 *
 * Augmentations are accumulated — multiple calls to `registry.augment`
 * for the same name MERGE props. The first `get`/`call`/`init` that's
 * defined wins (subsequent attempts to set the same field are no-ops).
 */
export interface TypeAugmentation {
  props?: Record<string, Prop | PropSpec>;
  get?: GetSet;
  call?: Call;
  init?: Init;
}

export class Registry implements TypeBuilder, TypeScope {
  private readonly classes = new Map<string, TypeClass>();
  private readonly namedTypes = new Map<string, Type>();
  private readonly natives = new Map<string, NativeImpl>();
  private readonly nativeEffectsMap = new Map<string, Effects>();
  private readonly exprClasses = new Map<string, ExprClass>();
  private readonly augments = new Map<string, TypeAugmentation>();

  // ─── SCOPE INTERFACE ─────────────────────────────────────────────────────
  /** Registry IS the root scope. */
  readonly parent: undefined = undefined;
  get registry(): Registry { return this; }

  // ─── CLASS REGISTRATION ──────────────────────────────────────────────────

  /** Register a built-in Type class for JSON parse dispatch. */
  define(cls: TypeClass): this {
    this.classes.set(cls.NAME, cls);
    return this;
  }

  /** Register a named Type instance (typically an Extension). */
  register(type: Type): this {
    this.namedTypes.set(type.name, type);
    return this;
  }

  /**
   * Add methods / get / call / init to an existing type by name —
   * works for both built-in classes (`'num'`, `'text'`, `'date'`,
   * `'timestamp'`, ...) and named instances / Extensions you've
   * registered. Repeated calls for the same name MERGE: props are
   * accumulated, while get/call/init keep their first non-undefined
   * value (subsequent attempts to redefine those are silently
   * ignored — augmentations fill gaps, they don't override).
   *
   * Example — give `date` a `get/loop` so you can iterate over a
   * range, and make `timestamp` callable as a fn:
   * ```ts
   *   registry.augment('date', { get: new GetSet({ key: registry.num(), value: registry.date(), loop: ... }) });
   *   registry.augment('timestamp', { call: new Call({ args: ..., returns: ... }) });
   * ```
   *
   * Augmented surface flows through every consumer: path-walker
   * dispatches against augmented `props` / `get` / `call`,
   * `validateWalk` static analysis sees them, `toCodeDefinition`
   * renders them in the type's surface block.
   */
  augment(name: string, addition: TypeAugmentation): this {
    // Normalize each field through the class `.from()` factories so
    // loosely-typed callers passing ExprDef literals in get/set/loop/run
    // end up with parsed Exprs in storage. Idempotent for
    // already-canonical instances.
    const normalized: TypeAugmentation = {
      props: addition.props ? Prop.fromMap(addition.props, this) : undefined,
      get: addition.get ? GetSet.from(addition.get, this) : undefined,
      call: addition.call ? Call.from(addition.call, this) : undefined,
      init: addition.init ? Init.from(addition.init, this) : undefined,
    };

    const cur = this.augments.get(name);
    if (!cur) {
      this.augments.set(name, {
        props: normalized.props ? { ...normalized.props } : undefined,
        get: normalized.get,
        call: normalized.call,
        init: normalized.init,
      });
      return this;
    }
    // Merge into the existing augmentation. Props additive (new wins
    // on per-name conflict within augmentation itself, but intrinsic
    // type props still win at consumption time). get/call/init are
    // first-wins — once set, further attempts no-op.
    this.augments.set(name, {
      props: normalized.props ? { ...(cur.props ?? {}), ...normalized.props } : cur.props,
      get: cur.get ?? normalized.get,
      call: cur.call ?? normalized.call,
      init: cur.init ?? normalized.init,
    });
    return this;
  }

  /** Read the registered augmentation for a type-by-name. Returns
   *  undefined when nothing has been augmented. Used by `Type.props`
   *  / `Type.get` / `Type.call` / `Type.init` to overlay additions. */
  augmentation(name: string): TypeAugmentation | undefined {
    return this.augments.get(name);
  }

  /** Look up a Type by name. Registered named instances win; falls back
   *  to built-in classes (synthesized canonical instance). Returns
   *  undefined for unknown names. Implements `TypeScope.lookup`. */
  lookup(name: string): Type | undefined {
    if (this.namedTypes.has(name)) return this.namedTypes.get(name);
    const cls = this.classes.get(name);
    if (cls) return cls.from({ name }, this);
    return undefined;
  }

  /** Registry has no "local-above-root" layer. See TypeScope.localLookup. */
  localLookup(_name: string): Type | undefined {
    return undefined;
  }

  // ─── NATIVES ─────────────────────────────────────────────────────────────

  /**
   * Register a native implementation by id, with its declared effects.
   *
   * `effects` defaults to the maximally conservative `STATE|SYSTEM|EXTERNAL`
   * because an unregistered or under-declared native is assumed worst-case
   * — better to false-positive a no-effect warning than to miss a real
   * side effect at static analysis time. Built-in pure natives (`num.add`,
   * `bool.eq`, list/map/text accessors, etc.) MUST opt in to `Effects.NONE`
   * so they don't contaminate the effect propagation in user code.
   */
  setNative(
    id: string,
    impl: NativeImpl,
    effects: Effects = Effects.STATE | Effects.SYSTEM | Effects.EXTERNAL,
  ): this {
    this.natives.set(id, impl);
    this.nativeEffectsMap.set(id, effects);
    return this;
  }

  getNative(id: string): NativeImpl | undefined {
    return this.natives.get(id);
  }

  /**
   * Effects declared at `setNative(id, impl, effects)` time. Falls back to
   * the same conservative default `setNative` uses when no entry exists
   * — keeps `NativeExpr.effects()` truthy for any unregistered id rather
   * than silently treating it as pure.
   */
  nativeEffects(id: string): Effects {
    const e = this.nativeEffectsMap.get(id);
    if (e !== undefined) return e;
    return Effects.STATE | Effects.SYSTEM | Effects.EXTERNAL;
  }

  // ─── EXPR CLASSES ────────────────────────────────────────────────────────

  /** Register an Expr class (one per ExprDef.kind). */
  defineExpr(cls: ExprClass): this {
    this.exprClasses.set(cls.KIND, cls);
    return this;
  }

  /** Look up the Expr class for a given kind. */
  exprClass(kind: string): ExprClass | undefined {
    return this.exprClasses.get(kind);
  }

  /** Enumerate every registered Type class (used by schema builders). */
  typeClasses(): TypeClass[] {
    return Array.from(this.classes.values());
  }

  /** Enumerate every programmatically-registered named Type instance
   *  (typically Extensions created via `registry.register(ext)`). Used by
   *  `buildSchemas` so named user types appear as first-class branches in
   *  the Type union the LLM sees. */
  namedTypeList(): Type[] {
    return Array.from(this.namedTypes.values());
  }

  /** Enumerate every registered Expr class (used by schema builders). */
  exprClassList(): ExprClass[] {
    return Array.from(this.exprClasses.values());
  }

  /**
   * Parse anything Expr-shaped into an `Expr` instance — overloaded for
   * three input families:
   *
   *   1. `Expr` instance → returned as-is (idempotent passthrough).
   *   2. `ExprDef` JSON → dispatched to the matching Expr class's
   *      `from(def, scope)`. Throws on unknown kinds or malformed
   *      shapes.
   *   3. `null` / `undefined` → returned as `undefined`. Lets callers
   *      pass through optional fields (e.g. `Prop.get`) without
   *      ceremony — no need to guard the call site or wrap with a
   *      `parseExprMaybe`-style helper.
   *
   * Optional `scope` is a `TypeScope` (defaults to the registry itself)
   * threaded through Expr.from so nested TypeDefs / ExprDefs (`new`,
   * `lambda`, `native`, `define`) resolve against the right alias /
   * generic bindings.
   *
   * Anything that's not Expr / ExprDef / null / undefined throws — bad
   * shape is a programmer error, not silently absorbed.
   */
  parseExpr(json: Expr, scope?: TypeScope): Expr;
  parseExpr(json: ExprDef, scope?: TypeScope): Expr;
  parseExpr(json: null | undefined, scope?: TypeScope): undefined;
  parseExpr(json: Expr | ExprDef | null | undefined, scope?: TypeScope): Expr | undefined;
  parseExpr(json: unknown, scope: TypeScope = this): Expr | undefined {
    if (json === null || json === undefined) return undefined;
    if (json instanceof Expr) return json;
    if (typeof json !== 'object' || !('kind' in (json as object))) {
      throw new Error(`registry.parseExpr: expected ExprDef with kind, got ${typeof json}`);
    }
    const def = json as ExprDef;
    const cls = this.exprClasses.get(def.kind);
    if (!cls) throw new Error(`registry.parseExpr: unknown expr kind '${def.kind}'`);
    return cls.from(def, scope);
  }

  /**
   * Render an ExprDef (or parsed Expr) as TypeScript-like source text.
   * Parses JSON lazily, then dispatches to the Expr instance's toCode().
   */
  toCode(expr: ExprDef | Expr, options?: CodeOptions): string {
    const e = expr instanceof Expr ? expr : this.parseExpr(expr);
    return e.toCode(this, options);
  }

  /**
   * Render an ExprDef (or parsed Expr) as gin's TS-pseudocode form
   * with span annotations. The result's `Code` carries spans that
   * line up with `Problem.path` from `engine.validate(...)`, so a
   * caller can pass both into `formatProblem` / `formatProblems` to
   * produce compiler-style `^^^` underlines.
   */
  toGinCode(expr: ExprDef | Expr, options?: CodeOptions): Code {
    const e = expr instanceof Expr ? expr : this.parseExpr(expr);
    return e.toGinCode(this, options, []);
  }

  /**
   * Render an ExprDef (or parsed Expr) as the JSON form (same shape
   * as `JSON.stringify(expr.toJSON(), null, 2)`) with spans on each
   * structural slot. Used by ginny's `write` tool to surface
   * validation pointers in the JSON the LLM actually emitted.
   */
  toJSONCode(expr: ExprDef | Expr, indent: number = 2): Code {
    const e = expr instanceof Expr ? expr : this.parseExpr(expr);
    return e.toJSONCode([], indent);
  }

  /**
   * Validate every user-supplied piece of type surface attached to this
   * registry — every named type (registered via `register(...)` /
   * `extend(...)`) AND every augmented built-in (registered via
   * `augment(name, ...)`). Each type's full surface (props / get / call
   * / init) is walked; embedded ExprDefs are parsed and validated with
   * the runtime scope they'll see (`this` / `args` / `recurse` / etc.).
   *
   * Returns a single `Problems` bag with paths prefixed by the type's
   * name. Run as a sweep step after registering custom types — surface
   * issues at registration time rather than at runtime when the method
   * is first called.
   *
   * Programs validated via `engine.validate(programExpr)` do NOT
   * trigger this sweep; the two passes are intentionally separate so a
   * program walk doesn't redo work for every type it touches.
   */
  validate(engine: Engine): Problems {
    const out = new Problems();
    const seen = new Set<string>();
    const visit = (typeName: string, type: Type): void => {
      if (seen.has(typeName)) return;
      seen.add(typeName);
      const sub = type.validate(engine);
      for (const prob of sub.list) {
        out.list.push({ ...prob, path: [typeName, ...prob.path] });
      }
    };
    // Registered named types (Extensions and explicit `register(...)`).
    for (const [name, type] of this.namedTypes) visit(name, type);
    // Built-ins that have been augmented in place. Build a canonical
    // instance via `lookup` so the surface walker sees the same
    // type object the runtime would dispatch against.
    for (const name of this.augments.keys()) {
      const t = this.lookup(name);
      if (t) visit(name, t);
    }
    return out;
  }

  // ─── JSON PARSE ──────────────────────────────────────────────────────────

  /**
   * Reconstruct a `Value` from its `JSONValue` envelope. Symmetric inverse
   * of `Value.toJSON()` — decode the TypeDef via `parse`, then ask that
   * Type to parse the dumped value.
   */
  parseValue<T = any>(json: unknown, expectedType?: Type, scope: TypeScope = this): Value<T> {
    if (json instanceof Value) {
      return json;
    }
    if (json && typeof json === 'object' && 'type' in json && 'value' in json) {
      return this.parse(json.type, scope).parse(json.value, scope);
    }
    if (!expectedType) {
      throw new TypeError(`registry.parseValue: expected Value or JSONValue, got ${typeof json}`);
    }
    return expectedType.parse(json, scope);
  }

  parse(json: unknown, scope: TypeScope = this): Type {
    if (!json || typeof json !== 'object') {
      throw new Error(`registry.parse: expected object, got ${typeof json}`);
    }
    const def = json as TypeDef;
    // Type names must be \w+ (letters, digits, underscore — no
    // whitespace, no punctuation). LLM-emitted TypeDefs sometimes
    // arrive with leading whitespace or other junk in the name; the
    // downstream "claims to satisfy X but does not structurally
    // match" error is baffling because the offending whitespace is
    // invisible. Reject explicitly here with a precise pointer.
    if (typeof def.name !== 'string' || !/^\w+$/.test(def.name)) {
      throw new Error(`registry.parse: type 'name' must match /^\\w+$/, got ${JSON.stringify(def.name)}`);
    }
    if (def.extends !== undefined && (typeof def.extends !== 'string' || !/^\w+$/.test(def.extends))) {
      throw new Error(`registry.parse: type 'extends' must match /^\\w+$/, got ${JSON.stringify(def.extends)}`);
    }
    if (def.satisfies) {
      for (const ifaceName of def.satisfies) {
        if (typeof ifaceName !== 'string' || !/^\w+$/.test(ifaceName)) {
          throw new Error(`registry.parse: 'satisfies' entries must match /^\\w+$/, got ${JSON.stringify(ifaceName)}`);
        }
      }
    }

    const result = this.parseInner(def, scope);

    // `satisfies` claims: verify each against the named interface.
    if (def.satisfies && def.satisfies.length > 0) {
      for (const ifaceName of def.satisfies) {
        const iface = scope.lookup(ifaceName) ?? this.lookup(ifaceName);
        if (!iface) {
          throw new Error(`registry.parse: satisfies references unknown interface '${ifaceName}'`);
        }
        if (!iface.compatible(result)) {
          throw new Error(`registry.parse: type '${def.name}' claims to satisfy '${ifaceName}' but does not structurally match`);
        }
      }
    }

    return result;
  }

  /** True if `def` is a bare-name shape: only `name` (and optionally
   *  `docs`), no structural peers. Bare-name defs route through scope
   *  lookup → AliasType / registered named type / canonical class. */
  private isBareNameDef(def: TypeDef): boolean {
    const peers: ReadonlyArray<keyof TypeDef> = [
      'extends', 'satisfies', 'generic', 'options',
      'init', 'props', 'get', 'call', 'constraint',
    ];
    for (const k of peers) {
      if ((def as unknown as Record<string, unknown>)[k] !== undefined) return false;
    }
    return true;
  }

  private parseInner(def: TypeDef, scope: TypeScope): Type {
    // `extends` indirection: build the base from the referenced name, wrap
    // in Extension with local additions/narrowings.
    if (def.extends) {
      const base = scope.lookup(def.extends) ?? this.lookup(def.extends);
      if (!base) throw new Error(`registry.parse: extends references unknown type '${def.extends}'`);
      return new Extension(this, base, this.buildLocal(def, scope));
    }

    // Bare-name shape: dispatch via scope chain.
    if (this.isBareNameDef(def)) {
      // Walk above-registry layers — if the name is bound LOCALLY in
      // any LocalScope (generic placeholder, call.types alias), wrap in
      // AliasType so substitute / scope resolution works correctly.
      let s: TypeScope | undefined = scope;
      while (s && s !== this) {
        if (s.localLookup(def.name) !== undefined) {
          return new AliasType(scope, { name: def.name });
        }
        s = s.parent;
      }
      // Registered named type — return directly (preserves instanceof).
      if (this.namedTypes.has(def.name)) return this.namedTypes.get(def.name)!;
      // Built-in class — dispatch eagerly to canonical instance.
      const cls = this.classes.get(def.name);
      if (cls) return cls.from(def, scope);
      // Unknown name — AliasType (lazy; supports forward-refs to types
      // registered later, e.g. self-referential `r.alias('Node')` during
      // construction of Node).
      return new AliasType(scope, { name: def.name });
    }

    // Previously-registered named type (Extension or programmatically defined).
    if (this.namedTypes.has(def.name)) return this.namedTypes.get(def.name)!;

    const cls = this.classes.get(def.name);
    if (!cls) throw new Error(`registry.parse: unknown type '${def.name}'`);

    // Auto-Extension: if the TypeDef has customization fields the class
    // doesn't natively consume, build the base from the structural fields
    // and wrap in Extension with the leftover custom fields.
    const consumed = new Set<CustomField>(cls.consumes ?? []);
    const leftover = ALL_CUSTOM_FIELDS.filter((f) => def[f] !== undefined && !consumed.has(f));

    if (leftover.length === 0) return cls.from(def, scope);

    const stripped: TypeDef = { ...def };
    for (const f of leftover) delete stripped[f];
    const base = cls.from(stripped, scope);

    const local: ExtensionLocal = {
      name: def.name,
      docs: def.docs,
      props: leftover.includes('props') && def.props ? Prop.fromMap(def.props, scope) : undefined,
      get: leftover.includes('get') && def.get ? GetSet.from(def.get, scope) : undefined,
      call: leftover.includes('call') && def.call ? Call.from(def.call, scope) : undefined,
      init: leftover.includes('init') && def.init ? Init.from(def.init, scope) : undefined,
    };
    return new Extension(this, base, local);
  }

  /**
   * Enumerate every registered type (class defaults + named instances)
   * that structurally satisfies the given interface by name. Useful for
   * "find all types that implement Comparable" style queries.
   */
  getTypesFor(ifaceName: string): Type[] {
    const iface = this.lookup(ifaceName);
    if (!iface) return [];
    const out: Type[] = [];

    for (const t of this.namedTypes.values()) {
      if (t === iface) continue;
      try {
        if (iface.compatible(t)) out.push(t);
      } catch {
        // lazy proxies (alias) may throw during compat — skip.
      }
    }

    for (const [name, cls] of this.classes) {
      if (name === ifaceName) continue;
      let t: Type;
      try {
        t = cls.from({ name }, this);
      } catch {
        continue;
      }
      try {
        if (iface.compatible(t)) out.push(t);
      } catch {
        // skip proxies that can't resolve
      }
    }

    return out;
  }

  /** Decode all customization fields from a TypeDef into an ExtensionLocal. */
  private buildLocal(def: TypeDef, scope: TypeScope): ExtensionLocal {
    const generic = def.generic
      ? Object.fromEntries(
          Object.entries(def.generic).map(([k, v]) => [k, this.parse(v, scope)]),
        )
      : undefined;
    return {
      name: def.name,
      docs: def.docs,
      options: def.options,
      generic,
      props: def.props ? Prop.fromMap(def.props, scope) : undefined,
      get: def.get ? GetSet.from(def.get, scope) : undefined,
      call: def.call ? Call.from(def.call, scope) : undefined,
      init: def.init ? Init.from(def.init, scope) : undefined,
      constraint: def.constraint ? this.parseExpr(def.constraint, scope) : undefined,
    };
  }

  // ─── TYPE BUILDER IMPL ───────────────────────────────────────────────────

  any()  { return new AnyType(this, {}); }
  void() { return new VoidType(this, {}); }
  null() { return new NullType(this, {}); }

  bool(options?: BoolOptions) { return new BoolType(this, options ?? {}); }
  num(options?: NumOptions)   { return new NumType(this, options ?? {}); }
  text(options?: TextOptions) { return new TextType(this, options ?? {}); }

  list<V>(item: Type<V>, options?: ListOptions) {
    return new ListType<V>(this, item, options ?? {});
  }
  map<K, V>(key: Type<K>, value: Type<V>) {
    return new MapType<K, V>(this, key, value);
  }
  tuple<T extends any[]>(elements: { [I in keyof T]: Type<T[I]> }) {
    return new TupleType(this, elements as unknown as Type[]) as unknown as Type<T>;
  }
  obj<T extends object = Record<string, any>>(props: ObjPropsInput): Type<T> {
    return new ObjType<T>(this, props);
  }

  optional<T>(inner: Type<T>) { return new OptionalType<T>(this, inner); }
  nullable<T>(inner: Type<T>) { return new NullableType<T>(this, inner); }
  not(excluded: Type)         { return new NotType(this, excluded); }

  or(variants: Type[])        { return new OrType(this, variants); }
  and(parts: Type[])          { return new AndType(this, parts); }

  enum<V>(values: Record<string, V>, value: Type<V>) {
    return new EnumType<V>(this, value, { values });
  }

  literal<T>(inner: Type<T>, value: T) {
    return new LiteralType<T>(this, inner, value);
  }

  date(options?: DateOptions)           { return new DateType(this, options ?? {}); }
  timestamp(options?: TimestampOptions) { return new TimestampType(this, options ?? {}); }
  duration()                            { return new DurationType(this, {}); }

  color(options?: ColorOptions) { return new ColorType(this, options ?? {}); }

  fn<A extends object = any, R = any, E = any>(opts: {
    args: Type<A>;
    returns?: Type<R>;
    throws?: Type<E>;
    /** Generic declarations local to this fn. Each entry's value is
     *  the binding constraint that call-site bindings must satisfy. */
    generic?: Record<string, Type>;
    /** Optional pre-parsed `call.get` body. Use for fn types whose
     *  invocation dispatches to a known native — the Expr's effects
     *  flow up to `Call.effects()` and then into `GetExpr.effects()`
     *  via `Path.validateWalk`'s cache, so callers see the call as
     *  EXTERNAL / SYSTEM / etc. automatically. */
    call?: Expr;
  }) {
    return new FnType(
      this,
      { args: opts.args, returns: opts.returns, throws: opts.throws, get: opts.call },
      opts.generic ?? {},
    );
  }

  iface(spec: IfaceSpec) {
    return new IfaceType(this, {
      props: spec.props ? Prop.fromMap(spec.props, this) : {},
      get: spec.get ? GetSet.from(spec.get, this) : undefined,
      call: spec.call ? Call.from(spec.call, this) : undefined,
    });
  }


  /** Bare-name reference / generic-parameter placeholder.
   *  JSON form is `{name: 'X'}` — interpretation depends on scope:
   *  resolves to a registered named type, a built-in class instance, a
   *  generic placeholder bound on the enclosing fn, or a `call.types`
   *  alias. Call-site specialization (e.g. path-step `<R: num>`)
   *  passes an extra `TypeScope` at access time; AliasType.resolve
   *  consults it before its captured scope. No type-tree rebuild. */
  alias(name: string) { return new AliasType(this, { name }); }

  typ<T = any>(constraint: Type<T>): TypType<T> {
    return new TypType<T>(this, constraint);
  }

  // ─── COMPATIBILITY QUERIES ──────────────────────────────────────────────

  /**
   * Every Type known to the registry (native classes + named Extensions)
   * whose `.compatible(t)` returns true. Class-level types are probed via
   * a canonical instance built from `cls.from({name})` — classes whose
   * `from` throws without options are skipped.
   *
   * Deduplicated by name.
   */
  compatible(t: Type): Type[] {
    const out: Type[] = [];
    const seen = new Set<string>();
    const push = (x: Type) => {
      if (seen.has(x.name)) return;
      seen.add(x.name);
      out.push(x);
    };

    // Native classes. A class's canonical form (from `{name}` alone) may
    // be "universal" — i.e. its `.compatible(x)` is trivially true for
    // almost any x (see Type.isUniversal). Those pollute the match set and
    // only participate when the query IS for this class by name.
    for (const cls of this.typeClasses()) {
      let canonical: Type;
      try {
        canonical = cls.from({ name: cls.NAME } as TypeDef, this);
      } catch {
        continue;
      }
      if (canonical.isUniversal() && t.name !== cls.NAME) continue;
      try {
        if (canonical.compatible(t)) push(canonical);
      } catch {
        continue;
      }
    }

    // Named types (Extensions, programmatically registered).
    for (const named of this.namedTypeList()) {
      try {
        if (named.compatible(t)) push(named);
      } catch {
        continue;
      }
    }

    return out;
  }

  /**
   * Or-wrap of `compatible(t)`, with each match narrowed by `.like(t)` so
   * container classes recurse through their inner types. Zero matches →
   * `null` type; one match → that type; many → `or<...>`.
   */
  like(t: Type): Type {
    const narrowed = this.compatible(t).map((m) => m.like(t));
    if (narrowed.length === 0) return this.null();
    if (narrowed.length === 1) return narrowed[0]!;
    return this.or(narrowed);
  }

  extend<T, O>(base: Type<T> | string, local: ExtensionLocal<T, O>): Extension<T, O> {
    const baseType = typeof base === 'string'
      ? this.lookup(base) ?? (() => { throw new Error(`extend: unknown base '${base}'`); })()
      : base;
    return new Extension<T, O>(this, baseType as Type<T>, local);
  }

  // ─── PROP BUILDERS ───────────────────────────────────────────────────────

  /**
   * Convenience for `Type` subclasses building `Prop` / `GetSet` /
   * `Call` / `Init` specs that point at a built-in native. Returns a
   * parsed `NativeExpr` referencing `id` so the surrounding spec field
   * can hold a parsed `Expr` (per the runtime-stores-Expr rule)
   * without the caller writing `this.parseExpr({kind:'native', id})`
   * themselves.
   */
  nativeExpr(id: string): Expr {
    return this.parseExpr({ kind: 'native', id });
  }

  prop(type: Type, nativeId: string, docs?: string): Prop {
    return new Prop({ type, get: this.nativeExpr(nativeId), docs });
  }

  method<A extends Record<string, Type>>(
    args: A,
    returns: Type,
    nativeId: string,
    options?: { docs?: string; generic?: Record<string, Type> },
  ): Prop {
    const argFields: ObjPropsInput = {};
    for (const [k, t] of Object.entries(args)) argFields[k] = { type: t };
    return new Prop({
      type: this.fn({ args: this.obj(argFields), returns, generic: options?.generic }),
      get: this.nativeExpr(nativeId),
      docs: options?.docs,
    });
  }
}

// ─── BUILT-IN REGISTRATION ────────────────────────────────────────────────

/** All built-in Type classes, in a stable order for tests / docs. */
export const BUILTIN_TYPES: TypeClass[] = [
  AnyType,
  VoidType,
  NullType,
  BoolType,
  NumType,
  TextType,
  ListType,
  MapType,
  TupleType,
  ObjType,
  OptionalType,
  NullableType,
  NotType,
  OrType,
  AndType,
  EnumType,
  LiteralType,
  FnType,
  IfaceType,
  TypType,
  DateType,
  TimestampType,
  DurationType,
  ColorType,
];

/** All built-in Expr classes, one per ExprDef.kind. */
import { NewExpr } from './exprs/new';
import { GetExpr } from './exprs/get';
import { SetExpr } from './exprs/set';
import { DefineExpr } from './exprs/define';
import { BlockExpr } from './exprs/block';
import { IfExpr } from './exprs/if';
import { SwitchExpr } from './exprs/switch';
import { LoopExpr } from './exprs/loop';
import { LambdaExpr } from './exprs/lambda';
import { TemplateExpr } from './exprs/template';
import { FlowExpr } from './exprs/flow';
import { NativeExpr } from './exprs/native';

export const BUILTIN_EXPRS: ExprClass[] = [
  NewExpr, GetExpr, SetExpr, DefineExpr, BlockExpr,
  IfExpr, SwitchExpr, LoopExpr, LambdaExpr, TemplateExpr,
  FlowExpr, NativeExpr,
];

/** Create a Registry pre-populated with all built-in Type classes, native
 *  implementations, and Expr classes. */
export function createRegistry(): Registry {
  const r = new Registry();
  for (const cls of BUILTIN_TYPES) r.define(cls);
  for (const cls of BUILTIN_EXPRS) r.defineExpr(cls);
  registerBuiltinNatives(r);
  return r;
}
