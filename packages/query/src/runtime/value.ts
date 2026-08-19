/**
 * Value — the universal result of evaluating an `Expr` at runtime.
 *
 * Mirrors cletus's `Value` (a runtime value plus optional schema metadata)
 * but typed against this package's `JsonValue` / `Field` / `FieldType` and
 * with ZERO `any` / casts. The optional `field` / `type` carry schema context
 * when an expression can supply it; result-level type metadata is produced from
 * RESOLUTION (`Query.outputFields`), independent of these per-cell values.
 *
 * WHERE `type` COMES FROM, and why it matters more than it used to. A field-ref
 * supplies the column's own type; a registered FUNCTION or OPERATOR supplies its
 * DECLARED output type ({@link withType}, applied by the dispatch helpers in
 * `functions.ts`); a literal, a param and an arithmetic result carry none. It is
 * the channel a declaration reaches a comparison through — both the
 * {@link TextCasing} a text type declares and the {@link ValueComparator} a
 * refinement's impl declares — so a produced value with no type is a value whose
 * declaration cannot govern how it is compared. That was the whole of the
 * in-memory gap for a registered type: the hook existed nowhere, and even with
 * the hook a computed value had no type to reach it with.
 */
import type { JsonValue, ScalarValue } from '../schema';
import type { Field } from '../field';
import type { FieldType } from '../field-type';
import type { ValueComparator } from '../refinement';
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

  /**
   * This value carrying `type` — the seam a registered function's / operator's
   * DECLARED output reaches its result through (see the module docs).
   *
   * THE DECLARATION WINS over whatever the run happened to tag, and that is the
   * point rather than an accident: `resolve()` answers the declared output type,
   * so a result whose per-cell type disagreed with it would make the two halves
   * of one call describe different types — and the per-cell one is the half
   * nothing validates. A run that legitimately wants to say more about its
   * result says it in the declaration.
   *
   * `undefined` is a no-op, so the ordinary "this function declares `inferred`"
   * case allocates nothing.
   */
  withType(type: FieldType | undefined): Value {
    if (type === undefined || type === this.type) return this;
    return new Value(this.raw, this.field, type);
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
   * The {@link ValueComparator} this value's originating field type DECLARES, or
   * `undefined` — either because no type metadata reached this cell, or because
   * the type is a plain builtin (whose comparison rule is {@link compareTo}
   * itself) or a refinement with no registered impl.
   *
   * The exact counterpart of {@link textCasing}, and unresolved for the same
   * reason: a `Value` cannot see the other operand, and which of two declarations
   * governs is a decision for the pair (see {@link effectiveComparator}).
   */
  comparator(): ValueComparator | undefined {
    return this.type?.valueComparator();
  }

  /**
   * Three-way comparison for sorting / ordering. NULLs sort first. A type that
   * DECLARES how its values compare decides; otherwise numbers compare
   * numerically, booleans false-first, and everything else by its stringified
   * form.
   *
   * NULL IS DECIDED BEFORE THE DECLARATION IS CONSULTED, and that ordering is
   * load-bearing. SQL's NULL placement is a property of the SORT, not of the
   * column's type — `ORDER BY … NULLS FIRST` is the same clause whatever the
   * type is — so a comparator is never handed a NULL and never has to have an
   * opinion about one. It also means a comparator cannot accidentally break
   * three-valued logic, which `evaluateBool` settles one layer up.
   */
  compareTo(other: Value): number {
    const aNull = this.isNull();
    const bNull = other.isNull();
    if (aNull && bNull) return 0;
    if (aNull) return -1;
    if (bNull) return 1;

    const declared = effectiveComparator(this.comparator(), other.comparator());
    if (declared) return sign(declared(this.raw, other.raw));

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
   *
   * A DECLARED COMPARATOR OUT-RANKS THE FOLD, which is why the case branch is
   * guarded by it rather than reached first. `casing` and `compareValues` are
   * two ways to say how values of a type compare, and a type that supplied the
   * second has answered the whole question — folding its operands before handing
   * them over would silently mutate the input to a comparator that may not be
   * comparing text at all (an `inet`, a semver, a sortable id). A refinement
   * that wants the package's folding declares no comparator and narrows
   * `options.casing` instead.
   *
   * The guard SKIPS the fold rather than dispatching the comparator here, so
   * NULL placement stays decided in one place ({@link compareTo}) — a comparator
   * is never handed a NULL by either road.
   */
  compareToCase(other: Value, sensitive: boolean): number {
    const folds = !sensitive && typeof this.raw === 'string' && typeof other.raw === 'string';
    if (folds && effectiveComparator(this.comparator(), other.comparator()) === undefined) {
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

/**
 * The comparator in effect for ONE comparison, from what its two operands
 * DECLARE — the ordering counterpart of `effectiveCasing`, and the same
 * precedence rule for the same reason.
 *
 * A declaration is authoritative, so one operand carrying a comparator decides:
 * `version > :v` and `ORDER BY version` compare a typed cell against an untyped
 * literal / param, and that is the overwhelmingly common shape.
 *
 * TWO DIFFERENT COMPARATORS FALL BACK TO THE BUILTIN RULE rather than picking
 * one. Taking the left operand's would make the answer depend on which side of
 * the comparison a value sat — the order-dependence the meet exists to remove —
 * and there is no "stricter of the two" to take, because unlike a casing (a
 * three-member total order) two comparators are arbitrary functions with no
 * relation between them. It is reachable only for two DIFFERENT refinements
 * compared with each other, which needs a declared `comparableWith` edge and is
 * refused by the meet in any query that was validated; the fallback is the
 * behaviour such a pair already had.
 *
 * EXPORTED BECAUSE THE SQL ROAD ASKS THE SAME QUESTION. `comparisonCasing` has
 * to suppress its `LOWER()` fold on exactly the pairs {@link Value.compareToCase}
 * suppresses it for, and "exactly" means the SAME FUNCTION rather than the same
 * intent: a `left ?? right` spelling agrees with this one on every input except
 * the two-different-comparators case, where it would leave SQL case-SENSITIVE
 * while the runtime folded — a fresh divergence in the one place the fallback
 * exists to prevent one.
 */
export function effectiveComparator(
  left: ValueComparator | undefined,
  right: ValueComparator | undefined,
): ValueComparator | undefined {
  if (left === undefined) return right;
  if (right === undefined || right === left) return left;
  return undefined;
}

/**
 * A consumer comparator's answer, normalised to `-1 | 0 | 1`.
 *
 * `NaN` (a `a - b` written for numbers and handed two strings) and a
 * non-numeric answer both become `0`. That is deliberately not a refusal: this
 * is reached from `sortEntries`, `min`/`max` and every predicate, none of which
 * has a channel to report on, and a `NaN` leaking into `Array.prototype.sort`
 * produces an implementation-defined permutation — a wrong ANSWER rather than a
 * detectable failure. `checkFieldType` is where a comparator that does this is
 * caught, with the declaration in hand.
 */
function sign(n: number): number {
  if (n < 0) return -1;
  if (n > 0) return 1;
  return 0;
}

/** Whether a JSON value is a scalar (the kind a literal / cell can hold). */
export function isScalarValue(v: JsonValue): v is ScalarValue {
  return v === null || typeof v !== 'object';
}
