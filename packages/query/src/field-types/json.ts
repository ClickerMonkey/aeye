import { z } from 'zod';
import type { FieldTypeDef, JsonFieldTypeDef, JsonValue } from '../schema';
import type { ValueSchemaOptions } from '../node';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { QueryTypeError } from '../problem';
import { meetExact, sameJson } from './_meet';

/** A recursive Zod schema matching any JSON value. */
export function jsonValueSchema(): z.ZodType<JsonValue> {
  const schema: z.ZodType<JsonValue> = z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(schema),
      z.record(z.string(), schema),
    ]),
  );
  return schema;
}

/**
 * JsonFieldType — an opaque JSON-document field. An optional `schema`
 * (JSON-Schema-shaped) can describe the expected document; Phase 1 stores
 * it verbatim and validates values as any JSON.
 */
export class JsonFieldType extends FieldType {
  /** Discriminant kind tag (`'json'`) shared by all instances. */
  static readonly NAME = 'json' as const;
  /** This instance's discriminant kind. */
  readonly kind = JsonFieldType.NAME;

  constructor(
    /** Optional JSON-Schema-shaped constraint describing the document. */
    readonly schema?: JsonValue,
  ) {
    super();
  }

  /** Reconstruct from a JSON def (throws on a kind mismatch). */
  static from(json: FieldTypeDef): JsonFieldType {
    if (json.kind !== 'json') {
      throw new QueryTypeError({
        path: [], code: 'field-type.mismatch', severity: 'error',
        message: `JsonFieldType.from: expected kind 'json', got '${json.kind}'`,
      });
    }
    return new JsonFieldType(json.schema);
  }

  /** The Zod schema for this field type's JSON def. */
  static toSchema(): z.ZodTypeAny {
    return z.object({
      kind: z.literal('json'),
      schema: jsonValueSchema().optional().describe('Optional JSON-Schema-shaped constraint.'),
    }).meta({ aid: 'FieldType_json' }).describe('JSON-document field type.');
  }

  /** Resolve to the `json` scalar comparison category. */
  resolve(): ScalarKind {
    return 'json';
  }

  /** JSON only compares meaningfully with other JSON. */
  override comparableWith(other: FieldType): boolean {
    return other.resolve() === 'json';
  }

  /**
   * Meet with another `json`. The optional `schema` is a single-valued
   * constraint this package stores verbatim and cannot intersect, so two
   * DIFFERENT schemas conflict rather than silently picking one; an absent
   * schema constrains nothing and adopts the other's.
   */
  protected override meetWith(other: FieldType): FieldType | undefined {
    if (!(other instanceof JsonFieldType)) return undefined;
    const schema = meetExact(this.schema, other.schema, sameJson);
    return schema.ok ? new JsonFieldType(schema.value) : undefined;
  }

  /** Estimated average stored byte size. */
  avgBytes(): number {
    return 128;
  }

  /** SQL column type for a JSON document. */
  toSQLType(): string {
    return 'jsonb';
  }

  /** Zod schema validating any JSON value. */
  toValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    return jsonValueSchema();
  }

  /** Serialize to its JSON def (omitting `schema` when unset). */
  toJSON(): JsonFieldTypeDef {
    return this.schema === undefined
      ? { kind: JsonFieldType.NAME }
      : { kind: JsonFieldType.NAME, schema: this.schema };
  }

  /** A deep copy, structurally cloning the optional `schema` data. */
  clone(): JsonFieldType {
    // JSON schema is plain data; deep-clone via structured round-trip.
    const cloned: JsonValue | undefined =
      this.schema === undefined ? undefined : JSON.parse(JSON.stringify(this.schema));
    return new JsonFieldType(cloned);
  }
}

const _check: FieldTypeClass = JsonFieldType;
void _check;
