import { z } from 'zod';
import type { FieldTypeDef, RelationFieldTypeDef } from '../schema';
import type { SchemaOptions, ValueSchemaOptions } from '../node';
import type { Type } from '../type';
import type { QueryEngine } from '../engine';
import { FieldType, type FieldTypeClass, type ScalarKind } from '../field-type';
import { refinementKeySchema } from '../refinement';
import { QueryTypeError } from '../problem';
import {
  relationKeyColumns,
  type RelationBacking,
  type RelationOn,
  type RelationOnPair,
} from '../backing';

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

/**
 * The fully resolved `ON` for one relation hop, oriented to the join's SOURCE
 * (left) alias and TARGET alias:
 *  - `keys`   — the physical key-column pairs (ALL ANDed). Always present: a
 *    `RelationBacking.keys` mapping, else the single NAME-CONVENTION pair. The
 *    non-custom fallback in every mode.
 *  - `custom` — a `RelationBacking.on` predicate (when declared) plus its two
 *    oriented aliases (`localAlias` = the relation's declaring/belongs-to side,
 *    `joinedAlias` = the belongs-to target). Each mode uses it only when it has
 *    an applicable path (SQL: `sql`/`expr`; runtime: `run`/`expr`), else it
 *    falls back to `keys`.
 */
export interface ResolvedRelationOn {
  /** Oriented ON key-column pairs (convention or backing `keys`), all ANDed. */
  readonly keys: readonly RelationOnPair[];
  /** The custom ON backing + its oriented aliases, when declared. */
  readonly custom?: {
    /** The declared custom predicate. */
    readonly on: RelationOn;
    /** Bound alias of the relation's DECLARING (belongs-to) side. */
    readonly localAlias: string;
    /** Bound alias of the belongs-to TARGET side. */
    readonly joinedAlias: string;
  };
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
 * INFERRED as `count === 1` AND no `inverseVia` (see `isBelongsTo`); otherwise
 * has-many (FK on the target). See `resolveKey`.
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
  static toSchema(opts?: SchemaOptions): z.ZodTypeAny {
    return z.object({
      kind: z.literal('relation'),
      ...refinementKeySchema('relation', opts),
      to: z.string().describe('Name of the target Type this relation points to.'),
      count: z.number().describe('Expected related-row cardinality; 1 = belongs-to, >1 = has-many.'),
      inverseRelation: z
        .string()
        .optional()
        .describe('If set, the target Type gains a one-to-many relation of this name pointing back.'),
    }).meta({ aid: 'FieldType_relation' }).describe('Relation (foreign-key) field type.');
  }

  /**
   * True when the FOREIGN KEY lives on THIS Type — a declared belongs-to. The
   * cardinality alone is NOT the discriminator: a MATERIALIZED INVERSE (one
   * carrying {@link inverseVia}) is never belongs-to however its estimated
   * `count` came out, because `Registry.finalize()` derives that count from a
   * ROW RATIO (`round(source.count / target.count)`) — so a 1:1 pair, or two
   * unmeasured Types sharing one declared row estimate, legitimately yields 1.
   *
   * Reading `count === 1` alone made such an inverse resolve its join as
   * `order.invoice = invoice.id`, where `order.invoice` is the SYNTHETIC
   * relation field the registry just added rather than a column — every
   * traversal then matched zero rows, silently. The FK side is knowable from
   * `inverseVia`; this is where that knowledge is applied.
   */
  isBelongsTo(): boolean {
    return this.count === 1 && this.inverseVia === undefined;
  }

