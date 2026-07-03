import { z } from 'zod';
import type { FieldTypeDef, NumberFieldTypeDef, NumberOptions } from '../schema';
import type { ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';

/**
 * Zod schema for a `NumberOptions` bag — reused by `money`'s nested numeric
 * configuration. Each field carries LLM-oriented `.describe()` guidance so
 * the model only sets a bound when it is genuinely part of the spec.
 */
export function numberOptionsSchema(): z.ZodTypeAny {
  return z.object({
    min: z.number().optional().describe('Real lower bound only (e.g. age → 0). Do not add 0 reflexively.'),
    max: z.number().optional().describe('Real upper bound only (e.g. percentage → 100).'),
    whole: z.boolean().optional().describe('True only when genuinely integral (counts, ids).'),
    minPlaces: z.number().int().optional().describe('Decimal-place floor; omit unless required.'),
    maxPlaces: z.number().int().optional().describe('Decimal-place ceiling; omit unless required.'),
  });
}

/** Strip `undefined` entries from a NumberOptions bag for clean JSON. */
export function compactNumberOptions(o: NumberOptions): NumberOptions {
  const out: NumberOptions = {};
  if (o.min !== undefined) out.min = o.min;
  if (o.max !== undefined) out.max = o.max;
  if (o.whole !== undefined) out.whole = o.whole;
  if (o.minPlaces !== undefined) out.minPlaces = o.minPlaces;
  if (o.maxPlaces !== undefined) out.maxPlaces = o.maxPlaces;
  return out;
}

/** Build a value-side Zod number schema honoring a NumberOptions bag. */
export function numberValueSchema(o: NumberOptions): z.ZodTypeAny {
  let s = o.whole ? z.number().int() : z.number();
  if (o.min !== undefined) s = s.min(o.min);
  if (o.max !== undefined) s = s.max(o.max);
  return s;
}

/**
 * NumberFieldType — a numeric field with optional min/max bounds, integer
 * constraint, and decimal-place bounds.
 */
export class NumberFieldType extends FieldType {
  /** Discriminant kind tag (`'number'`) shared by all instances. */
  static readonly NAME = 'number' as const;
  /** This instance's discriminant kind. */
  readonly kind = NumberFieldType.NAME;

  constructor(
    /** Bounds / integer / decimal-place constraints for this number. */
    readonly options: NumberOptions = {},
  ) {
    super();
  }

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): NumberFieldType {
    if (json.kind !== 'number') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `NumberFieldType.from: expected kind 'number', got '${json.kind}'`,
      });
    }
    const { min, max, whole, minPlaces, maxPlaces } = json;
    return new NumberFieldType(compactNumberOptions({ min, max, whole, minPlaces, maxPlaces }));
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(): z.ZodTypeAny {
    return z.object({
      kind: z.literal('number'),
      min: z.number().optional().describe('Real lower bound only (e.g. age → 0). Do not add 0 reflexively.'),
      max: z.number().optional().describe('Real upper bound only (e.g. percentage → 100).'),
      whole: z.boolean().optional().describe('True only when genuinely integral (counts, ids).'),
      minPlaces: z.number().int().optional().describe('Decimal-place floor; omit unless required.'),
      maxPlaces: z.number().int().optional().describe('Decimal-place ceiling; omit unless required.'),
    }).meta({ aid: 'FieldType_number' }).describe('Numeric field type.');
  }

  /** Resolve to the `number` scalar comparison category. */
  resolve(): ScalarKind {
    return 'number';
  }

  /** Estimated average stored byte size. */
  avgBytes(): number {
    return 8;
  }

  /** SQL column type (`integer` when whole, else `numeric`). */
  toSQLType(): string {
    return this.options.whole ? 'integer' : 'numeric';
  }

  /** Zod schema validating a number value, honoring the options. */
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return numberValueSchema(this.options);
  }

  /** Serialize to its JSON def (flattening the compacted options). */
  toJSON(): NumberFieldTypeDef {
    return { kind: NumberFieldType.NAME, ...compactNumberOptions(this.options) };
  }

  /** A copy of this field type (cloning the options bag). */
  clone(): NumberFieldType {
    return new NumberFieldType({ ...this.options });
  }
}

// Compile-time assertion that the class satisfies the static contract.
const _check: FieldTypeClass = NumberFieldType;
void _check;
