import type { Extension, ExtensionLocal } from './extension';
import type {
  Prop,
  PropSpec,
  Type,
} from './type';
import type { TypeDef } from './schema';

// ============================================================================
// OPTION INTERFACES (per-type)
// ============================================================================

/** NumType options. */
export interface NumOptions {
  min?: number;
  max?: number;
  whole?: boolean;
  minPrecision?: number;
  maxPrecision?: number;
  prefix?: string;
  suffix?: string;
}

/** TextType options. */
export interface TextOptions {
  minLength?: number;
  maxLength?: number;
  /** Regex source (no leading/trailing slashes). */
  pattern?: string;
  /** Regex flags accompanying pattern. */
  flags?: string;
}

/** BoolType options. */
export interface BoolOptions {
  /** Custom text for true when serializing (e.g. "yes"). */
  trueText?: string;
  /** Custom text for false when serializing. */
  falseText?: string;
}

/** ListType options (item type lives in generic.V). */
export interface ListOptions {
  minLength?: number;
  maxLength?: number;
}

/** ColorType options. */
export interface ColorOptions {
  hasAlpha?: boolean;
}

/** DateType options. */
export interface DateOptions {
  min?: string;
  max?: string;
  /** Interpret parsed dates as UTC. */
  utc?: boolean;
}

/** TimestampType options. Extends DateOptions with time precision. */
export interface TimestampOptions extends DateOptions {
  /** 'ms' (default), 's', 'us'. */
  precision?: 'ms' | 's' | 'us';
}

/** ObjType field types live in options.props (separate from runtime Prop specs
 *  because schema-level TypeDef.props carries just the raw PropDef shapes). */
export interface ObjOptions {
  /** Structural fields keyed by name. */
  props: Record<string, { type: TypeDef; docs?: string }>;
}

/** Shortcut for ObjType construction — accepts Prop instances or raw
 *  PropSpec shapes (normalized by the constructor). */
export type ObjPropsInput = Record<string, Prop | PropSpec>;

/** IfaceType interface definitions are described by Partial<TypeDef>. */
export type IfaceSpec = Partial<TypeDef>;

// ============================================================================
// TYPE BUILDER
// ============================================================================

/**
 * TypeBuilder — factory surface for constructing runtime Type instances.
 *
 * The Registry implements this. Code that builds types (including other
 * Type classes building their sub-types in props/get/call/init) takes a
 * TypeBuilder so it never imports concrete type classes directly. No
 * circular dependencies, no hardcoded type-name inspection.
 */
export interface TypeBuilder {
  // ─── primitives ──────────────────────────────────────────────────────────
  any(): Type<any>;
  void(): Type<void>;
  null(): Type<null>;
  bool(options?: BoolOptions): Type<boolean>;
  num(options?: NumOptions): Type<number>;
  text(options?: TextOptions): Type<string>;

  // ─── containers ─────────────────────────────────────────────────────────
  list<V>(item: Type<V>, options?: ListOptions): Type<V[]>;
  map<K, V>(key: Type<K>, value: Type<V>): Type<Map<K, V>>;
  tuple<T extends any[]>(elements: { [I in keyof T]: Type<T[I]> }): Type<T>;
  obj<T extends object = Record<string, any>>(props: ObjPropsInput): Type<T>;

  // ─── modifiers ──────────────────────────────────────────────────────────
  optional<T>(inner: Type<T>): Type<T | undefined>;
  nullable<T>(inner: Type<T>): Type<T | null>;
  not(excluded: Type): Type;

  // ─── unions ─────────────────────────────────────────────────────────────
  or(variants: Type[]): Type;
  and(parts: Type[]): Type;

  // ─── constants ──────────────────────────────────────────────────────────
  enum<V>(values: Record<string, V>, value: Type<V>): Type<V>;

  /** A type whose only valid value is `value` of type `inner`. */
  literal<T>(inner: Type<T>, value: T): Type<T>;

  // ─── temporal ───────────────────────────────────────────────────────────
  date(options?: DateOptions): Type<Date>;
  timestamp(options?: TimestampOptions): Type<Date>;
  duration(): Type<number>;

  // ─── visual ─────────────────────────────────────────────────────────────
  color(options?: ColorOptions): Type<number>;

  // ─── callables ──────────────────────────────────────────────────────────
  fn<A extends object = any, R = any, E = any>(
    args: Type<A>,
    returns?: Type<R>,
    throws?: Type<E>,
  ): Type;

  // ─── interfaces ─────────────────────────────────────────────────────────
  iface(spec: IfaceSpec): Type;

  // ─── references & generics ──────────────────────────────────────────────
  ref(name: string): Type;
  generic(name: string): Type;

  // ─── extension ──────────────────────────────────────────────────────────
  extend<T, O>(base: Type<T> | string, local: ExtensionLocal<T, O>): Extension<T, O>;

  // ─── JSON parse ─────────────────────────────────────────────────────────
  parse(json: unknown): Type;

  // ─── prop builders (cut boilerplate in concrete Type.props() impls) ─────

  /** Field-style Prop: its type is whatever `type` resolves to, and access
   *  triggers the named native. Use for things like `length: num`. */
  prop(type: Type, nativeId: string, docs?: string): Prop;

  /** Method-style Prop: its type is a Fn(args) → returns, and when called
   *  the named native is invoked. Use for things like `eq`, `add`, `map`.
   *  `options.generic` declares method-level type parameters (e.g. `map<R>`);
   *  the values are the constraint Type (use `any` for unconstrained). */
  method<A extends Record<string, Type>>(
    args: A,
    returns: Type,
    nativeId: string,
    options?: { docs?: string; generic?: Record<string, Type> },
  ): Prop;
}
