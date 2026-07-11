/**
 * ResolvedType — the result of resolving an expression / source against a
 * scope. Modelled as a DISCRIMINATED UNION (not an inheritance hierarchy)
 * so every consumer can `switch (rt.kind)` with compiler-checked
 * exhaustiveness and zero casts. This is the type-safety crux of the whole
 * package: nullability, cost, and SQL planning all read off these shapes.
 *
 *  - Type    — an entire Type. Either a user-provided type or a
 *               `synthetic` one materialized from a complex subquery.
 *  - Field    — a single field; carries the owning `type` + `source` so
 *               SQL / cost can reach `Type.count`, indexes, relation counts.
 *  - Computed — a value-type tracking the one-or-more source Fields it was
 *               derived from (drives nullability, cost, index usage).
 */
import type { Type } from './type';
import type { Field } from './field';
import type { FieldType } from './field-type';

/**
 * A field-ref to a RELATION field resolves to the RELATED Type (a whole row),
 * carrying this marker so operators can tell it apart from a scalar value. It
 * records the ORIGINATING `source.field` (for diagnostics + the FK-key column
 * to compare by) and the relation's target Type name, so a relation-vs-relation
 * comparison is compared by FK key and a relation-vs-scalar comparison is
 * rejected (`compare.relation-vs-value`).
 */
export interface RelationResolved {
  /** The bound source the relation field is read from. */
  readonly source: string;
  /** The relation field's name on that source. */
  readonly field: string;
  /** The LOCAL key column carrying the value a comparison should compare by. */
  readonly keyField: string;
  /**
   * The SCALAR field type of the relation's key VALUE (a belongs-to holds the
   * target's identity value; a has-many keys on this Type's identity). Lets a
   * bind param compared against the relation be typed, and a relation-vs-relation
   * comparison read as an id compare.
   */
  readonly keyType: FieldType;
  /** The relation's target Type name (its `to`). */
  readonly to: string;
}

/** A resolved value that is an entire Type (a whole row/source). */
export interface TypeResolved {
  kind: 'type';
  type: Type;
  /** The source name this type is bound to (alias / type name / CTE). */
  source: string;
  /** True when synthesized from a subquery rather than a declared Type. */
  synthetic: boolean;
  /**
   * Present when this Type was resolved from a FIELD-REF to a RELATION field
   * (a whole related row, NOT a scalar value). Absent for a FROM / join /
   * subquery Type. Drives the relation-vs-value comparison guard.
   */
  readonly relation?: RelationResolved;
}

/** A resolved value that is a single field, carrying its owning Type + source. */
export interface FieldResolved {
  kind: 'field';
  field: Field;
  /** The Type that owns this field. */
  type: Type;
  /** The source name the field is read from. */
  source: string;
  /** Whether this field reference may be null in context. */
  nullable: boolean;
}

/** A resolved value computed from zero or more source fields (an expression result). */
export interface ComputedResolved {
  kind: 'computed';
  /** The value category of the computed result. */
  fieldType: FieldType;
  /** The source fields this value was derived from (possibly empty). */
  sources: readonly FieldResolved[];
  /** Whether the computed value may be null. */
  nullable: boolean;
  /** Whether this computation is (or contains) an aggregate. */
  aggregate: boolean;
}

/** The discriminated union of every expression / source resolution outcome. */
export type ResolvedType = TypeResolved | FieldResolved | ComputedResolved;

// ─── Total helpers (exhaustive, no casts) ────────────────────────────────────

/**
 * The underlying field type of a resolved value, when it has one.
 * Types have no single field type → `undefined`.
 */
export function asFieldType(rt: ResolvedType): FieldType | undefined {
  switch (rt.kind) {
    case 'type':
      return undefined;
    case 'field':
      return rt.field.fieldType;
    case 'computed':
      return rt.fieldType;
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers ResolvedType (compile-time guard) */
    default:
      return assertNever(rt);
  }
}

/**
 * The source field(s) backing a resolved value. A field resolves to itself;
 * a computed value resolves to its tracked sources; a type to none.
 */
export function sourcesOf(rt: ResolvedType): readonly FieldResolved[] {
  switch (rt.kind) {
    case 'type':
      return [];
    case 'field':
      return [rt];
    case 'computed':
      return rt.sources;
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers ResolvedType (compile-time guard) */
    default:
      return assertNever(rt);
  }
}

/**
 * Return a copy of `rt` with its nullability forced to `nullable` (default
 * true). Types have no nullability and are returned unchanged. Used when a
 * LEFT JOIN / optional context widens a value to possibly-null.
 */
export function widenNullable(rt: ResolvedType, nullable: boolean = true): ResolvedType {
  switch (rt.kind) {
    case 'type':
      return rt;
    case 'field':
      return rt.nullable === nullable ? rt : { ...rt, nullable };
    case 'computed':
      return rt.nullable === nullable ? rt : { ...rt, nullable };
    /* v8 ignore next 2 -- unreachable: `kind` exhaustively covers ResolvedType (compile-time guard) */
    default:
      return assertNever(rt);
  }
}

/** Type guard: a resolved type. */
export function isType(rt: ResolvedType): rt is TypeResolved {
  return rt.kind === 'type';
}

/**
 * The relation info when `rt` is a Type resolved from a relation FIELD-REF
 * (a belongs-to / has-many field), else `undefined`. Used by the scalar
 * operators to reject a relation used as a value and to allow (and key-compare)
 * a relation-vs-relation comparison.
 */
export function relationOf(rt: ResolvedType): RelationResolved | undefined {
  return rt.kind === 'type' ? rt.relation : undefined;
}

/**
 * The comparable-VALUE field type of a resolved value: its scalar field type,
 * else — for a relation Type — the relation's key value type. Used to type a
 * bind param compared against the operand (a relation compares by its FK key).
 * A non-relation whole Type has none.
 */
export function valueFieldType(rt: ResolvedType): FieldType | undefined {
  return asFieldType(rt) ?? relationOf(rt)?.keyType;
}

/** Type guard: a resolved scalar (field or computed value, never a type). */
export function isScalar(rt: ResolvedType): rt is FieldResolved | ComputedResolved {
  return rt.kind !== 'type';
}

/**
 * Compile-time exhaustiveness guard. If a new `ResolvedType` member is added
 * and a `switch` above isn't updated, this call fails to type-check.
 */
/* v8 ignore start -- compile-time exhaustiveness guard; never invoked at runtime */
function assertNever(value: never): never {
  throw new Error(`ResolvedType: unhandled variant ${JSON.stringify(value)}`);
}
/* v8 ignore stop */
