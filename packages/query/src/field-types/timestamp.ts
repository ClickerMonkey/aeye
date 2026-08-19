import { z } from 'zod';
import type { FieldTypeDef, TimestampFieldTypeDef, TimezonePolicy } from '../schema';
import type { SchemaOptions, ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { refinementKeySchema } from '../refinement';
import { QueryTypeError } from '../problem';
import { meetExact } from './_meet';

/** ISO datetime pattern — date with a `T` time component. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** Zod schema for the shared timezone policy (`string | true | false`). */
export function timezoneSchema(): z.ZodTypeAny {
  return z.union([
    z.string().describe('Fixed IANA timezone name (e.g. "America/New_York").'),
    z.boolean().describe('true = tz-aware, false = naive/local.'),
  ]).describe('Timezone policy.');
}

/**
 * TimestampFieldType — a date + time-of-day. `timezone` follows the shared
 * policy (`string` IANA name | `true` tz-aware | `false` naive).
 */
export class TimestampFieldType extends FieldType {
  /** Discriminant kind tag (`'timestamp'`) shared by all instances. */
  static readonly NAME = 'timestamp' as const;
  /** This instance's discriminant kind. */
  readonly kind = TimestampFieldType.NAME;

  constructor(
    /** Timezone policy: IANA name | `true` tz-aware | `false` naive. */
    readonly timezone?: TimezonePolicy,
  ) {
    super();
  }

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): TimestampFieldType {
    if (json.kind !== 'timestamp') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `TimestampFieldType.from: expected kind 'timestamp', got '${json.kind}'`,
      });
    }
    return new TimestampFieldType(json.timezone);
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(opts?: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('timestamp'),
      ...refinementKeySchema('timestamp', opts),
      timezone: timezoneSchema().optional(),
    }).meta({ aid: 'FieldType_timestamp' }).describe('Timestamp (date + time) field type.');
  }

  /** Resolve to the `timestamp` scalar comparison category. */
  resolve(): ScalarKind {
    return 'timestamp';
  }

  /**
   * Meet with another `timestamp`, or with `date` — this type is the more
   * specific of the temporal family (a value of it satisfies a `date`'s ISO
   * prefix, not the reverse), so it IS the meet of the pair, and
   * `DateFieldType.meetWith` delegates here. Timezone policies must AGREE either
   * way: a naive and a tz-aware value are not the same instant, so there is no
   * third policy that is both.
   *
   * The other side's policy is read off its JSON def rather than through an
   * `instanceof DateFieldType`, which would close an import cycle (`date.ts`
   * already imports {@link timezoneSchema} from here). The def is a
   * discriminated union, so the narrowing is a compile-time fact, not a cast.
   */
  protected override meetWith(other: FieldType): FieldType | undefined {
    const json = other.toJSON();
    if (json.kind !== 'timestamp' && json.kind !== 'date') return undefined;
    const timezone = meetExact(this.timezone, json.timezone);
    return timezone.ok ? new TimestampFieldType(timezone.value) : undefined;
  }

  /** Estimated average stored byte size. */
  protected override builtinAvgBytes(): number {
    return 8;
  }

  /** SQL column type (`timestamp` when naive, else `timestamptz`). */
  toSQLType(): string {
    return this.timezone === false ? 'timestamp' : 'timestamptz';
  }

  /** Zod schema validating an ISO timestamp (`YYYY-MM-DD HH:MM`) value. */
  protected override builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return z.string().regex(ISO_TIMESTAMP, 'expected ISO timestamp (YYYY-MM-DD HH:MM)');
  }

  /** Serialize to its JSON def (omitting `timezone` when unset). */
  /** Serialize to its JSON def, carrying any `as` refinement (see `FieldType.toJSON`). */
  override toJSON(): TimestampFieldTypeDef {
    return this.withRefinementKey(this.builtinJSON());
  }

  protected override builtinJSON(): TimestampFieldTypeDef {
    return this.timezone === undefined
      ? { kind: TimestampFieldType.NAME }
      : { kind: TimestampFieldType.NAME, timezone: this.timezone };
  }

  /** A copy of this field type. */
  /** A copy of this field type, refinement included (see `FieldType.clone`). */
  override clone(): TimestampFieldType {
    return this.sameRefinement(this.builtinClone());
  }

  protected override builtinClone(): TimestampFieldType {
    return new TimestampFieldType(this.timezone);
  }
}

const _check: FieldTypeClass = TimestampFieldType;
void _check;
