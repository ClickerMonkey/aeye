/**
 * Abstract `FieldType` base class + the `FieldTypeClass` static contract.
 *
 * Mirrors gin's `Type`/`type.ts` canonical shape (`static NAME` / `static
 * from` / `static toSchema`, instance `toJSON` / `toValueSchema` / `clone`)
 * but specialized for a query language's field types. A FieldType is a
 * pure *value category* — it never carries nullability (that lives on the
 * `Field` wrapping it) and never holds engine/runtime state.
 *
 * Subclasses (one file each under `field-types/`) implement the 8 builtin
 * kinds. Dispatch from JSON happens in the `Registry` via a `kind → class`
 * map — never a central switch in this file.
 */
import type { z } from 'zod';
import type { FieldTypeDef, FieldTypeKind, JsonValue } from './schema';
import type { CodeOptions, Node, SchemaOptions, ValueSchemaOptions } from './node';
import type { Registry } from './registry';
import type { FilterOp } from './filters';

/**
 * The underlying primitive category a field type resolves to. This is the
 * comparability / SQL-bucket of the type, distinct from the richer `kind`
 * (e.g. both `number` and `money` are numeric, but `money` is its own
 * kind). Used by `comparableWith`, cost estimation, and SQL emission.
 */
export type ScalarKind =
  | 'number'
  | 'text'
  | 'bool'
  | 'date'
  | 'timestamp'
  | 'json'
  | 'money'
  | 'relation'
  | 'array';

/** Categories considered mutually numeric for comparison purposes. */
const NUMERIC_KINDS: ReadonlySet<ScalarKind> = new Set<ScalarKind>(['number', 'money']);
/** Categories considered mutually temporal for comparison purposes. */
const TEMPORAL_KINDS: ReadonlySet<ScalarKind> = new Set<ScalarKind>(['date', 'timestamp']);

/**
 * Static-side contract every concrete FieldType class satisfies, so the
 * Registry can dispatch JSON parsing by `kind`. Analogous to gin's
 * `TypeClass`.
 */
export interface FieldTypeClass {
  /** The `kind` discriminant this class handles (e.g. `'number'`). */
  readonly NAME: FieldTypeKind;
  /**
   * Build an instance from its JSON branch. Receives the full union for a
   * uniform signature; implementations narrow on `kind` (a type guard, no
   * cast) and reject mismatches. The optional `registry` is supplied by
   * `Registry.parseFieldType` so COMPOSITE field types (e.g. `array`, whose
   * `item` is itself a `FieldTypeDef`) can reconstruct their nested children;
   * scalar field types ignore it.
   */
  from(json: FieldTypeDef, registry?: Registry): FieldType;
  /** Zod schema for this field type's JSON `*FieldTypeDef` branch. */
  toSchema(opts?: SchemaOptions): z.ZodTypeAny;
}

/**
 * Abstract base for all field types. Concrete subclasses store their own
 * strongly-typed options object and implement the abstract members below.
 */
export abstract class FieldType implements Node {
  /** The `kind` discriminant (matches the subclass's `static NAME`). */
  abstract readonly kind: FieldTypeKind;

  // ─── JSON round-trip ──────────────────────────────────────────────────

  /** Serialize to the matching `*FieldTypeDef` JSON branch. */
  abstract toJSON(): FieldTypeDef;

  /** Deep-copy this field type. */
  abstract clone(): FieldType;

  // ─── Category / comparability ─────────────────────────────────────────

  /** The underlying primitive category this type resolves to. */
  abstract resolve(): ScalarKind;

  /**
   * Whether a value of this type can be meaningfully compared with one of
   * `other`. Default: same category, with number/money and date/timestamp
   * treated as mutually comparable families. Subclasses may override for
   * stricter or looser rules.
   */
  comparableWith(other: FieldType): boolean {
    const a = this.resolve();
    const b = other.resolve();
    if (a === b) return true;
    if (NUMERIC_KINDS.has(a) && NUMERIC_KINDS.has(b)) return true;
    if (TEMPORAL_KINDS.has(a) && TEMPORAL_KINDS.has(b)) return true;
    return false;
  }

  /**
   * Whether TEXTUAL matching / comparison on a value of this type is
   * CASE-SENSITIVE. Default false (case-insensitive); only `text` fields
   * flagged `sensitive` override this to `true`. Non-text types never do
   * case-folding, so the value is moot for them.
   */
  textCaseSensitive(): boolean {
    return false;
  }

  // ─── Value validation / schema ────────────────────────────────────────

  /**
   * Zod schema for a raw JS VALUE of this field type, honoring options
   * (e.g. number min/max/int, text length/pattern). Distinct from the
   * static `toSchema`, which schemas the JSON *definition*.
   */
  abstract toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny;

  /**
   * Whether `raw` is a valid value of this type. Default: delegate to
   * `toValueSchema`. Subclasses rarely need to override.
   */
  validValue(raw: JsonValue): boolean {
    return this.toValueSchema().safeParse(raw).success;
  }

  // ─── Filter operator catalog ──────────────────────────────────────────

  /**
   * The `FilterOp[]` catalog applicable to this field type — each op knows
   * how to compile a filter clause to a boolean expr and how to schema its
   * operand(s). Concrete subclasses override to delegate to
   * `catalogForFieldType(this)` (see `filters.ts`); the base returns none.
   */
  filterOps(): FilterOp[] {
    return [];
  }

  // ─── Cost / storage ───────────────────────────────────────────────────

  /** Estimated average bytes a value of this type occupies. */
  abstract avgBytes(): number;

  // ─── SQL ──────────────────────────────────────────────────────────────

  /**
   * A neutral base SQL type name for this field type. Phase 5 dialects may
   * override per-dialect; to avoid a phase-5 dependency this signature
   * takes no dialect and returns a generic ANSI-ish type string.
   */
  abstract toSQLType(): string;

  // ─── Node ─────────────────────────────────────────────────────────────

  /** Short readable description — the kind plus any salient options. */
  toCode(_registry?: Registry, _options?: CodeOptions): string {
    return this.kind;
  }
}
