/**
 * Type — a type-like entity: a named collection of `Field`s plus
 * `Index`es and cardinality estimates (`count` rows, `bytes` per row) that
 * drive cost estimation. The query-language analogue of gin's `Type`, but
 * relational rather than a value-type algebra.
 */
import { z } from 'zod';
import type { FieldDef, IndexDef, TypeDef } from './schema';
import type { CodeOptions, Node, SchemaOptions } from './node';
import type { Registry } from './registry';
import { Field } from './field';
import { Index } from './index-spec';
import { QueryTypeError } from './problem';
import { RelationFieldType, TextFieldType, fieldTypeDefSchema } from './field-types/index';

/** Constructor spec for a {@link Type} — name, metadata, fields, indexes, and cost estimates. */
export interface TypeSpec {
  /** Type name (unique within the registry). */
  name: string;
  /** Short human-readable label. */
  label?: string;
  /** Longer human / LLM-facing description. */
  description?: string;
  /** The fields declared on this Type. */
  fields: Field[];
  /** The (composite) indexes declared on this Type. */
  indexes: Index[];
  /** Estimated row count. */
  count: number;
  /**
   * Estimated average bytes per row. When omitted it is DERIVED as the sum of
   * the fields' {@link Field.bytes} (the whole row is assumed loaded on a scan).
   */
  bytes?: number;
  /**
   * Estimated milliseconds between changes to this Type's data: `0` = always
   * changing (the default), `-1` = never (immutable), `60000` = once a minute.
   */
  changes?: number;
  /** Eligible for embedding-based semantic similarity across the type's data. */
  semantic?: boolean;
  /** Eligible for full-text search across the type's data. */
  search?: boolean;
  /** Whether rows of this Type may be INSERTed. Default true. */
  insertable?: boolean;
  /** Whether rows of this Type may be UPDATEd. Default true. */
  updatable?: boolean;
  /** Whether rows of this Type may be DELETEd. Default true. */
  deletable?: boolean;
}

/**
 * A type-like entity: a named collection of {@link Field}s plus {@link Index}es
 * and cardinality estimates (`count` rows, `bytes` per row) that drive cost.
 */
export class Type implements Node {
  /** Type name (unique within the registry). */
  readonly name: string;
  /** Short human-readable label, if any. */
  readonly label?: string;
  /** Longer human / LLM-facing description, if any. */
  readonly description?: string;
  /** The fields declared on this Type. */
  readonly fields: Field[];
  /** The (composite) indexes declared on this Type. */
  readonly indexes: Index[];
  /** Estimated total row count (drives cost estimation). */
  readonly count: number;
  /** Estimated average bytes per row (drives byte-cost estimation). */
  readonly bytes: number;
  /** Estimated ms between changes to this Type's data (`0` = always, `-1` = never). */
  readonly changes: number;
  /** Whether the whole type is flagged semantic-eligible. */
  readonly semantic: boolean;
  /** Whether the whole type is flagged full-text-search-eligible. */
  readonly search: boolean;
  /** Whether rows of this Type may be INSERTed (default true). */
  readonly insertable: boolean;
  /** Whether rows of this Type may be UPDATEd (default true). */
  readonly updatable: boolean;
  /** Whether rows of this Type may be DELETEd (default true). */
  readonly deletable: boolean;

  /** Construct a Type from its spec, defaulting `semantic`/`search` to false and the write flags to true. */
  constructor(spec: TypeSpec) {
    this.name = spec.name;
    this.label = spec.label;
    this.description = spec.description;
    this.fields = spec.fields;
    this.indexes = spec.indexes;
    this.count = spec.count;
    // Whole-row byte size: an explicit spec value, else the SUM of the fields'
    // (per-field or field-type-default) bytes — a scan loads every field.
    this.bytes = spec.bytes ?? this.fields.reduce((sum, f) => sum + f.bytes(), 0);
    // Change rate (ms): default 0 = always changing (opt into -1 / a period).
    this.changes = spec.changes ?? 0;
    this.semantic = spec.semantic ?? false;
    this.search = spec.search ?? false;
    this.insertable = spec.insertable ?? true;
    this.updatable = spec.updatable ?? true;
    this.deletable = spec.deletable ?? true;
  }

