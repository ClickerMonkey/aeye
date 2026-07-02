/**
 * Field — a named field on a Type, wrapping a `FieldType` plus
 * presentation metadata and a nullability flag. Nullability lives HERE
 * (on the field), never on the FieldType, so the same FieldType instance
 * can back both nullable and non-nullable fields.
 */
import type { FieldDef } from './schema';
import type { FieldType } from './field-type';
import type { CodeOptions, Node } from './node';
import type { Registry } from './registry';

/** Constructor spec for a {@link Field} — its name, presentation metadata, field type, and flags. */
export interface FieldSpec {
  /** Field name (unique within its Type). */
  name: string;
  /** Short human-readable label. */
  label?: string;
  /** Longer human / LLM-facing description. */
  description?: string;
  /** The field's value type. */
  fieldType: FieldType;
  /** Whether the field may be null / absent. Default false. */
  nullable?: boolean;
  /**
   * True for fields MATERIALIZED at registration time (e.g. an inverse
   * relation synthesized from another Type's `inverseRelation`). Synthetic
   * fields are real for querying but OMITTED from `Type.toJSON()` so a
   * declared schema round-trips cleanly. Default false.
   */
  synthetic?: boolean;
}

/**
 * A named field on a Type: a {@link FieldType} plus presentation metadata and
 * a nullability flag (nullability lives here, not on the FieldType).
 */
export class Field implements Node {
  /** Field name (unique within its Type). */
  readonly name: string;
  /** Short human-readable label, if any. */
  readonly label?: string;
  /** Longer human / LLM-facing description, if any. */
  readonly description?: string;
  /** The field's value type. */
  readonly fieldType: FieldType;
  /** Whether the field may hold null / be absent. */
  readonly nullable: boolean;
  /** True when this field was materialized rather than authored (see spec). */
  readonly synthetic: boolean;

  /** Construct a Field from its spec, defaulting `nullable`/`synthetic` to false. */
  constructor(spec: FieldSpec) {
    this.name = spec.name;
    this.label = spec.label;
    this.description = spec.description;
    this.fieldType = spec.fieldType;
    this.nullable = spec.nullable ?? false;
    this.synthetic = spec.synthetic ?? false;
  }

  /** Build a Field from its JSON, parsing the field type via `registry`. */
  static from(json: FieldDef, registry: Registry): Field {
    return new Field({
      name: json.name,
      label: json.label,
      description: json.description,
      fieldType: registry.parseFieldType(json.type),
      nullable: json.nullable ?? false,
    });
  }

  /** Serialize to its `FieldDef` JSON shape (omits `nullable` when false). */
  toJSON(): FieldDef {
    return {
      name: this.name,
      label: this.label,
      description: this.description,
      type: this.fieldType.toJSON(),
      // Only emit `nullable` when true, keeping the default implicit.
      nullable: this.nullable ? true : undefined,
    };
  }

  /** Deep-copy this field (cloning its field type). */
  clone(): Field {
    return new Field({
      name: this.name,
      label: this.label,
      description: this.description,
      fieldType: this.fieldType.clone(),
      nullable: this.nullable,
      synthetic: this.synthetic,
    });
  }

  /** Render a short `name[?]: kind` description. */
  toCode(_registry?: Registry, _options?: CodeOptions): string {
    return `${this.name}${this.nullable ? '?' : ''}: ${this.fieldType.kind}`;
  }
}
