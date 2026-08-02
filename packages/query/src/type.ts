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
  /**
   * The field (or ordered fields) that IDENTIFY a row. When set it is THE
   * answer for {@link Type.identityField} / {@link Type.primaryKey} and index
   * order stops mattering. Omit to fall back to the inferred rule.
   */
  identity?: string | string[];
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

/** The `type.no-identity` message shared by `identityField` / `primaryKey`. */
function noKeyMessage(typeName: string): string {
  return (
    `Type '${typeName}' needs a primary key (a declared 'identity', a unique index, ` +
    `or an 'id' field) to participate in relations.`
  );
}

/** Normalize a declared `identity` (a bare name or an ordered list) to a name list. */
function identityNames(identity: string | readonly string[] | undefined): readonly string[] | undefined {
  if (identity === undefined) return undefined;
  return typeof identity === 'string' ? [identity] : identity;
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
  /**
   * The DECLARED identity field names, in key order — normalized from the spec's
   * `string | string[]`. `undefined` means identity is INFERRED (first
   * single-part unique index, else `id`), which is index-order dependent.
   */
  readonly identity?: readonly string[];
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
    this.identity = identityNames(spec.identity);
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
   * the DECLARED `identity` when it names exactly one field, else the field
   * referenced by the first single-part UNIQUE index (one part, `count === 1`,
   * whose expr is a field-ref), else the field named `id`, else a clear error.
   * Relations resolve their keys through this.
   */
  identityField(): Field {
    const single = this.singleIdentity();
    if (single) return single;
    throw new QueryTypeError({ path: [], code: 'type.no-identity', severity: 'error', message: noKeyMessage(this.name) });
  }

  /**
   * The ordered PRIMARY KEY fields of this Type — generalizing {@link
   * identityField} to COMPOSITE keys: the DECLARED `identity` when set, else the
   * single identity field (a single-part unique index's field, else `id`), else
   * the fields of the first multi-part UNIQUE index (last part `count === 1`)
   * whose every part is a field-ref. Relations map their key columns to these; a
   * relation VALUE is keyed by these field names. Throws when none exists.
   */
  primaryKey(): Field[] {
    const declared = this.declaredIdentity();
    if (declared) return declared;
    const single = this.singleIdentity();
    if (single) return [single];
    for (const idx of this.indexes) {
      const last = idx.parts[idx.parts.length - 1];
      if (!last || last.count !== 1) continue; // not a unique index
      const fields = idx.parts.map((p) => (p.expr.kind === 'field-ref' ? this.field(p.expr.field) : undefined));
      if (fields.every((f): f is Field => f !== undefined)) return fields;
    }
    throw new QueryTypeError({ path: [], code: 'type.no-identity', severity: 'error', message: noKeyMessage(this.name) });
  }

  /**
   * The fields named by an explicit `identity` declaration, in key order, or
   * `undefined` when none is declared. A declared name that is not a field on
   * this Type is an ERROR rather than a silent fall-back to the inferred rule —
   * falling back would reintroduce exactly the index-order dependence the
   * declaration exists to remove, and would do it invisibly.
   */
  private declaredIdentity(): Field[] | undefined {
    if (this.identity === undefined) return undefined;
    const found = this.identity.map((name) => this.field(name));
    const missing = this.identity.filter((_, i) => found[i] === undefined);
    if (missing.length > 0) {
      throw new QueryTypeError({
        path: [], code: 'type.identity-unknown-field', severity: 'error',
        message:
          `Type '${this.name}' declares identity field(s) ${missing.map((m) => `'${m}'`).join(', ')} ` +
          `that it does not have. Declared identity: ${this.identity.join(', ')}.`,
      });
    }
    return found.filter((f): f is Field => f !== undefined);
  }

  /**
   * The single identity field: the DECLARED `identity` when it is exactly one
   * field, else the first single-part unique index's field, else `id`, else
   * undefined. A declared COMPOSITE identity has no single field, so it yields
   * `undefined` here and is answered by {@link primaryKey}.
   */
  private singleIdentity(): Field | undefined {
    const declared = this.declaredIdentity();
    if (declared) return declared.length === 1 ? declared[0] : undefined;
    for (const idx of this.indexes) {
      if (idx.parts.length !== 1) continue;
      const part = idx.parts[0]!;
      if (part.count !== 1) continue;
      if (part.expr.kind !== 'field-ref') continue;
      const field = this.field(part.expr.field);
      if (field) return field;
    }
    return this.field('id');
  }

  /**
   * Fields eligible for semantic-aware querying: text fields flagged `semantic`
   * or `search`.
   *
   * Relation fields are NOT included. They used to be — on the theory that they
   * could drive cross-entity semantic joins — which made almost every Type
   * report itself semantic-eligible on the strength of having a foreign key, and
   * a whole-source semantic score then silently ran over a Type nobody had
   * declared semantic. A relation is a join, not an embedding.
   */
  semanticFields(): Field[] {
    return this.fields.filter((f) => this.isFieldSemantic(f));
  }

  /**
   * Whether ONE field is declared semantic-eligible: a text field flagged
   * `semantic` (or `search`, whose index is the same kind of derived artifact).
   */
  isFieldSemantic(field: Field): boolean {
    const ft = field.fieldType;
    return ft instanceof TextFieldType && (ft.options.semantic === true || ft.options.search === true);
  }

  /**
   * Whether semantic scoring is possible ANYWHERE on this Type — the whole type
   * is flagged, or at least one field is. This is the ELIGIBILITY question
   * (does the `semantic` expr apply to this Type at all), which is what schema
   * gating and the capability description ask.
   *
   * What an UNNARROWED score reads is the row's embedding over
   * {@link semanticFields}, which no longer counts relation fields — so a Type
   * whose only "evidence" was owning a foreign key is no longer eligible at
   * all. See {@link isFieldSemantic} for the per-field question.
   */
  isSemantic(): boolean {
    return this.semantic || this.semanticFields().length > 0;
  }

  /** Whether ONE field is declared full-text searchable. */
  isFieldSearchable(field: Field): boolean {
    const ft = field.fieldType;
    return ft instanceof TextFieldType && ft.options.search === true;
  }

  /**
   * Whether full-text search is possible ANYWHERE on this Type — the whole type
   * is flagged, or at least one field is. The ELIGIBILITY question, used for
   * schema gating and the capability description.
   *
   * It is NOT the answer to "can this type be searched WITHOUT naming a field":
   * that needs a `SearchBacking` (the searchable document), whose absence is now
   * refused as `text-search.unbacked` rather than guessed at. See
   * {@link isFieldSearchable} for the per-field question.
   */
  isSearchable(): boolean {
    return this.search || this.fields.some((f) => this.isFieldSearchable(f));
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
      identity: json.identity,
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
      identity: z.union([z.string(), z.array(z.string())]).optional().describe(
        'The field (or ordered fields) that IDENTIFY a row. Declare it and index order stops deciding identity.',
      ),
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
      // Emitted in its NORMALIZED form: a single declared field round-trips as a
      // bare name whether it was authored as `'id'` or `['id']`.
      identity: this.identity === undefined ? undefined : this.identity.length === 1 ? this.identity[0] : [...this.identity],
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
      identity: this.identity === undefined ? undefined : [...this.identity],
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