  /** Look up a field by name. */
  field(name: string): Field | undefined {
    return this.fields.find((f) => f.name === name);
  }

  /** Fields whose type is a relation to another Type. */
  relationFields(): Field[] {
    return this.fields.filter((f) => f.fieldType instanceof RelationFieldType);
  }

  /** Fields whose type is `text` (the candidates a narrowed text-search targets). */
  textFields(): Field[] {
    return this.fields.filter((f) => f.fieldType instanceof TextFieldType);
  }

  /**
   * The IDENTITY field used as the join key on this Type's side of a relation:
   * the field referenced by the first single-part UNIQUE index (one part,
   * `count === 1`, whose expr is a field-ref), else the field named `id`, else
   * a clear error. Relations resolve their keys through this.
   */
  identityField(): Field {
    for (const idx of this.indexes) {
      if (idx.parts.length !== 1) continue;
      const part = idx.parts[0]!;
      if (part.count !== 1) continue;
      if (part.expr.kind !== 'field-ref') continue;
      const field = this.field(part.expr.field);
      if (field) return field;
    }
    const byName = this.field('id');
    if (byName) return byName;
    throw new QueryTypeError({
      path: [], code: 'type.no-identity', severity: 'error',
      message:
        `Type '${this.name}' needs an identity field (a unique single-field index ` +
        `or an 'id' field) to participate in relations.`,
    });
  }

  /**
   * Fields eligible for semantic-aware querying: text fields flagged
   * `semantic` or `search`, plus all relation fields (which can drive
   * cross-entity semantic joins).
   */
  semanticFields(): Field[] {
    return this.fields.filter((f) => {
      const ft = f.fieldType;
      if (ft instanceof TextFieldType) return ft.options.semantic === true || ft.options.search === true;
      return ft instanceof RelationFieldType;
    });
  }

  /** Whether this Type is eligible for embedding-based semantic similarity. */
  isSemantic(): boolean {
    return this.semantic || this.semanticFields().length > 0;
  }

  /** Whether this Type is eligible for full-text search. */
  isSearchable(): boolean {
    if (this.search) return true;
    return this.fields.some(
      (f) => f.fieldType instanceof TextFieldType && f.fieldType.options.search === true,
    );
  }

  /** Build a Type from its JSON, parsing fields/indexes via `registry`. */
  static from(json: TypeDef, registry: Registry): Type {
    const fields = json.fields.map((fd) => Field.from(fd, registry));
    const indexes = (json.indexes ?? []).map((id) => Index.from(id));
    return new Type({
      name: json.name,
      label: json.label,
      description: json.description,
      fields,
      indexes,
      count: json.count,
      bytes: json.bytes,
      changes: json.changes,
      semantic: json.semantic,
      search: json.search,
      insertable: json.insertable,
      updatable: json.updatable,
      deletable: json.deletable,
    });
  }

