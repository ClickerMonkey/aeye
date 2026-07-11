import { z } from 'zod';
import type { BoolFieldTypeDef, FieldTypeDef } from '../schema';
import type { ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';

/** BoolFieldType — a boolean field. Carries no options. */
export class BoolFieldType extends FieldType {
  /** Discriminant kind tag (`'bool'`) shared by all instances. */
  static readonly NAME = 'bool' as const;
  /** This instance's discriminant kind. */
  readonly kind = BoolFieldType.NAME;

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): BoolFieldType {
    if (json.kind !== 'bool') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `BoolFieldType.from: expected kind 'bool', got '${json.kind}'`,
      });
    }
    return new BoolFieldType();
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(): z.ZodTypeAny {
    return z.object({ kind: z.literal('bool') })
      .meta({ aid: 'FieldType_bool' })
      .describe('Boolean field type.');
  }

  /** Resolve to the `bool` scalar comparison category. */
  resolve(): ScalarKind {
    return 'bool';
  }

  /** Estimated average stored byte size. */
  avgBytes(): number {
    return 1;
  }

  /** SQL column type for a boolean. */
  toSQLType(): string {
    return 'boolean';
  }

  /** Zod schema validating a boolean value. */
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return z.boolean();
  }

  /** Serialize to its JSON def. */
  toJSON(): BoolFieldTypeDef {
    return { kind: BoolFieldType.NAME };
  }

  /** A copy of this field type. */
  clone(): BoolFieldType {
    return new BoolFieldType();
  }
}

const _check: FieldTypeClass = BoolFieldType;
void _check;
