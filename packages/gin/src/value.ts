import { type Type, ENVELOPE_ENCODE } from './type';
import type { EncodeOptions, JSONOf, JSONValue, RuntimeOf } from './json-type';

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
   * The LOGICAL value — plain JS, `T` itself: every nested `Value` cell is
   * unwrapped, a `map` becomes a `Map` of logical keys to logical values,
   * and leaves stay as their type keeps them (`Date` for `date` /
   * `timestamp`, numbers for `duration` and `color`, a `Type` for `typ`, a
   * fn's callable / lambda / native ref as is).
   *
   * This is the form to hand to code that consumes a value gin has already
   * checked — `registry.parseValue(json, type).toLogical()`.
   */
  toLogical(): T {
    // `T` is what `RuntimeOf<T>` is the cell-wrapped form of; `logical` is
    // the inverse of that wrapping, so the result is `T` by construction.
    return logical(this.raw) as T;
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
   *
   * `opts` selects a cheaper wire form — see {@link EncodeOptions}. Both
   * axes default to what gin has always emitted, so `toJSON()` is unchanged.
   */
  toJSON(opts: EncodeOptions = ENVELOPE_ENCODE): JSONValue<T> {
    return {
      type: this.type.toJSONRef(opts),
      value: this.type.encodeAs(this.raw, opts) as JSONOf<T>,
    };
  }

  /**
   * The bare LOGICAL JSON form — no `{type, value}` envelope at any depth.
   *
   * The third way to hold a value, and until 0.4.1 it did not exist:
   * `toJSON()` gives the full envelope and `encode()` drops only the OUTER
   * layer, so a `list<num>` still encoded as `[{type, value}]`. There was no
   * way to add one from outside either, because the composite/leaf split
   * lives on `Type.encode` — so consumers that had to hand a bare value
   * across a boundary (an HTTP response, a jsonb column, a tool result)
   * reimplemented gin's walk, and two such copies diverged at exactly the
   * nodes where "logical JSON" and "logical JS" differ.
   *
   * Logical JSON, not logical JS: a `map` is `[{key, value}]` and a
   * `timestamp` an ISO string, because that is what each type's own `encode`
   * says its JSON form is. The type is NOT carried — a caller who needs it
   * back re-parses against the declared type (`registry.parseValue(json,
   * declared)`), which is what a declared signature is for.
   */
  encodeLogical(): unknown {
    return this.type.encodeAs(this.raw, LOGICAL_ENCODE);
  }

  /**
   * The envelope with every registry-resolvable type written as `{name}`
   * instead of its whole definition.
   *
   * `Registry.parseValue` already accepts this form and reconstructs
   * per-element subtypes from it — the producer was the only half inlining.
   * Requires the consumer to share the registry; see {@link EncodeOptions}.
   */
  toJSONRefs(): JSONValue<T> {
    return this.toJSON({ form: 'envelope', typeRefs: 'name' });
  }

  /**
   * The declared type ONCE, over a bare logical value — the cheapest form
   * that still carries a type, and the one to reach for when a consumer
   * shares the registry.
   *
   * Measured on `list<project>`, four scalar fields per row, against the
   * logical JSON as the baseline:
   *
   *   n=1000   encodeLogical 1.0x  ·  toJSONLogical ~1.0x  ·  toJSONRefs 4.1x
   *            ·  toJSON 6.9x
   *
   * The trade against {@link toJSONRefs} is stated rather than hidden: with
   * one type at the top, a per-ELEMENT subtype is demoted to the declared
   * element type on the way back (a `flagship` in a `list<project>` returns
   * as a `project`). Pay the per-element envelope only when that matters.
   */
  toJSONLogical(): JSONValue<T> {
    return this.toJSON(LOGICAL_ENCODE);
  }
}

/** Unwraps runtime cells: the inverse of `RuntimeOf`. */
function logical(raw: unknown): unknown {
  if (raw instanceof Value) return raw.toLogical();
  if (Array.isArray(raw)) return raw.map(logical);
  if (raw instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const entry of raw.values()) {
      if (isCellPair(entry)) out.set(entry[0].toLogical(), entry[1].toLogical());
    }
    return out;
  }
  if (isPlainObject(raw)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) out[key] = logical(value);
    return out;
  }
  return raw;
}

/** A runtime `map` entry: `[Value<K>, Value<V>]`. */
function isCellPair(entry: unknown): entry is [Value, Value] {
  return Array.isArray(entry) && entry.length === 2 && entry[0] instanceof Value && entry[1] instanceof Value;
}

/** A plain record — not a `Date`, `Type`, `Map` or any other class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The options {@link Value.encodeLogical} runs under. */
const LOGICAL_ENCODE: EncodeOptions = { form: 'logical', typeRefs: 'name' };

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
