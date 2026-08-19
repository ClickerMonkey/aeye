/**
 * Field — a named field on a Type, wrapping a `FieldType` plus
 * presentation metadata and a nullability flag. Nullability lives HERE
 * (on the field), never on the FieldType, so the same FieldType instance
 * can back both nullable and non-nullable fields.
 */
import type { FieldDef, FieldExprRestriction, ExprKind } from './schema';
import type { FieldType } from './field-type';
import type { FieldBacking } from './backing';
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
  /**
   * Estimated average stored bytes for this field. Overrides the field type's
   * own {@link FieldType.avgBytes} default; drives per-row / index byte cost.
   */
  bytes?: number;
  /**
   * Estimated milliseconds between changes to this field's data, overriding the
   * Type's rate: `0` = always changing, `-1` = never, `60000` = once a minute.
   */
  changes?: number;
  /** Whether the field may be null / absent. Default false. */
  nullable?: boolean;
  /** Whether the field may be supplied on INSERT. Default true. */
  insertable?: boolean;
  /** Whether the field may be assigned on UPDATE. Default true. */
  updatable?: boolean;
  /** Restrict which expr KINDS may target this field (narrows the type's set). */
  exprs?: FieldExprRestriction;
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
  /** Explicit average stored bytes, when authored (else the field type's default). */
  private readonly explicitBytes?: number;
  /** Explicit change interval (ms) for this field, when authored (else the Type's rate). */
  private readonly explicitChanges?: number;
  /** Whether the field may hold null / be absent. */
  readonly nullable: boolean;
  /** Whether the field may be supplied on INSERT (default true). */
  readonly insertable: boolean;
  /** Whether the field may be assigned on UPDATE (default true). */
  readonly updatable: boolean;
  /** Restrict which expr KINDS may target this field, when set. */
  readonly exprs?: FieldExprRestriction;
  /** True when this field was materialized rather than authored (see spec). */
  readonly synthetic: boolean;
  /** Whether `insertable` was set EXPLICITLY (drives the computed-field override). */
  private readonly insertableSet: boolean;
  /** Whether `updatable` was set EXPLICITLY (drives the computed-field override). */
  private readonly updatableSet: boolean;

  /** Construct a Field from its spec, defaulting `nullable`/`synthetic` to false and the write flags to true. */
  constructor(spec: FieldSpec) {
    this.name = spec.name;
    this.label = spec.label;
    this.description = spec.description;
    this.fieldType = spec.fieldType;
    this.explicitBytes = spec.bytes;
    this.explicitChanges = spec.changes;
    this.nullable = spec.nullable ?? false;
    this.insertableSet = spec.insertable !== undefined;
    this.updatableSet = spec.updatable !== undefined;
    this.insertable = spec.insertable ?? true;
    this.updatable = spec.updatable ?? true;
    this.exprs = spec.exprs;
    this.synthetic = spec.synthetic ?? false;
  }

  /** Build a Field from its JSON, parsing the field type via `registry`. */
  static from(json: FieldDef, registry: Registry): Field {
    const fieldType = registry.parseFieldType(json.type);
    return new Field({
      name: json.name,
      label: json.label,
      description: json.description,
      fieldType,
      // An explicit per-field `bytes` wins; otherwise a registry-level default for
      // this field type's kind may apply (else the field type's own avgBytes()).
      bytes: json.bytes ?? registry.defaultFieldBytes(fieldType.kind),
      changes: json.changes,
      nullable: json.nullable ?? false,
      insertable: json.insertable,
      updatable: json.updatable,
      exprs: json.exprs,
    });
  }

  /**
   * Estimated average stored bytes for this field: an explicit authored `bytes`
   * when present, else the field type's own {@link FieldType.avgBytes} default.
   * Drives the whole-row and index byte-cost estimates.
   */
  bytes(): number {
    return this.explicitBytes ?? this.fieldType.avgBytes();
  }

  /**
   * Explicit change interval (ms) for this field, or `undefined` when it inherits
   * the Type's rate. `0` = always changing, `-1` = never, `60000` = once a
   * minute. Folded into `engine.changeInterval(query)` to estimate result
   * freshness.
   */
  changes(): number | undefined {
    return this.explicitChanges;
  }

  /**
   * Whether this field's TYPE could ever support expr `kind` — the availability
   * floor `allowsExpr` narrows. Type-gated kinds: `array-op` needs an array
   * field, `text-search`/`text-score` a text field, `semantic` a semantic-eligible
   * field (a semantic/search text field, or a relation). Every other kind is
   * type-agnostic (any field allows it).
   *
   * ASKED OF THE TYPE, never by `instanceof`. The two CATEGORY gates go through
   * `resolve()` — the same answer `categoryOf` gives every comparison in the
   * package, so there is one spelling of "is text" rather than two, and it
   * survives two builds of this package existing in one process (`index.ts`
   * records that measurement). The SEMANTIC gate goes through the type's own
   * `isSemantic()`, which is where the `search`/`semantic` options are read now
   * — this used to reach into `TextFieldType.options` from outside the class,
   * as did three other sites, one of them a hand-copied duplicate.
   *
   * A `relation` is admitted here and is NOT `isSemantic()`, deliberately: this
   * asks whether a `semantic` expr may TARGET the field, while `isSemantic()`
   * asks whether the field's own values are embedded. Merging them made every
   * Type owning a foreign key report itself semantic-eligible (see
   * `Type.semanticFields`).
   */
  private fieldTypeAllowsExpr(kind: ExprKind): boolean {
    const ft = this.fieldType;
    switch (kind) {
      case 'array-op':
        // The CONTAINER test, not `itemType() !== undefined`: an array that
        // declares no element type is still an array, and still takes an
        // `array-op`.
        return ft.resolve() === 'array';
      case 'text-search':
      case 'text-score':
        return ft.resolve() === 'text';
      case 'semantic':
        return ft.resolve() === 'relation' || ft.isSemantic();
      default:
        return true;
    }
  }

  /**
   * Whether expr `kind` may TARGET this field: the field's TYPE must support the
   * kind (see `fieldTypeAllowsExpr`), and any `exprs` restriction must permit it
   * (`only` allows exactly its list; `not` excludes its list). A restriction only
   * NARROWS — it can never enable a kind the type disallows.
   */
  allowsExpr(kind: ExprKind): boolean {
    if (!this.fieldTypeAllowsExpr(kind)) return false;
    if (!this.exprs) return true;
    return 'only' in this.exprs ? this.exprs.only.includes(kind) : !this.exprs.not.includes(kind);
  }

  /**
   * Effective INSERT-ability given the field's backing: an EXPLICIT `insertable`
   * flag always wins; otherwise a COMPUTED field is non-insertable (its value is
   * produced, never supplied) and a plain field is insertable.
   */
  insertableFor(fb: FieldBacking | undefined): boolean {
    if (this.insertableSet) return this.insertable;
    return !fb?.compute;
  }

  /** Effective UPDATE-ability given the field's backing (mirrors `insertableFor`). */
  updatableFor(fb: FieldBacking | undefined): boolean {
    if (this.updatableSet) return this.updatable;
    return !fb?.compute;
  }

  /** Serialize to its `FieldDef` JSON shape (omits `nullable` when false). */
  toJSON(): FieldDef {
    return {
      name: this.name,
      label: this.label,
      description: this.description,
      type: this.fieldType.toJSON(),
      // Only emit `bytes` when authored explicitly (a derived default stays implicit).
      bytes: this.explicitBytes,
      // Only emit `changes` when authored (it otherwise inherits the Type's rate).
      changes: this.explicitChanges,
      // Only emit `nullable` when true, keeping the default implicit.
      nullable: this.nullable ? true : undefined,
      // Emit a write flag only when it was set EXPLICITLY (preserving fidelity of
      // an override); an unset flag stays implicit (default true).
      insertable: this.insertableSet ? this.insertable : undefined,
      updatable: this.updatableSet ? this.updatable : undefined,
      exprs: this.exprs,
    };
  }

  /** Deep-copy this field (cloning its field type). */
  clone(): Field {
    return new Field({
      name: this.name,
      label: this.label,
      description: this.description,
      fieldType: this.fieldType.clone(),
      bytes: this.explicitBytes,
      changes: this.explicitChanges,
      nullable: this.nullable,
      insertable: this.insertableSet ? this.insertable : undefined,
      updatable: this.updatableSet ? this.updatable : undefined,
      exprs: this.exprs,
      synthetic: this.synthetic,
    });
  }

  /** Render a short `name[?]: kind` description. */
  toCode(_registry?: Registry, _options?: CodeOptions): string {
    return `${this.name}${this.nullable ? '?' : ''}: ${this.fieldType.kind}`;
  }
}
