import type { Extension, ExtensionLocal } from './extension';
import type { Expr } from './expr';
import type { Call, GetSet, Prop, PropSpec, Type } from './type';
import type { CallDef, ExprDef, GetSetDef, PropDef, TypeDef } from './schema';
import type {
  DataFields, FieldsInput, FnValue, Infer, IntersectValues, NamedValue, ObjValue, TupleValue, WithData,
} from './infer';
import type { AliasType } from './types/alias';
import type { AndType } from './types/and';
import type { AnyType } from './types/any';
import type { BoolType } from './types/bool';
import type { ColorType } from './types/color';
import type { DateType } from './types/date';
import type { DurationType } from './types/duration';
import type { EnumType } from './types/enum';
import type { FnType } from './types/fn';
import type { IfaceType } from './types/iface';
import type { ListType } from './types/list';
import type { LiteralType } from './types/literal';
import type { MapType } from './types/map';
import type { NotType } from './types/not';
import type { NullType } from './types/null';
import type { NullableType } from './types/nullable';
import type { NumType } from './types/num';
import type { ObjType } from './types/obj';
import type { OptionalType } from './types/optional';
import type { OrType } from './types/or';
import type { TextType } from './types/text';
import type { TimestampType } from './types/timestamp';
import type { TupleType } from './types/tuple';
import type { TypType } from './types/typ';
import type { VoidType } from './types/void';

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

/** Fields for `obj` — each a bare `Type`, a `Prop`, or a `PropSpec`. */
export type ObjPropsInput = FieldsInput;

/**
 * The surfaces of an `iface`. Props may be given as types / `Prop`s /
 * `PropSpec`s or as wire `PropDef`s, and `get` / `call` as instances or
 * wire defs — wire shapes are parsed against the registry.
 */
export interface IfaceSpec<P extends FieldsInput = FieldsInput> {
  props?: P | Record<string, PropDef>;
  get?: GetSet | GetSetDef;
  call?: Call | CallDef;
}

/** What {@link TypeBuilder.field} adds to a field beyond its type. */
export interface FieldOptions {
  /** Shown to authors and models wherever the field is described. */
  docs?: string;
  /** The value a `new` fills in when its payload omits the field. */
  default?: Expr | ExprDef;
}

/** A field written with {@link TypeBuilder.field}: keeps its exact `Type`. */
export interface FieldSpec<X extends Type> extends PropSpec {
  readonly type: X;
}

/** A prop computed by a native — {@link TypeBuilder.prop} / {@link TypeBuilder.method} build these. */
export type ComputedProp<T = any> = Prop<T> & { readonly get: Expr };

/** What {@link TypeBuilder.fn} takes: the signature, plus optional generics and a body. */
export interface FnSpec<A extends object, R, E> {
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
}

/** An `extend` local whose `props` are kept exactly, so their data fields type the value. */
export type ExtendLocal<T, O, P extends FieldsInput> = Omit<ExtensionLocal<T, O>, 'props'> & { props?: P };

/** The primitive a literal value belongs to: `'ok'` → `string`. */
export type Widen<T extends string | number | boolean> =
  T extends string ? string : T extends number ? number : boolean;

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
 *
 * Every builder returns its concrete class carrying the TypeScript value it
 * describes, so `Infer<typeof t>` is exact — see `infer.ts`:
 *
 * ```ts
 * const Read = r.obj({ path: r.text(), offset: r.optional(r.num()) });
 * type Read = Infer<typeof Read>;   // { path: string; offset?: number | undefined }
 * ```
 */
export interface TypeBuilder {
  // ─── primitives ──────────────────────────────────────────────────────────
  any(): AnyType;
  void(): VoidType;
  null(): NullType;
  bool(options?: BoolOptions): BoolType;
  num(options?: NumOptions): NumType;
  text(options?: TextOptions): TextType;

  // ─── containers ─────────────────────────────────────────────────────────
  list<V>(item: Type<V>, options?: ListOptions): ListType<V>;
  map<K, V>(key: Type<K>, value: Type<V>): MapType<K, V>;
  tuple<const E extends readonly Type[]>(elements: E): TupleType<TupleValue<E>>;
  /** An object over `props`; a field typed `optional<T>` is an optional key. */
  obj<const P extends FieldsInput>(props: P): ObjType<ObjValue<P>>;
  /** A field with docs and/or a default, keeping its exact type for inference. */
  field<X extends Type>(type: X, options?: FieldOptions): FieldSpec<X>;

