import { z } from 'zod';
import type { FieldTypeDef, TimestampFieldTypeDef, TimezonePolicy } from '../schema';
import type { ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';
import { catalogForFieldType, type FilterOp } from '../filters';

/** Filter operators valid on temporal fields (date / timestamp). Shared. */
export const TEMPORAL_FILTER_OPS: readonly string[] = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'between', 'isNull', 'notNull',
];

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
  static toSchema(): z.ZodTypeAny {
    return z.object({
      kind: z.literal('timestamp'),
      timezone: timezoneSchema().optional(),
    }).meta({ aid: 'FieldType_timestamp' }).describe('Timestamp (date + time) field type.');
  }

  /** Resolve to the `timestamp` scalar comparison category. */
  resolve(): ScalarKind {
    return 'timestamp';
  }

  /** The filter operators valid on timestamp fields. */
  filterOps(): FilterOp[] {
    return catalogForFieldType(this);
  }

  /** Estimated average stored byte size. */
  avgBytes(): number {
    return 8;
  }

  /** SQL column type (`timestamp` when naive, else `timestamptz`). */
  toSQLType(): string {
    return this.timezone === false ? 'timestamp' : 'timestamptz';
  }

  /** Zod schema validating an ISO timestamp (`YYYY-MM-DD HH:MM`) value. */
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return z.string().regex(ISO_TIMESTAMP, 'expected ISO timestamp (YYYY-MM-DD HH:MM)');
  }

  /** Serialize to its JSON def (omitting `timezone` when unset). */
  toJSON(): TimestampFieldTypeDef {
    return this.timezone === undefined
      ? { kind: TimestampFieldType.NAME }
      : { kind: TimestampFieldType.NAME, timezone: this.timezone };
  }

  /** A copy of this field type. */
  clone(): TimestampFieldType {
    return new TimestampFieldType(this.timezone);
  }
}

const _check: FieldTypeClass = TimestampFieldType;
void _check;
