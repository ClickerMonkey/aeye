import type { ExprDef, TypeDef } from './schema';
import { Prop, Type } from './type';
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
import { decodeCall, decodeGetSet, decodeInit, decodeProps } from './spec';
import { Expr, type ExprClass } from './expr';
import type { CodeOptions, SchemaOptions } from './node';
import type { JSONValue } from './json-type';
import type { z } from 'zod';

import { AnyType } from './types/any';
import { AndType } from './types/and';
import { BoolType } from './types/bool';
import { ColorType } from './types/color';
import { DateType } from './types/date';
import { DurationType } from './types/duration';
import { EnumType } from './types/enum';
import { FnType } from './types/fn';
import { GenericType } from './types/generic';
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
import { RefType } from './types/ref';
import { TextType } from './types/text';
import { TimestampType } from './types/timestamp';
import { TupleType } from './types/tuple';
import { VoidType } from './types/void';
import type { Scope } from './scope';
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
  from(json: TypeDef, registry: Registry): Type;
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
 *  Receives the current scope plus the registry for convenient access to
 *  built-in types when wrapping a returned raw back into a Value. */
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
export class Registry implements TypeBuilder {
  private readonly classes = new Map<string, TypeClass>();
  private readonly namedTypes = new Map<string, Type>();
  private readonly natives = new Map<string, NativeImpl>();
  private readonly exprClasses = new Map<string, ExprClass>();

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

  /** Look up a named Type by name. Registered instances win over defaults. */
  lookup(name: string): Type | undefined {
    if (this.namedTypes.has(name)) return this.namedTypes.get(name);
    const cls = this.classes.get(name);
    if (cls) return cls.from({ name }, this);
    return undefined;
  }

  // ─── NATIVES ─────────────────────────────────────────────────────────────

  setNative(id: string, impl: NativeImpl): this {
    this.natives.set(id, impl);
    return this;
  }

  getNative(id: string): NativeImpl | undefined {
    return this.natives.get(id);
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

  /** Parse an ExprDef (or already-parsed Expr) into an Expr instance. */
  parseExpr(json: unknown): Expr {
    if (json instanceof Expr) return json;
    if (!json || typeof json !== 'object' || !('kind' in (json as object))) {
      throw new Error(`registry.parseExpr: expected ExprDef with kind, got ${typeof json}`);
    }
    const def = json as ExprDef;
    const cls = this.exprClasses.get(def.kind);
    if (!cls) throw new Error(`registry.parseExpr: unknown expr kind '${def.kind}'`);
    return cls.from(def, this);
  }

  /**
   * Render an ExprDef (or parsed Expr) as TypeScript-like source text.
   * Parses JSON lazily, then dispatches to the Expr instance's toCode().
   */
  toCode(expr: ExprDef | Expr, options?: CodeOptions): string {
    const e = expr instanceof Expr ? expr : this.parseExpr(expr);
    return e.toCode(this, options);
  }

  // ─── JSON PARSE ──────────────────────────────────────────────────────────

  /**
   * Reconstruct a `Value` from its `JSONValue` envelope. Symmetric inverse
   * of `Value.toJSON()` — decode the TypeDef via `parse`, then ask that
   * Type to parse the dumped value.
   */
  parseValue<T = any>(json: unknown, expectedType?: Type): Value<T> {
    if (json instanceof Value) {
      return json;
    }
    if (json && typeof json === 'object' && 'type' in json && 'value' in json) {
      return this.parse(json.type).parse(json.value);
    }
    if (!expectedType) {
      throw new TypeError(`registry.parseValue: expected Value or JSONValue, got ${typeof json}`);
    }
    return expectedType.parse(json);
  }

  parse(json: unknown): Type {
    if (!json || typeof json !== 'object') {
      throw new Error(`registry.parse: expected object, got ${typeof json}`);
    }
    const def = json as TypeDef;
    const result = this.parseInner(def);

    // `satisfies` claims: verify each against the named interface.
    if (def.satisfies && def.satisfies.length > 0) {
      for (const ifaceName of def.satisfies) {
        const iface = this.lookup(ifaceName);
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

  private parseInner(def: TypeDef): Type {
    // `extends` indirection: build the base from the referenced name, wrap
    // in Extension with local additions/narrowings.
    if (def.extends) {
      const base = this.lookup(def.extends);
      if (!base) throw new Error(`registry.parse: extends references unknown type '${def.extends}'`);
      return new Extension(this, base, this.buildLocal(def));
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

    if (leftover.length === 0) return cls.from(def, this);

    const stripped: TypeDef = { ...def };
    for (const f of leftover) delete stripped[f];
    const base = cls.from(stripped, this);

    const local: ExtensionLocal = {
      name: def.name,
      docs: def.docs,
      props: leftover.includes('props') && def.props ? decodeProps(def.props, this) : undefined,
      get: leftover.includes('get') && def.get ? decodeGetSet(def.get, this) : undefined,
      call: leftover.includes('call') && def.call ? decodeCall(def.call, this) : undefined,
      init: leftover.includes('init') && def.init ? decodeInit(def.init, this) : undefined,
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
        // lazy proxies (ref/generic) may throw during compat — skip.
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
  private buildLocal(def: TypeDef): ExtensionLocal {
    const generic = def.generic
      ? Object.fromEntries(
          Object.entries(def.generic).map(([k, v]) => [k, this.parse(v)]),
        )
      : undefined;
    return {
      name: def.name,
      docs: def.docs,
      options: def.options,
      generic,
      props: def.props ? decodeProps(def.props, this) : undefined,
      get: def.get ? decodeGetSet(def.get, this) : undefined,
      call: def.call ? decodeCall(def.call, this) : undefined,
      init: def.init ? decodeInit(def.init, this) : undefined,
      constraint: def.constraint ? this.parseExpr(def.constraint) : undefined,
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

  fn<A extends object = any, R = any, E = any>(
    args: Type<A>,
    returns?: Type<R>,
    throws?: Type<E>,
  ) {
    return new FnType(this, { args, returns, throws });
  }

  iface(spec: IfaceSpec) {
    return new IfaceType(this, {
      props: spec.props ? decodeProps(spec.props, this) : {},
      get: spec.get ? decodeGetSet(spec.get, this) : undefined,
      call: spec.call ? decodeCall(spec.call, this) : undefined,
    });
  }

  ref(name: string)     { return new RefType(this, { name }); }
  generic(name: string) { return new GenericType(this, { name }); }

  extend<T, O>(base: Type<T> | string, local: ExtensionLocal<T, O>): Extension<T, O> {
    const baseType = typeof base === 'string'
      ? this.lookup(base) ?? (() => { throw new Error(`extend: unknown base '${base}'`); })()
      : base;
    return new Extension<T, O>(this, baseType as Type<T>, local);
  }

  // ─── PROP BUILDERS ───────────────────────────────────────────────────────

  prop(type: Type, nativeId: string, docs?: string): Prop {
    return new Prop({ type, get: { kind: 'native', id: nativeId } as ExprDef, docs });
  }

  method<A extends Record<string, Type>>(
    args: A,
    returns: Type,
    nativeId: string,
    docs?: string,
  ): Prop {
    const argFields: ObjPropsInput = {};
    for (const [k, t] of Object.entries(args)) argFields[k] = { type: t };
    return this.prop(this.fn(this.obj(argFields), returns), nativeId, docs);
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
  RefType,
  GenericType,
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
