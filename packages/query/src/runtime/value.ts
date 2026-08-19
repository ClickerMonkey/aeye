/**
 * Value — the universal result of evaluating an `Expr` at runtime.
 *
 * Mirrors cletus's `Value` (a runtime value plus optional schema metadata)
 * but typed against this package's `JsonValue` / `Field` / `FieldType` and
 * with ZERO `any` / casts. The optional `field` / `type` carry schema context
 * when an expression can supply it (e.g. a field reference); most computed
 * values leave them undefined — result-level type metadata is produced from
 * RESOLUTION (`Query.outputFields`), independent of these per-cell values.
 */
import type { JsonValue, ScalarValue } from '../schema';
import type { Field } from '../field';
import type { FieldType } from '../field-type';
import type { TextCasing } from '../text-casing';

/** The runtime category a value falls into, inferred from its JS shape. */
export type ValueCategory = 'null' | 'number' | 'string' | 'boolean' | 'object';

/** A runtime value (raw JSON) plus optional originating field / type metadata. */
export class Value {
  constructor(
    /** The raw JSON value this evaluation produced. */
    readonly raw: JsonValue,
    /** Originating field (when read directly from a field). */
    readonly field?: Field,
    /** Originating field type (when known). */
    readonly type?: FieldType,
  ) {}

  /** Construct a Value from a raw JSON value. */
  static of(raw: JsonValue, field?: Field, type?: FieldType): Value {
    return new Value(raw, field, type);
  }

  /** The SQL `NULL` value. */
  static null(): Value {
    return new Value(null);
  }

  // ─── Null / coercion ──────────────────────────────────────────────────

  /** Whether the raw value is SQL `NULL`. */
  isNull(): boolean {
    return this.raw === null;
  }

  /** Coerce to a number (NaN when not numerically meaningful). */
  toNumber(): number {
    if (typeof this.raw === 'number') return this.raw;
    if (typeof this.raw === 'boolean') return this.raw ? 1 : 0;
    if (typeof this.raw === 'string') return Number(this.raw);
    return Number.NaN;
  }

  /** Coerce to a boolean using JS truthiness over the raw value. */
  toBoolean(): boolean {
    if (typeof this.raw === 'boolean') return this.raw;
    if (this.raw === null) return false;
    if (typeof this.raw === 'number') return this.raw !== 0;
    if (typeof this.raw === 'string') return this.raw.length > 0;
    return true;
  }

  /** Coerce to a display string (empty string for null). */
  toText(): string {
    if (this.raw === null) return '';
    if (typeof this.raw === 'object') return JSON.stringify(this.raw);
    return String(this.raw);
  }

  /** Runtime category of the raw value. */
  category(): ValueCategory {
    if (this.raw === null) return 'null';
    if (typeof this.raw === 'number') return 'number';
    if (typeof this.raw === 'string') return 'string';
    if (typeof this.raw === 'boolean') return 'boolean';
    return 'object';
  }

  // ─── Comparison ───────────────────────────────────────────────────────

  /**
   * Three-way comparison for sorting / ordering. NULLs sort first. Numbers
   * compare numerically; everything else compares by its stringified form.
   */
  compareTo(other: Value): number {
    const aNull = this.isNull();
    const bNull = other.isNull();
    if (aNull && bNull) return 0;
    if (aNull) return -1;
    if (bNull) return 1;

    if (typeof this.raw === 'number' && typeof other.raw === 'number') {
      if (this.raw === other.raw) return 0;
      return this.raw < other.raw ? -1 : 1;
    }
    if (typeof this.raw === 'boolean' && typeof other.raw === 'boolean') {
      if (this.raw === other.raw) return 0;
      return this.raw ? 1 : -1;
    }
    const a = this.toText();
    const b = other.toText();
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  /**
   * The {@link TextCasing} this value's originating field type DECLARES, or
   * `undefined` — either because no type metadata reached this cell (a literal,
   * a param, a computed column) or because the type declares no casing.
   *
   * Deliberately NOT resolved to a boolean here. A `Value` cannot see the
   * engine, and the fallback is the ENGINE's default; folding it in with a
   * `?? false` was how the old accessor made "declares nothing" and "declares
   * case-insensitive" indistinguishable — which is precisely what a per-field
   * declaration has to out-rank. The comparison site resolves the two operands'
   * declarations against `ctx.engine.textCasing` together (`effectiveCasing`).
   */
  textCasing(): TextCasing | undefined {
    return this.type?.textCasing();
  }

  /**
   * Three-way comparison honoring text case-sensitivity: identical to
   * `compareTo` except that, when both operands are strings and `sensitive`
   * is false, both are lower-cased before comparing. Numbers / booleans are
   * unaffected (no case-folding applies).
   */
  compareToCase(other: Value, sensitive: boolean): number {
    if (!sensitive && typeof this.raw === 'string' && typeof other.raw === 'string') {
      const a = this.raw.toLowerCase();
      const b = other.raw.toLowerCase();
      if (a === b) return 0;
      return a < b ? -1 : 1;
    }
    return this.compareTo(other);
  }

  /** SQL-equality (NULL is never equal to anything, including NULL). */
  equals(other: Value): boolean {
    if (this.isNull() || other.isNull()) return false;
    return this.compareTo(other) === 0;
  }

  /** Identity-equality treating two NULLs as equal (for grouping / set-ops). */
  identical(other: Value): boolean {
    if (this.isNull() && other.isNull()) return true;
    if (this.isNull() || other.isNull()) return false;
    return this.compareTo(other) === 0;
  }
}

/** Whether a JSON value is a scalar (the kind a literal / cell can hold). */
export function isScalarValue(v: JsonValue): v is ScalarValue {
  return v === null || typeof v !== 'object';
}
