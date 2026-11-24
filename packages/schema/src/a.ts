/**
 * `a` — the builder, like zod's `z`.
 *
 *   import { a } from '@aeye/schema';
 *   const Task = a.object({ title: a.string(), tags: a.record(a.number()) });
 *   type Task = a.infer<typeof Task>;
 */
import {
  AnyType, ArrayType, BooleanType, CodecType, ConditionalType, DependentType, EnumType, IntersectionType, LiteralType,
  NotType, NullType, NullableType, NumberType, ObjectType, OptionalType, RecordType, RefType, StringType, TupleType, UnionType,
  type AnySchema, type LiteralValue, type OutOf, type Shape,
} from './schema';
import { Module, type Defs } from './module';
import type { JsonValue } from './types';

export { fromJSONSchema } from './json-schema';

export const string = (): StringType => new StringType();
export const number = (): NumberType => new NumberType();
export const int = (): NumberType => new NumberType({ int: true });
export const boolean = (): BooleanType => new BooleanType();
const null_ = (): NullType => new NullType();
export const literal = <const V extends LiteralValue>(value: V): LiteralType<V> => new LiteralType(value);
const enum_ = <const V extends readonly [string, ...string[]]>(values: V): EnumType<V> => new EnumType(values);
export { null_ as null, enum_ as enum };

/** Any JSON value, typed `unknown`. */
export const unknown = (): AnyType<unknown> => new AnyType<unknown>();
/** Any JSON value, typed `JsonValue`. */
export const json = (): AnyType<JsonValue> => new AnyType<JsonValue>();

export const object = <const S extends Shape>(shape: S): ObjectType<S> => new ObjectType(shape);
export const array = <E extends AnySchema>(element: E): ArrayType<E> => new ArrayType(element);
export const tuple = <const T extends readonly [AnySchema, ...AnySchema[]]>(items: T): TupleType<T> => new TupleType(items);

/** `a.record(V)` — string keys; `a.record(a.enum([...]), V)` — known keys (all optional). */
export function record<V extends AnySchema>(value: V): RecordType<V>;
export function record<K extends StringType | EnumType<any>, V extends AnySchema>(key: K, value: V): RecordType<V, K extends EnumType<infer E> ? E[number] : string>;
export function record(a1: AnySchema, a2?: AnySchema): RecordType<AnySchema, string> {
  return a2 ? new RecordType(a2, a1 as unknown as StringType) : new RecordType(a1);
}

export const union = <const O extends readonly [AnySchema, ...AnySchema[]]>(options: O): UnionType<O> => new UnionType(options);
/** A union picked by a literal field (`tag`) on each object option. */
export const discriminatedUnion = <const Tag extends string, const O extends readonly [ObjectType<any>, ...ObjectType<any>[]]>(
  tag: Tag,
  options: O & { readonly [I in keyof O]: O[I] extends ObjectType<infer S> ? (Tag extends keyof S ? unknown : { readonly 'missing tag field': Tag }) : unknown },
): UnionType<O> => new UnionType(options as O, tag);

/** Every member at once (`allOf`, gin's `and`): objects are merged, anything else is validated after the first. */
export const intersection = <const T extends readonly [AnySchema, ...AnySchema[]]>(members: T): IntersectionType<T> => new IntersectionType(members);

/** A value of `base` (default any JSON) that must NOT match `excluded` (gin's `not`, JSON Schema `not`). */
export function not<B extends AnySchema = AnyType<unknown>>(excluded: AnySchema, base?: B): NotType<B> {
  return new NotType(excluded, (base ?? new AnyType()) as B);
}

/** JSON Schema `if`/`then`/`else` over a value of `base`: said in words where unsupported, always validated. */
export function conditional<B extends AnySchema>(base: B, rule: { if: AnySchema; then?: AnySchema; else?: AnySchema }): ConditionalType<B> {
  return new ConditionalType(base, rule.if, rule.then, rule.else);
}

/**
 * A field typed by a sibling field's decoded value; use inside `a.object`.
 * `a.object({...}).dependent(key, on, fn)` types `fn`'s argument from the sibling.
 */
export function dependent<Out = unknown>(on: string, schemaFor: (sibling: unknown) => AnySchema | undefined, base?: AnySchema): DependentType<Out> {
  return new DependentType<Out>(on, schemaFor, base);
}

export const optional = <T extends AnySchema>(inner: T): OptionalType<T> => new OptionalType(inner);
export const nullable = <T extends AnySchema>(inner: T): NullableType<T> => new NullableType(inner);

/** A use of a named type; defined later in the chain (statically or by the dynamic step). */
export const ref = <const N extends string>(name: N): RefType<N> => new RefType(name);

/** A value the model writes as `wire` and the code holds as `Out`. */
export const codec = <W extends AnySchema, Out>(
  wire: W,
  codec: { decode: (wire: OutOf<W>) => Out | Error; encode: (value: Out) => OutOf<W> },
): CodecType<W, Out> => new CodecType(wire, codec);

/** Start a chain with named types. */
export const define = <const D extends Defs>(defs: D): Module<D, {}> => new Module(defs);
/** Start a chain by pinning the types of refs a dynamic step will supply. */
export const declare = <T extends Record<string, unknown>>(): Module<{}, T> => new Module();
/** Start an empty chain. */
export const module = (): Module<{}, {}> => new Module();

/** The code-shape type of a schema or bundle. */
export type Infer<S extends { readonly _out: unknown }> = S['_out'];
export type { Infer as infer };
