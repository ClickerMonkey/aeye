import { z } from 'zod';
import type { FieldTypeDef, FieldValueDef, NumberFieldTypeDef, NumberOptions } from '../schema';
import { fieldValuesSchema, closedSetValueSchema, compactFieldValues, meetFieldValues, narrowFieldValues } from './_values';
import { meetFlag, meetLower, meetUpper, emptyRange } from './_meet';
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
    values: fieldValuesSchema(),
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
  const values = compactFieldValues(o.values);
  if (values) out.values = values;
  return out;
}

/**
 * A value-side Zod schema for a numeric bag's SCALAR CONSTRAINTS alone — bounds
 * + integrality, ignoring any closed set. Split out from
 * {@link numberValueSchema} (which short-circuits on the closed set) so a MEET
 * can narrow a merged set by the merged constraints; see `_values.ts`.
 */
export function numberConstraintSchema(o: NumberOptions): z.ZodTypeAny {
  let s = o.whole ? z.number().int() : z.number();
  if (o.min !== undefined) s = s.min(o.min);
  if (o.max !== undefined) s = s.max(o.max);
  return s;
}

/** Build a value-side Zod number schema honoring a NumberOptions bag. */
export function numberValueSchema(o: NumberOptions): z.ZodTypeAny {
  // A closed set IS the value schema — the bounds it composes with are already
  // satisfied (or violated) by the declared members themselves.
  return closedSetValueSchema(o.values) ?? numberConstraintSchema(o);
}

/**
 * The MEET of two `NumberOptions` bags — bounds tighten, `whole` ORs, decimal
 * places tighten, and the closed sets intersect (then narrow by the merged
 * constraints). `undefined` when no numeric value satisfies both. Shared by
 * `number` and by `money`, whose constraint is exactly this bag.
 */
export function meetNumberOptions(a: NumberOptions, b: NumberOptions): NumberOptions | undefined {
  const min = meetLower(a.min, b.min);
  const max = meetUpper(a.max, b.max);
  if (emptyRange(min, max)) return undefined;
  const minPlaces = meetLower(a.minPlaces, b.minPlaces);
  const maxPlaces = meetUpper(a.maxPlaces, b.maxPlaces);
  if (emptyRange(minPlaces, maxPlaces)) return undefined;
  const values = meetFieldValues(a.values, b.values);
  if (!values.ok) return undefined;
  const merged = compactNumberOptions({
    min,
    max,
    whole: meetFlag(a.whole, b.whole),
    minPlaces,
    maxPlaces,
    values: values.value,
  });
  if (merged.values) {
    const constraints = numberConstraintSchema(merged);
    const kept = narrowFieldValues(merged.values, (v) => constraints.safeParse(v).success);
    if (kept.length === 0) return undefined;
    merged.values = kept;
  }
  return merged;
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
    const { min, max, whole, minPlaces, maxPlaces, values } = json;
    return new NumberFieldType(compactNumberOptions({ min, max, whole, minPlaces, maxPlaces, values }));
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
      values: fieldValuesSchema(),
    }).meta({ aid: 'FieldType_number' }).describe('Numeric field type.');
  }

  /** Resolve to the `number` scalar comparison category. */
  resolve(): ScalarKind {
    return 'number';
  }

  /** The closed set this number may hold, when one is declared (drives `eqSelectivity`, membership, the meet). */
  override values(): readonly FieldValueDef[] | undefined {
    return this.options.values;
  }

  /**
   * Meet with another `number` (bounds / integrality / closed set reconciled by
   * {@link meetNumberOptions}), or with `money` — which is the more specific of
   * the pair `comparableWith` calls mutually numeric, so it answers for both.
   */
  protected override meetWith(other: FieldType): FieldType | undefined {
    if (other instanceof NumberFieldType) {
      const merged = meetNumberOptions(this.options, other.options);
      return merged === undefined ? undefined : new NumberFieldType(merged);
    }
    // `money` carries a currency this type cannot express, so it is the narrower
    // side of the numeric family and owns the merge (see `MoneyFieldType.meetWith`).
    return other.resolve() === 'money' ? other.meet(this) : undefined;
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

  /** A copy of this field type (deep-cloning the options bag's value set). */
  clone(): NumberFieldType {
    return new NumberFieldType({ ...this.options, values: this.options.values?.map((v) => ({ ...v })) });
  }
}

// Compile-time assertion that the class satisfies the static contract.
const _check: FieldTypeClass = NumberFieldType;
void _check;
