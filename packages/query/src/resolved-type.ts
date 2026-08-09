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
import type { AggregateMerge } from './schema';

/**
 * A field-ref to a RELATION field resolves to the RELATED Type (a whole row),
 * carrying this marker so operators can tell it apart from a scalar value. It
 * records the ORIGINATING `source.field` (for diagnostics + the FK-key column
 * to compare by) and the relation's target Type name, so a relation-vs-relation
 * comparison is compared by FK key and a relation-vs-scalar comparison is
 * rejected (`compare.relation-vs-value`).
 */
/**
 * One join-key column pair of a relation, oriented to the relation's own side:
 * `local` a column on the relation's SOURCE side, `foreign` the matching column
 * on the TARGET (the target's PK field for a belongs-to). `keyType` is the
 * scalar value type flowing across it — used to type a bind param and to
 * validate a supplied relation VALUE's field.
 */
export interface RelationKeyPair {
  readonly local: string;
  readonly foreign: string;
  readonly keyType: FieldType;
}

export interface RelationResolved {
  /** The bound source the relation field is read from. */
  readonly source: string;
  /** The relation field's name on that source. */
  readonly field: string;
  /** The LOCAL key column carrying the value a comparison compares by (`keys[0].local`). */
  readonly keyField: string;
  /**
   * The SCALAR field type of the relation's (leading) key VALUE (`keys[0].keyType`).
   * A belongs-to holds the target's identity value; a has-many keys on this
   * Type's identity. Lets a bind param compared against the relation be typed.
   */
  readonly keyType: FieldType;
  /** The relation's target Type name (its `to`). */
  readonly to: string;
  /** Declared cardinality of the related rows (`1` = one-to-one / belongs-to shaped). */
  readonly count: number;
  /**
   * Which side the FOREIGN KEY is on: true = belongs-to, so this row holds the
   * target's identity locally; false = has-many, a SET keyed on the target.
   * Read this rather than `count` — a MATERIALIZED INVERSE can carry an
   * estimated `count` of 1 and is still a has-many (see
   * `RelationFieldType.isBelongsTo`).
   */
  readonly belongsTo: boolean;
  /** The ORDERED join-key pairs (composite-capable) driving relation comparison lowering. */
  readonly keys: readonly RelationKeyPair[];
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
  /**
   * The APPLIED aggregate function's name (`'sum'`, `'count'`, …) — present
   * exactly when this value IS one aggregate call, absent when it merely
   * CONTAINS one (`max(a) - min(b)` is `aggregate: true` with no single applied
   * function) and absent for every non-aggregate.
   *
   * It is a SIBLING of `aggregate` rather than a widening of it because the two
   * answer different questions: `aggregate` is a property of the whole SUBTREE
   * ("does a group collapse happen in here?", which drives placement validation
   * and grouping), while this is a property of ONE node. Folding them into
   * `false | string` would force a meaningless value for every composite.
   *
   * WHY IT EXISTS. Without it, a consumer labelling a computed column has to
   * recover the function from the column's OUTPUT NAME — `fieldNameOf` is
   * `as ?? (field-ref ? field : aggregate ? fn : col<i>)`, so an UNALIASED
   * aggregate's output name IS its function name — and then confirm that name
   * against the function catalog. That is evidence rather than fact, and it has
   * two dead spots: an ALIASED aggregate (`sum(hours) as total_hours`) cannot be
   * recovered at all, and a non-aggregate aliased onto a function name
   * (`hours * 2 as count`) is a false positive that only `aggregate` then
   * rejects. Reading this closes both.
   *
   * A WINDOW is deliberately excluded, even over an aggregate-shaped function
   * (`sum(x) OVER (…)`): it is per-row, collapses nothing, and already reports
   * `aggregate: false`. A scalar `function-call` does not set it either — this
   * names the aggregate that was APPLIED, not any function that was called.
   */
  aggregateFn?: string;
  /**
   * Whether the APPLIED aggregate call was `DISTINCT` (`count(DISTINCT x)`).
   * Present exactly when {@link aggregateFn} is, and `false` for an ordinary
   * call — a companion FACT, not a flag omitted when false, because "not
   * distinct" is an answer a consumer relies on.
   *
   * It exists because `count(x)` and `count(DISTINCT x)` resolved IDENTICALLY
   * before `0.6.5`: same `fieldType`, same `nullable`, same `aggregateFn`, the
   * same single source. They answer different questions and combine by different
   * rules, and nothing on the wire could tell them apart.
   */
  aggregateDistinct?: boolean;
  /**
   * How two values of THIS CALL combine into the value over the union of the
   * groups that produced them — the function's declared `AggregateMerge` with
   * DISTINCT already accounted for (`count(x)` ⇒ `'sum'`, `count(DISTINCT x)` ⇒
   * `'none'`, `min(DISTINCT x)` ⇒ `'min'`). Present exactly when
   * {@link aggregateFn} is, and `'none'` when the call cannot be merged — so a
   * consumer folding a tail of groups into a residual ("Other") reads ONE field
   * and gets a total answer, including for an aggregate a caller registered.
   *
   * Resolved HERE rather than left to the consumer because the browser holds no
   * engine: the registry lookup (and the DISTINCT rule that goes with it) is not
   * available on the far side of the wire.
   */
  aggregateMerge?: AggregateMerge;
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