  /**
   * Resolve the join key for this relation, given the relation field's NAME and
   * the two Types it relates. The relation field's NAME is the key:
   *  - belongs-to ({@link isBelongsTo}): `this.<relName> = target.<identity>` —
   *    the local relation field holds the target's identity value.
   *  - has-many: `this.<identity> = target.<fk>` — where the FK on the target
   *    is `inverseVia` (for a materialized inverse) else the declaring Type's
   *    name in camelCase.
   */
  resolveKey(relationFieldName: string, thisType: Type, targetType: Type): RelationKey {
    if (this.isBelongsTo()) {
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

  /**
   * The UNALIASED, ordered join-key column pairs for this relation — the
   * composite/backing-aware generalization of {@link resolveKey}. Each pair is
   * `{ local, foreign }`: `local` a column on THIS Type's side, `foreign` the
   * matching column on the TARGET (the target's PK field for a belongs-to). Uses
   * the field's `RelationBacking.keys` when declared, else the single
   * name-convention pair. Drives relation comparison lowering (`= <> in`).
   */
  resolveKeys(
    engine: QueryEngine,
    relationFieldName: string,
    thisType: Type,
    targetType: Type,
  ): { local: string; foreign: string }[] {
    const forward = this.isBelongsTo();
    let backing: RelationBacking | undefined;
    if (forward) {
      // belongs-to: THIS field declares the FK; its backing lives here.
      backing = engine.fieldBacking(thisType.name, relationFieldName)?.relation;
    } else if (this.inverseVia !== undefined) {
      // A materialized inverse has-many borrows its forward relation's backing.
      backing = engine.fieldBacking(targetType.name, this.inverseVia)?.relation;
    }
    // else: a directly-declared has-many has no forward relation to borrow from —
    // it stays on the name convention (`resolveKey`).
    if (backing?.keys && backing.keys.length > 0) {
      // The target identity is only the DEFAULT for a key that omits `foreign`;
      // compute it lazily so a composite-key target (no single identity) works
      // when every key names its foreign column explicitly.
      const targetIdentity = backing.keys.some((k) => k.foreign === undefined)
        ? /* v8 ignore next -- a forward=false (has-many) key omitting `foreign` is not reachable via the tested inverse backings */
          (forward ? targetType : thisType).identityField().name
        : '';
      return relationKeyColumns(backing.keys, forward, targetIdentity).map((p) => ({ local: p.localField, foreign: p.foreignField }));
    }
    const single = this.resolveKey(relationFieldName, thisType, targetType);
    return [{ local: single.localField, foreign: single.foreignField }];
  }

  /**
   * Resolve the full join `ON` for this relation hop, consulting the field's
   * DEV-SIDE `RelationBacking` (physical FK columns / custom predicate) and
   * falling back to `resolveKey`'s NAME CONVENTION when none is declared. The
   * result is ORIENTED to the two BOUND aliases (`leftAlias` = the join's
   * source, `targetAlias` = the target), so aliased / self-joins resolve.
   *
   * The backing lives on the OWNING (belongs-to) relation. A materialized
   * inverse has-many (one carrying an `inverseVia`) REUSES the SAME FK: its
   * forward relation's `relation` backing on the target Type, with the key
   * orientation SWAPPED (the declaring side is now the join's target). A
   * directly-declared has-many (no `inverseVia`) has no forward relation to
   * borrow from and stays on the convention.
   */
  resolveOn(
    engine: QueryEngine,
    relationFieldName: string,
    thisType: Type,
    targetType: Type,
    leftAlias: string,
    targetAlias: string,
  ): ResolvedRelationOn {
    let backing: RelationBacking | undefined;
    let forward: boolean;
    let targetIdentity: string; // belongs-to TARGET identity — the default `foreign`.
    let declarerAlias: string; // bound alias of the belongs-to (declaring) side.
    let joinedAlias: string; // bound alias of the belongs-to target side.
    if (this.isBelongsTo()) {
      // belongs-to: THIS field declares the FK; its backing lives here.
      backing = engine.fieldBacking(thisType.name, relationFieldName)?.relation;
      forward = true;
      targetIdentity = targetType.identityField().name;
      declarerAlias = leftAlias;
      joinedAlias = targetAlias;
    } else {
      // has-many: a materialized inverse borrows its forward relation's backing.
      backing =
        this.inverseVia !== undefined
          ? engine.fieldBacking(targetType.name, this.inverseVia)?.relation
          : undefined;
      forward = false;
      targetIdentity = thisType.identityField().name;
      declarerAlias = targetAlias;
      joinedAlias = leftAlias;
    }
    const keys: readonly RelationOnPair[] =
      backing?.keys && backing.keys.length > 0
        ? relationKeyColumns(backing.keys, forward, targetIdentity)
        : [this.resolveKey(relationFieldName, thisType, targetType)];
    // `on` (custom predicate) takes precedence; the emit sites use it only when
    // it has a mode-applicable path (SQL: `sql`/`expr`; runtime: `run`/`expr`),
    // else they fall back to `keys` — so an inapplicable `on` is a no-op here.
    if (backing?.on) {
      return { keys, custom: { on: backing.on, localAlias: declarerAlias, joinedAlias } };
    }
    return { keys };
  }

  /** Resolve to the `relation` scalar comparison category. */
  resolve(): ScalarKind {
    return 'relation';
  }

  /**
   * A relation is only comparable with another relation to the same Type. It is
   * also the one base a refinement may not narrow, so no declared edge can ever
   * widen this.
   */
  protected override builtinComparableWith(other: FieldType): boolean {
    return other instanceof RelationFieldType && other.to === this.to;
  }

  /**
   * Meet with another relation to the SAME target. What flows through a relation
   * value is the target's IDENTITY, and the two sides agree on it as soon as
   * they agree on `to`; the rest of the shape is not a value constraint —
   * `count` is an ESTIMATE (a materialized inverse derives it from a row ratio),
   * so the meet takes the tighter of the two, and `inverseRelation` /
   * `inverseVia` describe the SCHEMA EDGE rather than the value, so they are
   * dropped rather than reconciled — a merged relation is a type for a bound
   * VALUE, never an edge anything traverses. Two identical relations never reach
   * here (`meet` short-circuits), so nothing is lost by dropping them.
   */
  protected override meetWith(other: FieldType): FieldType | undefined {
    if (!(other instanceof RelationFieldType) || other.to !== this.to) return undefined;
    return new RelationFieldType(this.to, Math.min(this.count, other.count));
  }

  /** Estimated average stored byte size (a short id string). */
  protected override builtinAvgBytes(): number {
    // Foreign-key identifier — roughly a short id string.
    return 16;
  }

  /** SQL column type for the stored identifier reference. */
  toSQLType(): string {
    // Relations are stored as identifier references.
    return 'text';
  }

  /** Zod schema validating a relation value (the related row's identifier). */
  protected override builtinValueSchema(_opts?: ValueSchemaOptions): z.ZodTypeAny {
    // The value of a relation field is the related row's identifier.
    return z.string();
  }

  /** Serialize to its JSON def (`inverseVia` is internal, never emitted). */
  /** Serialize to its JSON def, carrying any `as` refinement (see `FieldType.toJSON`). */
  override toJSON(): RelationFieldTypeDef {
    return this.withRefinementKey(this.builtinJSON());
  }

  protected override builtinJSON(): RelationFieldTypeDef {
    // `inverseVia` is internal materialization state, never serialized.
    const def: RelationFieldTypeDef = { kind: RelationFieldType.NAME, to: this.to, count: this.count };
    if (this.inverseRelation !== undefined) def.inverseRelation = this.inverseRelation;
    return def;
  }

  /** A copy of this relation (preserving internal `inverseVia`). */
  /** A copy of this field type, refinement included (see `FieldType.clone`). */
  override clone(): RelationFieldType {
    return this.sameRefinement(this.builtinClone());
  }

  protected override builtinClone(): RelationFieldType {
    return new RelationFieldType(this.to, this.count, this.inverseRelation, this.inverseVia);
  }
}

const _check: FieldTypeClass = RelationFieldType;
void _check;
