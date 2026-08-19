import { z } from 'zod';
import type { DateFieldTypeDef, FieldTypeDef, TimezonePolicy } from '../schema';
import type { SchemaOptions, ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { refinementKeySchema } from '../refinement';
import { QueryTypeError } from '../problem';
import { meetExact } from './_meet';
import { timezoneSchema } from './timestamp';

/** ISO calendar-date pattern (YYYY-MM-DD, optionally with more). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/**
 * DateFieldType — a calendar date (no time-of-day). `timezone` follows the
 * shared policy (`string` IANA name | `true` tz-aware | `false` naive).
 */
export class DateFieldType extends FieldType {
  /** Discriminant kind tag (`'date'`) shared by all instances. */
  static readonly NAME = 'date' as const;
  /** This instance's discriminant kind. */
  readonly kind = DateFieldType.NAME;

  constructor(
    /** Timezone policy: IANA name | `true` tz-aware | `false` naive. */
    readonly timezone?: TimezonePolicy,
  ) {
    super();
  }

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): DateFieldType {
    if (json.kind !== 'date') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `DateFieldType.from: expected kind 'date', got '${json.kind}'`,
      });
    }
    return new DateFieldType(json.timezone);
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(opts?: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('date'),
      ...refinementKeySchema('date', opts),
      timezone: timezoneSchema().optional(),
    }).meta({ aid: 'FieldType_date' }).describe('Calendar-date field type.');
  }

  /** Resolve to the `date` scalar comparison category. */
  resolve(): ScalarKind {
    return 'date';
  }

  /**
   * Meet with another `date` (timezone policies must AGREE — a naive and a
   * tz-aware value are not the same instant) or with `timestamp`, which is the
   * more specific side of the temporal family and answers for both: an ISO
   * timestamp satisfies this type's date schema, but not the reverse.
   */
  protected override meetWith(other: FieldType): FieldType | undefined {
    if (other instanceof DateFieldType) {
      const timezone = meetExact(this.timezone, other.timezone);
      return timezone.ok ? new DateFieldType(timezone.value) : undefined;
    }
    return other.resolve() === 'timestamp' ? other.meet(this) : undefined;
  }

  /** Estimated average stored byte size. */
  protected override builtinAvgBytes(): number {
    return 4;
  }

  /** SQL column type for a calendar date. */
  toSQLType(): string {
    return 'date';
  }

  /** Zod schema validating an ISO date (`YYYY-MM-DD`) value. */
  protected override builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return z.string().regex(ISO_DATE, 'expected ISO date (YYYY-MM-DD)');
  }

  /** Serialize to its JSON def (omitting `timezone` when unset). */
  /** Serialize to its JSON def, carrying any `as` refinement (see `FieldType.toJSON`). */
  override toJSON(): DateFieldTypeDef {
    return this.withRefinementKey(this.builtinJSON());
  }

  protected override builtinJSON(): DateFieldTypeDef {
    return this.timezone === undefined
      ? { kind: DateFieldType.NAME }
      : { kind: DateFieldType.NAME, timezone: this.timezone };
  }

  /** A copy of this field type. */
  /** A copy of this field type, refinement included (see `FieldType.clone`). */
  override clone(): DateFieldType {
    return this.sameRefinement(this.builtinClone());
  }

  protected override builtinClone(): DateFieldType {
    return new DateFieldType(this.timezone);
  }
}

const _check: FieldTypeClass = DateFieldType;
void _check;
