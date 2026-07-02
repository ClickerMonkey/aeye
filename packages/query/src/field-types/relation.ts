import { z } from 'zod';
import type { FieldTypeDef, RelationFieldTypeDef } from '../schema';
import type { ValueSchemaOptions } from '../node';
import type { Type } from '../type';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';
import { catalogForFieldType, type FilterOp } from '../filters';

/** Filter operators valid on relation fields. */
export const RELATION_FILTER_OPS: readonly string[] = ['exists', 'notExists', 'anyMatch'];

/**
 * Resolved join key for a relation, relative to the two Types a join relates:
 *  - `localField`   — the matched field on the SOURCE (this) side.
 *  - `foreignField` — the matched field on the TARGET side.
 * The join predicate is `source.localField = target.foreignField`.
 */
export interface RelationKey {
  /** The matched field on the SOURCE (this) side of the join. */
  localField: string;
  /** The matched field on the TARGET side of the join. */
  foreignField: string;
}

/** Lowercase the first character (`User` → `user`) for the FK default. */
function camelHead(name: string): string {
  /* v8 ignore next -- defensive empty-name guard; a registered Type always has a non-empty name */
  return name.length > 0 ? name[0]!.toLowerCase() + name.slice(1) : name;
}

/**
 * RelationFieldType — a link to another Type. `to` names the target type and
 * `count` is the expected cardinality.
 *
 * CONVENTION: a relation field's NAME is the key for all purposes. There are
 * no exposed foreign-key fields — `owns` (FK on THIS type, "belongs-to") is
 * INFERRED as `count === 1`; `count > 1` ⇒ has-many (FK on the target). See
 * `resolveKey`.
 *
 * `inverseRelation`, when set on a belongs-to relation, asks the registry to
 * materialize a one-to-many relation of that name back on the TARGET Type.
 * `inverseVia` is the INTERNAL pointer such a materialized inverse carries: the
 * name of the forward (belongs-to) relation field whose FK it should reuse. It
 * is never part of the JSON Def, never serialized, and never in `toSchema`.
 */
export class RelationFieldType extends FieldType {
  /** Discriminant kind tag (`'relation'`) shared by all instances. */
  static readonly NAME = 'relation' as const;
  /** This instance's discriminant kind. */
  readonly kind = RelationFieldType.NAME;

  constructor(
    /** Name of the target Type this relation points to. */
    readonly to: string,
    /** Expected related-row cardinality; `1` = belongs-to, `>1` = has-many. */
    readonly count: number,
    /** Public: materialize an inverse has-many of this name on the target. */
    readonly inverseRelation?: string,
    /** INTERNAL: the forward relation field name a materialized inverse reuses. */
    readonly inverseVia?: string,
  ) {
    super();
  }

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): RelationFieldType {
    if (json.kind !== 'relation') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `RelationFieldType.from: expected kind 'relation', got '${json.kind}'`,
      });
    }
    return new RelationFieldType(json.to, json.count, json.inverseRelation);
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(): z.ZodTypeAny {
    return z.object({
      kind: z.literal('relation'),
      to: z.string().describe('Name of the target Type this relation points to.'),
      count: z.number().describe('Expected related-row cardinality; 1 = belongs-to, >1 = has-many.'),
      inverseRelation: z
        .string()
        .optional()
        .describe('If set, the target Type gains a one-to-many relation of this name pointing back.'),
    }).meta({ aid: 'FieldType_relation' }).describe('Relation (foreign-key) field type.');
  }

  /**
   * Resolve the join key for this relation, given the relation field's NAME and
   * the two Types it relates. The relation field's NAME is the key:
   *  - belongs-to (`count === 1`): `this.<relName> = target.<identity>` —
   *    the local relation field holds the target's identity value.
   *  - has-many  (`count > 1`):    `this.<identity> = target.<fk>` — where the
   *    FK on the target is `inverseVia` (for a materialized inverse) else the
   *    declaring Type's name in camelCase.
   */
  resolveKey(relationFieldName: string, thisType: Type, targetType: Type): RelationKey {
    if (this.count === 1) {
      return {
        localField: relationFieldName,
        foreignField: targetType.identityField().name,
      };
    }
    const fk = this.inverseVia ?? camelHead(thisType.name);
    return {
      localField: thisType.identityField().name,
      foreignField: fk,
    };
  }

  /** Resolve to the `relation` scalar comparison category. */
  resolve(): ScalarKind {
    return 'relation';
  }

  /** A relation is only comparable with another relation to the same Type. */
  override comparableWith(other: FieldType): boolean {
    return other instanceof RelationFieldType && other.to === this.to;
  }

  /** The filter operators valid on relation fields. */
  filterOps(): FilterOp[] {
    return catalogForFieldType(this);
  }

  /** Estimated average stored byte size (a short id string). */
  avgBytes(): number {
    // Foreign-key identifier — roughly a short id string.
    return 16;
  }

  /** SQL column type for the stored identifier reference. */
  toSQLType(): string {
    // Relations are stored as identifier references.
    return 'text';
  }

  /** Zod schema validating a relation value (the related row's identifier). */
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    // The value of a relation field is the related row's identifier.
    return z.string();
  }

  /** Serialize to its JSON def (`inverseVia` is internal, never emitted). */
  toJSON(): RelationFieldTypeDef {
    // `inverseVia` is internal materialization state, never serialized.
    const def: RelationFieldTypeDef = { kind: RelationFieldType.NAME, to: this.to, count: this.count };
    if (this.inverseRelation !== undefined) def.inverseRelation = this.inverseRelation;
    return def;
  }

  /** A copy of this relation (preserving internal `inverseVia`). */
  clone(): RelationFieldType {
    return new RelationFieldType(this.to, this.count, this.inverseRelation, this.inverseVia);
  }
}

const _check: FieldTypeClass = RelationFieldType;
void _check;