  // ─── modifiers ──────────────────────────────────────────────────────────
  optional<T>(inner: Type<T>): OptionalType<T>;
  nullable<T>(inner: Type<T>): NullableType<T>;
  not(excluded: Type): NotType;

  // ─── unions ─────────────────────────────────────────────────────────────
  or<const V extends readonly Type[]>(variants: V): OrType<Infer<V[number]>>;
  and<const V extends readonly Type[]>(parts: V): AndType<IntersectValues<V>>;

  // ─── constants ──────────────────────────────────────────────────────────
  /** Named constants of `value`'s type: `enum({ low: 'low', high: 'high' }, r.text())`. */
  enum<const E extends Record<string, B>, B>(values: E, value: Type<B>): EnumType<E[keyof E], B>;
  /** Text constants whose labels are their values: `enum(['low', 'high'])`. */
  enum<const L extends readonly string[]>(labels: L): EnumType<L[number], string>;

  /** A type whose only valid value is `value` of type `inner`. */
  literal<const T extends B, B>(inner: Type<B>, value: T): LiteralType<T, B>;
  /** A literal of the matching primitive type: `literal('ok')`, `literal(3)`, `literal(true)`. */
  literal<const T extends string | number | boolean>(value: T): LiteralType<T, Widen<T>>;

  // ─── temporal ───────────────────────────────────────────────────────────
  date(options?: DateOptions): DateType;
  timestamp(options?: TimestampOptions): TimestampType;
  duration(): DurationType;

  // ─── visual ─────────────────────────────────────────────────────────────
  color(options?: ColorOptions): ColorType;

  // ─── callables ──────────────────────────────────────────────────────────
  /** A fn type: NOTE a single options object, not positional args. */
  fn<A extends object, R = void, E = never>(opts: FnSpec<A, R, E>): FnType<A, R, E>;

  // ─── interfaces ─────────────────────────────────────────────────────────
  iface<const P extends FieldsInput = {}>(spec: IfaceSpec<P>): IfaceType<ObjValue<DataFields<P>>>;

  // ─── aliases (former ref + generic, unified) ────────────────────────────
  /** A reference by name, resolved at use time — `T` is the value it stands for. */
  alias<T = unknown>(name: string): AliasType<T>;
  /** "A type that satisfies `constraint`" — its values are types. */
  typ<T>(constraint: Type<T>): TypType<T>;

  // ─── extension ──────────────────────────────────────────────────────────
  /** A named subtype of `base`; stored-data props it adds extend the value. */
  extend<T, O, const P extends FieldsInput = {}>(
    base: Type<T, O>,
    local: ExtendLocal<T, O, P>,
  ): Extension<WithData<T, P>, O>;
  /** A named subtype of the type registered or built in under the name `base`. */
  extend<const N extends string, const P extends FieldsInput = {}>(
    base: N,
    local: ExtendLocal<NamedValue<N>, any, P>,
  ): Extension<WithData<NamedValue<N>, P>>;

  // ─── JSON parse ─────────────────────────────────────────────────────────
  parse(json: unknown): Type;

  // ─── prop builders (cut boilerplate in concrete Type.props() impls) ─────

  /** Field-style Prop: its type is whatever `type` resolves to, and access
   *  triggers the named native. Use for things like `length: num`. */
  prop<T>(type: Type<T>, nativeId: string, docs?: string): ComputedProp<T>;

  /** Method-style Prop: its type is a Fn(args) → returns, and when called
   *  the named native is invoked. Use for things like `eq`, `add`, `map`.
   *  `options.generic` declares method-level type parameters (e.g. `map<R>`);
   *  the values are the constraint Type (use `any` for unconstrained). */
  method<const A extends Record<string, Type>, R>(
    args: A,
    returns: Type<R>,
    nativeId: string,
    options?: { docs?: string; generic?: Record<string, Type> },
  ): ComputedProp<FnValue<ObjValue<A>, R>>;
}