  /** Zod schema for the `TypeDef` JSON shape. */
  static toSchema(opts?: SchemaOptions): z.ZodTypeAny {
    const exprKindSchema = z.string().describe('An expression kind (e.g. `comparison`, `array-op`).');
    const fieldExprsSchema = z.union([
      z.object({ not: z.array(exprKindSchema).describe('Expr kinds to EXCLUDE for this field.') }),
      z.object({ only: z.array(exprKindSchema).describe('The ONLY expr kinds allowed for this field.') }),
    ]).describe('Restrict which expr kinds may target this field (narrows the type\'s set).');
    const fieldDefSchema: z.ZodTypeAny = z.object({
      name: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
      type: fieldTypeDefSchema(),
      bytes: z.number().optional().describe('Estimated average stored bytes for this field (overrides the field type default).'),
      changes: z.number().optional().describe('Ms between changes to this field (overrides the Type; 0 = always, -1 = never).'),
      nullable: z.boolean().optional(),
      insertable: z.boolean().optional().describe('Whether the field may be supplied on INSERT (default true).'),
      updatable: z.boolean().optional().describe('Whether the field may be assigned on UPDATE (default true).'),
      exprs: fieldExprsSchema.optional(),
    }).meta({ aid: 'FieldDef' }).describe('A field (field) definition.');
    // Index expr references the (phase-2) ExprDef union; accept the caller's
    // lazy Expr schema when supplied, else a permissive object.
    const exprSchema = opts?.Expr ?? z.object({ kind: z.string() }).loose();
    const indexPartDefSchema = z.object({
      expr: exprSchema,
      count: z.number().describe('Prefix distinct rows up to & including this part; last part 1 ⇒ unique.'),
    }).meta({ aid: 'IndexPartDef' }).describe('One ordered part of a composite index.');
    const indexDefSchema = z.object({
      exprs: z.array(indexPartDefSchema).describe('Ordered composite-index parts.'),
      bytes: z.number().optional().describe('Estimated average bytes per index entry (else derived from the parts).'),
    }).meta({ aid: 'IndexDef' }).describe('A composite index definition.');
    return z.object({
      name: z.string(),
      label: z.string().optional(),
      description: z.string().optional(),
      fields: z.array(fieldDefSchema),
      indexes: z.array(indexDefSchema).optional(),
      count: z.number().describe('Estimated total row count.'),
      bytes: z.number().optional().describe('Estimated average bytes per row (else derived as the sum of the fields\' bytes).'),
      changes: z.number().optional().describe('Ms between changes to this Type\'s data (0 = always changing, -1 = never).'),
      semantic: z.boolean().optional().describe('Eligible for semantic similarity across the type.'),
      search: z.boolean().optional().describe('Eligible for full-text search across the type.'),
      insertable: z.boolean().optional().describe('Whether rows may be INSERTed (default true).'),
      updatable: z.boolean().optional().describe('Whether rows may be UPDATEd (default true).'),
      deletable: z.boolean().optional().describe('Whether rows may be DELETEd (default true).'),
    }).meta({ aid: 'TypeDef' }).describe('A type-like Type definition.');
  }

  /** Serialize to its `TypeDef` JSON shape (omits synthetic fields and false flags). */
  toJSON(): TypeDef {
    // Synthetic (materialized) fields are omitted so an authored schema
    // round-trips cleanly; the registry re-materializes them on finalize.
    const fields: FieldDef[] = this.fields.filter((f) => !f.synthetic).map((f) => f.toJSON());
    const indexes: IndexDef[] = this.indexes.map((i) => i.toJSON());
    return {
      name: this.name,
      label: this.label,
      description: this.description,
      fields,
      indexes: indexes.length > 0 ? indexes : undefined,
      count: this.count,
      bytes: this.bytes,
      // Emit `changes` only when set away from the default (0 = always changing).
      changes: this.changes !== 0 ? this.changes : undefined,
      semantic: this.semantic ? true : undefined,
      search: this.search ? true : undefined,
      // Only emit a write flag when RESTRICTED (false), keeping the default implicit.
      insertable: this.insertable ? undefined : false,
      updatable: this.updatable ? undefined : false,
      deletable: this.deletable ? undefined : false,
    };
  }

  /** Deep-copy this Type (cloning every field and index). */
  clone(): Type {
    return new Type({
      name: this.name,
      label: this.label,
      description: this.description,
      fields: this.fields.map((f) => f.clone()),
      indexes: this.indexes.map((i) => i.clone()),
      count: this.count,
      bytes: this.bytes,
      changes: this.changes,
      semantic: this.semantic,
      search: this.search,
      insertable: this.insertable,
      updatable: this.updatable,
      deletable: this.deletable,
    });
  }

  /** Render a short `type Name { ...fields }` description. */
  toCode(_registry?: Registry, _options?: CodeOptions): string {
    const fieldList = this.fields.map((f) => `  ${f.toCode()}`).join('\n');
    return `type ${this.name} {\n${fieldList}\n}`;
  }
}
