import { z } from 'zod';
import type { ArrayFieldTypeDef, FieldTypeDef, JsonValue } from '../schema';
import type { ClosedSetViolation } from './_values';
import type { ValueSchemaOptions } from '../node';
import type { Registry } from '../registry';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';
import { emptyRange, meetLower, meetUpper } from './_meet';
import { jsonValueSchema } from './json';
import { fieldTypeDefSchema } from './index';

/**
 * Average element count assumed for an UNBOUNDED array (no min/max declared),
 * and the per-element byte estimate used when the element type is unknown.
 * Both are deliberately conservative midpoints for cost estimation only.
 */
const DEFAULT_AVG_ITEMS = 4;
const UNKNOWN_ITEM_BYTES = 16;

/**
 * ArrayFieldType — an ordered collection field. Holds optional element-count
 * bounds (`minItems` / `maxItems`) and an optional parsed element `item`
 * FieldType. When `item` is absent the array is heterogeneous (any JSON value
 * is a valid element). Because `item` is itself a FieldType, arrays nest.
 *
 * It resolves to the `array` scalar category — comparable only with other
 * array types (optionally requiring compatible element types). The neutral
 * `toSQLType()` is left generic; real array column types are produced by the
 * dialects (`Dialect.sqlTypeFor`), exactly as for every other field type.
 */
export class ArrayFieldType extends FieldType {
  /** Discriminant kind tag (`'array'`) shared by all instances. */
  static readonly NAME = 'array' as const;
  /** This instance's discriminant kind. */
  readonly kind = ArrayFieldType.NAME;

  constructor(
    /** Element field type, or `undefined` for heterogeneous elements. */
    readonly item?: FieldType,
    /** Minimum element count; `undefined` when unbounded below. */
    readonly minItems?: number,
    /** Maximum element count; `undefined` when unbounded above. */
    readonly maxItems?: number,
  ) {
    super();
  }

