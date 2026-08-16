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
 * How a `Value` is written to JSON. Both axes default to the shape gin has
 * always produced, so `toJSON()` / `encode()` with no options are unchanged.
 *
 * There used to be exactly two ways to hold a typed value — the live `Value`,
 * or the full `{type, value}` envelope — and no third, envelope-free,
 * type-preserving form. Consumers that had to hand a bare logical value
 * across a boundary reimplemented the walk, which is a copy of gin's own
 * serialization free to drift from it. And the envelope was expensive for a
 * reason that had nothing to do with carrying a type: a REGISTERED named
 * type's `toJSON()` inlines its whole definition, at EVERY element.
 * Measured on `list<project>` with four scalar fields per row:
 *
 *   n=1000   logical 54,671   full envelope 376,894  (6.9x)
 *            name-only refs ~2x, and `Registry.parseValue` already accepts it
 *
 * gin draws exactly this reference-vs-definition distinction on the TYPE side
 * — `Registry.scope()` binds a name that round-trips as `{name}` where
 * `register()` binds an instance that round-trips inlined — and these options
 * apply it to the VALUE envelope.
 */
export interface EncodeOptions {
  /**
   * - `'envelope'` (default) — every nested slot is a `{type, value}` pair,
   *   so per-element concrete types survive the round trip.
   * - `'logical'` — no envelopes anywhere; the bare logical JSON a caller who
   *   already knows the declared type wants. A `map` still emits
   *   `[{key, value}]` and a `timestamp` an ISO string, because those are the
   *   logical JSON forms, not envelopes.
   */
  form?: 'envelope' | 'logical';
  /**
   * - `'definition'` (default) — a type is written as its full `TypeDef`.
   * - `'name'` — a type the producing registry resolves to THIS instance is
   *   written as `{name}`. Round-trips through `Registry.parseValue`
   *   unchanged, including per-element subtypes. Requires the consumer to
   *   share the registry: a name it has not registered parses to an UNBOUND
   *   alias, which is universal — which is why this is opt-in and not the
   *   default.
   */
  typeRefs?: 'definition' | 'name';
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
