import { z } from 'zod';
import type { BoolFieldTypeDef, FieldTypeDef } from '../schema';
import type { SchemaOptions, ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { refinementKeySchema } from '../refinement';
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
  static toSchema(opts?: SchemaOptions): z.ZodTypeAny {
    return z.object({ kind: z.literal('bool'), ...refinementKeySchema('bool', opts) })
      .meta({ aid: 'FieldType_bool' })
      .describe('Boolean field type.');
  }

  /** Resolve to the `bool` scalar comparison category. */
  resolve(): ScalarKind {
    return 'bool';
  }

  /**
   * A bool admits exactly `true` and `false`, so every value it can hold is
   * already a bare SQL token — which makes it a legal type for a refinement
   * option a `sql` / `cast` template interpolates (see
   * {@link FieldType.tokenSafeValues}).
   */
  override tokenSafeValues(): boolean {
    return true;
  }

  /** Estimated average stored byte size. */
  protected override builtinAvgBytes(): number {
    return 1;
  }

  /** SQL column type for a boolean. */
  toSQLType(): string {
    return 'boolean';
  }

  /** Zod schema validating a boolean value. */
  protected override builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return z.boolean();
  }

  /** Serialize to its JSON def. */
  /** Serialize to its JSON def, carrying any `as` refinement (see `FieldType.toJSON`). */
  override toJSON(): BoolFieldTypeDef {
    return this.withRefinementKey(this.builtinJSON());
  }

  protected override builtinJSON(): BoolFieldTypeDef {
    return { kind: BoolFieldType.NAME };
  }

  /** A copy of this field type. */
  /** A copy of this field type, refinement included (see `FieldType.clone`). */
  override clone(): BoolFieldType {
    return this.sameRefinement(this.builtinClone());
  }

  protected override builtinClone(): BoolFieldType {
    return new BoolFieldType();
  }
}

const _check: FieldTypeClass = BoolFieldType;
void _check;