  /** Reconstruct from a JSON def, parsing the element type via the registry. */
  static from(json: FieldTypeDef, registry?: Registry): ArrayFieldType {
    if (json.kind !== 'array') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `ArrayFieldType.from: expected kind 'array', got '${json.kind}'`,
      });
    }
    // The element type is a nested FieldTypeDef; parse it through the registry
    // (the same composite-parsing seam every other nested ref uses). When no
    // registry is supplied (a bare `Cls.from(def)` in tests), an element def is
    // not reconstructable, so a typed item is only attached when a registry is
    // available — mirroring how the Registry always calls `from(json, this)`.
    const item = json.item !== undefined && registry ? registry.parseFieldType(json.item) : undefined;
    return new ArrayFieldType(item, json.minItems, json.maxItems);
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(): z.ZodTypeAny {
    // The element type references the WHOLE field-type union recursively, so
    // wrap it in `z.lazy` (like `json`'s recursive value schema) to break the
    // build-time cycle `array → fieldTypeDefSchema → array`.
    const item = z.lazy(() => fieldTypeDefSchema());
    return z.object({
      kind: z.literal('array'),
      minItems: z.number().int().optional().describe('Minimum element count (e.g. non-empty → 1).'),
      maxItems: z.number().int().optional().describe('Maximum element count; omit when unbounded.'),
      item: item.optional().describe('Element field type; omit for heterogeneous / unknown elements.'),
    }).meta({ aid: 'FieldType_array' }).describe('Ordered collection (array) field type.');
  }

  /** Resolve to the `array` scalar comparison category. */
  resolve(): ScalarKind {
    return 'array';
  }

  /**
   * Arrays compare only with other arrays. When BOTH sides declare an element
   * type, the element types must themselves be comparable; an unknown element
   * type on either side is treated as compatible (no constraint to enforce).
   */
  override comparableWith(other: FieldType): boolean {
    if (!(other instanceof ArrayFieldType)) return false;
    if (this.item && other.item) return this.item.comparableWith(other.item);
    return true;
  }

  /**
   * The first closed-set violation among the ELEMENTS. An array declares no set
   * of its own (see `FieldType.values`), but its item type may — and writing
   * `['bogus']` into an `array<text one of a|b>` is exactly as wrong as writing
   * `'bogus'` into the scalar column. It was silently ACCEPTED, while this very
   * type's `toValueSchema()` rejected the same array. Recurses, so an
   * `array<array<text one of …>>` reports the whole index path.
   *
   * A non-array `raw` is not this check's business: writing a scalar to an array
   * column is a CATEGORY error, refused earlier as `write.type`.
   */
  override closedSetViolation(raw: JsonValue): ClosedSetViolation | undefined {
    if (!this.item || !Array.isArray(raw)) return undefined;
    for (let i = 0; i < raw.length; i++) {
      const inner = this.item.closedSetViolation(raw[i]!);
      if (inner) return { at: [i, ...inner.at], value: inner.value, values: inner.values };
    }
    return undefined;
  }

  /**
   * Meet with another `array`: element counts tighten and the ELEMENT types meet
   * recursively. An unknown element type on either side is TOP (no constraint),
   * so it adopts the other's — the same asymmetry `comparableWith` already
   * applies, made constructive.
   */
  protected override meetWith(other: FieldType): FieldType | undefined {
    if (!(other instanceof ArrayFieldType)) return undefined;
    const minItems = meetLower(this.minItems, other.minItems);
    const maxItems = meetUpper(this.maxItems, other.maxItems);
    if (emptyRange(minItems, maxItems)) return undefined;
    if (!this.item || !other.item) return new ArrayFieldType((this.item ?? other.item)?.clone(), minItems, maxItems);
    const item = this.item.meet(other.item);
    return item === undefined ? undefined : new ArrayFieldType(item, minItems, maxItems);
  }

  /** Estimated average stored byte size (midpoint count × per-element bytes). */
  avgBytes(): number {
    // Estimate ~midpoint element count × per-element bytes. When unbounded,
    // assume a small constant; when the element type is unknown, a flat
    // per-element estimate.
    const lo = this.minItems ?? 0;
    const hi = this.maxItems ?? lo + DEFAULT_AVG_ITEMS;
    const avgItems = Math.max(1, Math.round((lo + hi) / 2));
    const perItem = this.item ? this.item.avgBytes() : UNKNOWN_ITEM_BYTES;
    return Math.max(8, avgItems * perItem);
  }

  /** Neutral SQL column type; dialects produce the real array type. */
  toSQLType(): string {
    // Neutral fallback only — the dialects own the real array column type
    // (e.g. Postgres `text[]`). See `Dialect.sqlTypeFor`.
    return 'json';
  }

  /** Zod schema validating an array value, honoring element type and bounds. */
  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Each element is validated against the element type when known, else
    // against the permissive JSON-value schema (NO `z.any()`).
    let s = z.array(this.item ? this.item.toValueSchema(opts) : jsonValueSchema());
    if (this.minItems !== undefined) s = s.min(this.minItems);
    if (this.maxItems !== undefined) s = s.max(this.maxItems);
    return s;
  }

  /** Serialize to its JSON def (recursing into the element type). */
  toJSON(): ArrayFieldTypeDef {
    const def: ArrayFieldTypeDef = { kind: ArrayFieldType.NAME };
    if (this.minItems !== undefined) def.minItems = this.minItems;
    if (this.maxItems !== undefined) def.maxItems = this.maxItems;
    if (this.item) def.item = this.item.toJSON();
    return def;
  }

  /** A deep copy (cloning the element type). */
  clone(): ArrayFieldType {
    return new ArrayFieldType(this.item?.clone(), this.minItems, this.maxItems);
  }

  /** A compact source-like rendering, e.g. `array<text>` or `array`. */
  override toCode(): string {
    return this.item ? `array<${this.item.toCode()}>` : 'array';
  }
}

const _check: FieldTypeClass = ArrayFieldType;
void _check;
