import type { Type } from './type';
import type { JSONOf, JSONValue, RuntimeOf } from './json-type';

/**
 * Value: a typed runtime value — a (Type, raw) pair.
 *
 * Every piece of data flowing through the expression system is a Value.
 * The Type knows how to validate, serialize, and operate on the raw data.
 *
 * `T` is the LOGICAL type; `.raw` is `RuntimeOf<T>` (composites hold nested
 * Value instances so per-element concrete types are preserved).
 */
export class Value<T = any> {
  readonly type: Type<T>;
  readonly raw: RuntimeOf<T>;
  constructor(type: Type<T>, raw: RuntimeOf<T> | unknown) {
    this.type = type;
    this.raw = raw as RuntimeOf<T>;
  }

  /**
   * Serialize just the raw to its JSON envelope form — the `value` side of
   * a full envelope. Each nested composite slot is itself a `JSONValue`,
   * so per-element concrete types round-trip. Useful when you have the
   * Type separately and only need the value portion; callers that want
   * the full `{type, value}` envelope should use `toJSON()`.
   */
  encode(): JSONOf<T> {
    return this.type.encode(this.raw);
  }

  /**
   * Full JSON envelope — `{type, value}` where `value` is the recursive
   * envelope form (each nested composite slot is itself a `JSONValue`).
   * Subtype info is preserved at every level, so `Registry.parseValue()`
   * can reconstruct the value with the original per-element types intact.
   * Named `toJSON` so `JSON.stringify(value)` picks it up automatically.
   */
  toJSON(): JSONValue<T> {
    return {
      type: this.type.toJSON(),
      value: this.encode(),
    };
  }
}

/**
 * Create a Value from a Type and runtime-shaped raw data.
 *
 * `T` is inferred from the `type` argument; `raw` is accepted loosely to
 * keep inference unidirectional (callers don't have to know `RuntimeOf<T>`
 * at the type level). The Value constructor itself does type-check raw
 * against `RuntimeOf<T>` — use `new Value(...)` directly when you want
 * that full check.
 */
export function val<T>(type: Type<T>, raw: RuntimeOf<T> | unknown): Value<T> {
  return new Value(type, raw as RuntimeOf<T>);
}
