/**
 * Static inference for gin types — the TypeScript value a `Type` describes.
 *
 * Every builder on {@link TypeBuilder} returns its concrete class carrying the
 * logical value type, so `r.obj({ path: r.text(), offset: r.optional(r.num()) })`
 * is an `ObjType<{ path: string; offset?: number | undefined }>` and
 * `Infer<typeof that>` reads it back. The gin type is the single source of truth:
 * change a field and every TypeScript use of the inferred value follows.
 *
 * "Value" here is gin's LOGICAL value — what `Value.toLogical()` returns: plain
 * JS with `Date` for `date` / `timestamp`, a `Map` for `map`, numbers for
 * `duration` (ms) and `color`. `Value.raw` is the runtime form, see `RuntimeOf`.
 */
import type { Expr } from './expr';
import type { ExprDef } from './schema';
import type { Prop, PropSpec, Type, ValueSlot } from './type';
import type { Value } from './value';
import type { AnyType } from './types/any';
import type { BoolType } from './types/bool';
import type { ColorType } from './types/color';
import type { DateType } from './types/date';
import type { DurationType } from './types/duration';
import type { FnType } from './types/fn';
import type { ListType } from './types/list';
import type { MapType } from './types/map';
import type { NullType } from './types/null';
import type { NumType } from './types/num';
import type { ObjType } from './types/obj';
import type { OptionalType } from './types/optional';
import type { TextType } from './types/text';
import type { TimestampType } from './types/timestamp';
import type { VoidType } from './types/void';

/** Flattens an intersection into one object type, so hovers read as a plain shape. */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The logical TypeScript value of a gin type: `Infer<ListType<string>>` is `string[]`. */
export type Infer<X> = X extends Type<any, any> & { readonly [K in ValueSlot]: infer T } ? T : never;

/**
 * One field of an `obj`, `iface` or extension, in any of the forms gin reads:
 * a bare `Type` (the shorthand), a `Prop`, or a `PropSpec` (`{ type, docs?, default? }`).
 */
export type FieldInput = Type | Prop | PropSpec;

/** A record of fields, keyed by field name. */
export type FieldsInput = Record<string, FieldInput>;

/** The `Type` a field declares. A field written as a wire `PropDef` declares `Type<unknown>`. */
export type FieldType<F> = F extends Type<any, any>
  ? F
  : F extends { readonly type: infer X } ? (X extends Type<any, any> ? X : Type<unknown>) : never;

/** True for a field whose type is `optional<T>`: the key may be absent from the value. */
export type IsOptionalField<F> = FieldType<F> extends OptionalType<any> ? true : false;

/**
 * True for a field something else computes: one with a `get` expression, or whose
 * type is a fn. Gin treats these as SURFACE (methods, computed reads), not stored
 * data — the same line `Extension` draws for its local props.
 */
export type IsSurfaceField<F> = F extends Type<any, any>
  ? (F extends FnType<any, any, any> ? true : false)
  : F extends { readonly get: Expr } ? true
  : FieldType<F> extends FnType<any, any, any> ? true : false;

/** The value of an `obj` over fields `P`: `optional` fields become optional keys. */
export type ObjValue<P extends FieldsInput> = Simplify<
  { -readonly [K in keyof P as IsOptionalField<P[K]> extends true ? never : K]: Infer<FieldType<P[K]>> }
  & { -readonly [K in keyof P as IsOptionalField<P[K]> extends true ? K : never]?: Infer<FieldType<P[K]>> }
>;

/** The stored-data fields of `P` — every field that is not surface ({@link IsSurfaceField}). */
export type DataFields<P extends FieldsInput> = {
  [K in keyof P as IsSurfaceField<P[K]> extends true ? never : K]: P[K];
};

/** The value of a `tuple` over element types `E`. */
export type TupleValue<E extends readonly Type[]> =
  { -readonly [I in keyof E]: Infer<E[I]> } extends infer U extends unknown[] ? U : never;

/**
 * The value of an `and` over parts `V`: the intersection of each part's value.
 * A parts list whose length is not known statically (`Type[]`) infers `any`, as gin's
 * own untyped `Type` does.
 */
export type IntersectValues<V extends readonly Type[]> =
  number extends V['length'] ? Infer<V[number]>
  : V extends readonly [infer H, ...infer R extends readonly Type[]] ? Infer<H> & IntersectValues<R>
  : unknown;

/**
 * The value of a fn type. A fn value is opaque — a JS callable taking the args
 * `Value`, a lambda `ExprDef`, or a native reference string — so the args and
 * returns are kept on the `FnType` itself; see {@link FnArgs} / {@link FnReturns}.
 */
export type FnValue<A extends object = any, R = any> =
  | ((args: Value<A>) => Promise<Value<R>>)
  | ExprDef
  | string;

/** The args value of a fn type. */
export type FnArgs<F> = F extends FnType<infer A, any, any> ? A : never;

/** The return value of a fn type. */
export type FnReturns<F> = F extends FnType<any, infer R, any> ? R : never;

/** The thrown value of a fn type. */
export type FnThrows<F> = F extends FnType<any, any, infer E> ? E : never;

/**
 * The canonical instance a built-in class name resolves to (`r.lookup('text')`),
 * for typing `extend('text', …)` by name.
 */
export interface BuiltinTypes {
  any: AnyType;
  void: VoidType;
  null: NullType;
  bool: BoolType;
  num: NumType;
  text: TextType;
  list: ListType<any>;
  map: MapType<any, any>;
  obj: ObjType<Record<string, any>>;
  date: DateType;
  timestamp: TimestampType;
  duration: DurationType;
  color: ColorType;
}

/** The value of a type known by name: a built-in class's value, else `unknown`. */
export type NamedValue<N extends string> = N extends keyof BuiltinTypes ? Infer<BuiltinTypes[N]> : unknown;

/**
 * `T` extended with the stored data fields of `P` — the value of an `Extension`
 * that adds fields to a record base. With no data fields it is `T` unchanged.
 */
export type WithData<T, P extends FieldsInput> = [keyof DataFields<P>] extends [never]
  ? T
  : Simplify<T & ObjValue<DataFields<P>>>;
