import type { TypeDef } from './schema';
import type { Type } from './type';
import type { Value } from './value';

/**
 * JSON envelope: a type paired with its (subtype-preserving) JSON value.
 * Produced by `Value.toJSON()` and consumed by `Registry.parseValue()`.
 * Every nested composite slot inside `.value` is itself a `JSONValue`,
 * so per-element concrete types round-trip through JSON.
 */
export interface JSONValue<T = unknown> {
  type: TypeDef;
  value: JSONOf<T>;
}

/**
 * Runtime shape of `.raw` on `Value<T>`. Composites hold nested `Value`
 * instances so a list/map/tuple/obj can carry per-element concrete types
 * alongside the container's declared element type.
 *
 * Order matters:
 *  - `Value` itself passes through (it's already a runtime-shaped cell —
 *    don't re-wrap it in another Value).
 *  - `Type` passes through too: types-as-values (the `typ` type) store the
 *    Type instance directly rather than deep-mapping its properties.
 *  - Tuples (`[a, ...b[]]`) are matched BEFORE plain arrays so per-position
 *    shape is preserved: `[number, string]` → `[Value<number>, Value<string>]`.
 *    (TupleType declares T as `[any, ...any[]]` so this branch fires.)
 *  - Arrays and Maps are checked before the generic `object` branch
 *    since both extend `object` structurally.
 */
export type RuntimeOf<T> =
  T extends Value<any> ? T
  : T extends Type<any, any> ? T
  : T extends readonly [any, ...any[]] ? { [K in keyof T]: Value<T[K]> }
  : T extends (infer E)[] ? Value<E>[]
  : T extends ReadonlyArray<infer E> ? ReadonlyArray<Value<E>>
  : T extends Map<infer K, infer V> ? Map<unknown, [Value<K>, Value<V>]>
  : T extends Date ? Date
  : T extends (...args: any) => any ? T
  : T extends null | undefined | boolean | number | string ? T
  : T extends object ? { [K in keyof T]: Value<T[K]> }
  : T;

/**
 * JSON form of `T` — the recursive envelope shape returned by
 * `Type.encode(raw)`. Every nested composite slot is a `JSONValue`, so
 * element-level concrete types survive JSON round-trip (a Dog in a
 * `list<Animal>` comes back as Dog, not Animal).
 *
 * `Type` encodes to its `TypeDef` descriptor (what `typ` values serialize
 * as on the wire).
 */
export type JSONOf<T> =
  T extends Value<infer U> ? JSONValue<U>
  : T extends Type<any, any> ? TypeDef
  : T extends readonly [any, ...any[]] ? { [K in keyof T]: JSONValue<T[K]> }
  : T extends (infer E)[] ? JSONValue<E>[]
  : T extends ReadonlyArray<infer E> ? ReadonlyArray<JSONValue<E>>
  : T extends Map<infer K, infer V>
    ? Array<{ key: JSONValue<K>; value: JSONValue<V> }>
  : T extends Date ? string
  : T extends (...args: any) => any ? string
  : T extends void ? null
  : T extends null | undefined | boolean | number | string ? T
  : T extends object ? { [K in keyof T]: JSONValue<T[K]> }
  : T;
