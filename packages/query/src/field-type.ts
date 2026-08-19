/**
 * Abstract `FieldType` base class + the `FieldTypeClass` static contract.
 *
 * Mirrors gin's `Type`/`type.ts` canonical shape (`static NAME` / `static
 * from` / `static toSchema`, instance `toJSON` / `toValueSchema` / `clone`)
 * but specialized for a query language's field types. A FieldType is a
 * pure *value category* — it never carries nullability (that lives on the
 * `Field` wrapping it) and never holds engine/runtime state.
 *
 * Subclasses (one file each under `field-types/`) implement the 8 builtin
 * kinds. Dispatch from JSON happens in the `Registry` via a `kind → class`
 * map — never a central switch in this file.
 */
import { z } from 'zod';
import type { FieldTypeDef, FieldTypeKind, FieldValueDef, JsonValue } from './schema';
import type { CodeOptions, Node, SchemaOptions, ValueSchemaOptions } from './node';
import type { Registry } from './registry';
import type { FieldTypeRefinement } from './refinement';
import type { TextCasing } from './text-casing';
import { eqSelectivityOf, isClosedSetMember, type ClosedSetViolation } from './field-types/_values';
import { meetExact, meetRefinementOptions, sameJson } from './field-types/_meet';

/**
 * The underlying primitive categories, as an array — the source of both the
 * {@link ScalarKind} union and the runtime membership check a refinement's
 * `base` is held to.
 */
export const SCALAR_KINDS = [
  'number',
  'text',
  'bool',
  'date',
  'timestamp',
  'json',
  'money',
  'relation',
  'array',
] as const;

/**
 * The underlying primitive category a field type resolves to. This is the
 * comparability / SQL-bucket of the type, distinct from the richer `kind`
 * (e.g. both `number` and `money` are numeric, but `money` is its own
 * kind). Used by `comparableWith`, cost estimation, and SQL emission.
 */
export type ScalarKind = (typeof SCALAR_KINDS)[number];

/**
 * `ScalarKind` and `FieldTypeKind` must name exactly the same members, and this
 * is the only thing holding them together.
 *
 * A REFINEMENT's `base` is both its value bucket (`resolve()`) and the wire
 * `kind` it renders under (`{ kind: 'text', as: 'uuid' }`), so a member in one
 * vocabulary and not the other is a base that cannot be spelled. Divergence
 * stops compiling HERE rather than at the first declaration that trips over it.
 */
type Assert<T extends true> = T;
type _ScalarKindIsAFieldTypeKind = Assert<
  ScalarKind extends FieldTypeKind ? (FieldTypeKind extends ScalarKind ? true : false) : false
>;

/**
 * A bare SQL token — what {@link FieldType.tokenSafeValues} holds a closed set's
 * members to. Deliberately the same charset `refinement.ts` splices into a
 * template (`TEMPLATE_VALUE_PATTERN`); it is restated here rather than imported
 * because `refinement.ts` already imports this module, and one of the two has to
 * own it. The pair is pinned by a test.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_]+$/;

/** Categories considered mutually numeric for comparison purposes. */
const NUMERIC_KINDS: ReadonlySet<ScalarKind> = new Set<ScalarKind>(['number', 'money']);
/** Categories considered mutually temporal for comparison purposes. */
const TEMPORAL_KINDS: ReadonlySet<ScalarKind> = new Set<ScalarKind>(['date', 'timestamp']);

/**
 * Static-side contract every concrete FieldType class satisfies, so the
 * Registry can dispatch JSON parsing by `kind`. Analogous to gin's
 * `TypeClass`.
 */
export interface FieldTypeClass {
  /** The `kind` discriminant this class handles (e.g. `'number'`). */
  readonly NAME: FieldTypeKind;
  /**
   * Build an instance from its JSON branch. Receives the full union for a
   * uniform signature; implementations narrow on `kind` (a type guard, no
   * cast) and reject mismatches. The optional `registry` is supplied by
   * `Registry.parseFieldType` so COMPOSITE field types (e.g. `array`, whose
   * `item` is itself a `FieldTypeDef`) can reconstruct their nested children;
   * scalar field types ignore it.
   */
  from(json: FieldTypeDef, registry?: Registry): FieldType;
  /** Zod schema for this field type's JSON `*FieldTypeDef` branch. */
  toSchema(opts?: SchemaOptions): z.ZodTypeAny;
}

/**
 * Abstract base for all field types. Concrete subclasses store their own
 * strongly-typed options object and implement the abstract members below.
 */
export abstract class FieldType implements Node {
  /** The `kind` discriminant (matches the subclass's `static NAME`). */
  abstract readonly kind: FieldTypeKind;

  // ─── Refinement (`as`) ────────────────────────────────────────────────
  //
  // A REGISTERED refinement narrows a builtin under a name (`{kind:'text',
  // as:'uuid'}`) — see `refinement.ts`. It rides on the BUILTIN instance rather
  // than on a class of its own, which is what keeps every `instanceof
  // TextFieldType` check and every `def.kind === 'text'` narrowing correct for a
  // refined column. The four members below are the only places the builtin's own
  // answer is overridable, and each is a template method: the base decides,
  // the subclass supplies the BUILTIN half.

  /** The refinement this instance carries; set only through {@link withRefinement}. */
  private declaredRefinement: FieldTypeRefinement | undefined;

  /**
   * This COLUMN's values for the options the refinement declares for ITSELF
   * (`{ subtype: 'Polygon' }`), canonicalized (keys sorted) and holding only
   * what the column actually said — a defaulted option is absent here and
   * resolved on read (`FieldTypeRefinement.optionValue`).
   *
   * A separate bag from the builtin's own options because the two are validated
   * by different declarations, and because the flat lattice they meet through is
   * not the one the builtin's bag meets through. `undefined` for every unrefined
   * type and for every refined one that took all its defaults, so an existing
   * def serializes exactly as it did.
   */
  private declaredOptions: Readonly<Record<string, JsonValue>> | undefined;

  /** The registered refinement narrowing this type, or `undefined` for a plain builtin. */
  get refinement(): FieldTypeRefinement | undefined {
    return this.declaredRefinement;
  }

  /**
   * The registered refinement's NAME — the `as` on the wire — or `undefined`.
   * It renders VERBATIM wherever a model sees it.
   */
  get as(): string | undefined {
    return this.declaredRefinement?.name;
  }

  /** This column's own values for its refinement's declared options — the `with` bag, or `undefined`. */
  get refinementOptions(): Readonly<Record<string, JsonValue>> | undefined {
    return this.declaredOptions;
  }

  /**
   * The EFFECTIVE value of the refinement option `key` — this column's own, else
   * the refinement's declared default, else `undefined`. The one accessor every
   * consumer (SQL emission, the description, the meet) asks, so "the column said
   * nothing" and "the type's default" can never diverge.
   */
  refinementOption(key: string): JsonValue | undefined {
    return this.declaredRefinement?.optionValue(key, this.declaredOptions);
  }

  /**
   * A COPY of this type tagged with `refinement` and its `options` (or `this`,
   * when it already carries exactly those).
   *
   * The CHECKED road is `Registry.parseFieldType` / `FieldTypeRefinement.refine`,
   * which meets the site's options against the declaration's and validates the
   * `with` bag before tagging. This is the unchecked constructor half — same
   * caveat as `new TextFieldType({...})`, which does not validate either.
   */
  withRefinement(
    refinement: FieldTypeRefinement | undefined,
    options?: Readonly<Record<string, JsonValue>>,
  ): FieldType {
    // The identity short-circuit compares the BAG too, not just the tag — the
    // meet relies on `x ⊓ x === x` being exact, and two columns of one type
    // differing only in an option are not the same type.
    if (refinement === this.declaredRefinement && sameJson(options, this.declaredOptions)) return this;
    const copy = this.builtinClone();
    copy.declaredRefinement = refinement;
    copy.declaredOptions = refinement === undefined ? undefined : options;
    return copy;
  }

  // ─── JSON round-trip ──────────────────────────────────────────────────

  /**
   * Serialize to the matching `*FieldTypeDef` JSON branch, plus the `as` of any
   * refinement it carries. Appended LAST and only when present, so an unrefined
   * type serializes byte-for-byte as it always did — which matters because
   * `meet` compares two types by their serialized form.
   */
  toJSON(): FieldTypeDef {
    return this.withRefinementKey(this.builtinJSON());
  }

  /** The BUILTIN's own JSON def, without any refinement key. */
  protected abstract builtinJSON(): FieldTypeDef;

  /**
   * `own` with this type's `as` appended, or `own` unchanged. Generic in the
   * BRANCH, so a concrete class can re-declare `toJSON()` with its own
   * `*FieldTypeDef` return type and route through here without losing it.
   *
   * The base's `toJSON()` above is what makes those re-declarations a pure TYPE
   * refinement rather than a rule a new class can forget: a class that declares
   * no `toJSON()` of its own still serializes its refinement.
   */
  protected withRefinementKey<T extends FieldTypeDef>(own: T): T {
    const as = this.as;
    if (as === undefined) return own;
    const options = this.declaredOptions;
    return options === undefined ? { ...own, as } : { ...own, as, with: options };
  }

  /** Deep-copy this field type, refinement included. */
  clone(): FieldType {
    return this.sameRefinement(this.builtinClone());
  }

  /** Deep-copy the BUILTIN half — the options bag and nothing else. */
  protected abstract builtinClone(): FieldType;

  /** `copy` carrying THIS type's refinement and its options — the shared half of {@link clone}. */
  protected sameRefinement<T extends FieldType>(copy: T): T {
    copy.declaredRefinement = this.declaredRefinement;
    copy.declaredOptions = this.declaredOptions;
    return copy;
  }

  // ─── SQL, as the refinement declares it ───────────────────────────────────

  /**
   * The refinement's declared SQL type for `dialect` — resolved against THIS
   * column's own options — or `undefined` to keep the builtin's answer.
   *
   * On the FieldType rather than read off `refinement` directly, because the
   * option values live here: `Dialect.sqlTypeFor` would otherwise have to know
   * that a refinement's template takes a bag, and every dialect would have to
   * remember to pass it.
   */
  refinedSqlType(dialect: string): string | undefined {
    return this.declaredRefinement?.sqlType(dialect, this.declaredOptions);
  }

  /** The refinement's declared cast for `dialect`, resolved against this column's own options. */
  refinedCast(dialect: string): readonly string[] | undefined {
    return this.declaredRefinement?.cast(dialect, this.declaredOptions);
  }

  // ─── Category / comparability ─────────────────────────────────────────

  /** The underlying primitive category this type resolves to. */
  abstract resolve(): ScalarKind;

  /**
   * Whether a value of this type can be meaningfully compared with one of
   * `other` — the builtin category rule, PLUS any edge the two types'
   * refinements declare (`comparableWith`).
   *
   * FINAL, and the declared half is added here rather than in the subclasses so
   * a builtin that narrows the rule (`json` compares only with `json`) cannot
   * accidentally shut a declared edge out. Subclasses override
   * {@link builtinComparableWith}.
   *
   * The declared half only ever ADDS. That is what keeps "a meet implies
   * comparability" true with no carve-out: a superset of a relation the meet was
   * already inside is still a superset (see `FieldTypeRefinementDefFor.comparableWith`).
   */
  comparableWith(other: FieldType): boolean {
    if (this.builtinComparableWith(other)) return true;
    const a = this.declaredRefinement;
    const b = other.declaredRefinement;
    return a !== undefined && b !== undefined && a.comparableTo(b.name);
  }

  /**
   * The BUILTIN comparability rule: same category, with number/money and
   * date/timestamp treated as mutually comparable families. Subclasses override
   * for stricter or looser rules.
   */
  protected builtinComparableWith(other: FieldType): boolean {
    const a = this.resolve();
    const b = other.resolve();
    if (a === b) return true;
    if (NUMERIC_KINDS.has(a) && NUMERIC_KINDS.has(b)) return true;
    if (TEMPORAL_KINDS.has(a) && TEMPORAL_KINDS.has(b)) return true;
    return false;
  }

  /**
   * Whether EVERY value this type admits renders as a bare SQL token
   * (`^[A-Za-z0-9_]+$`) — the question `registerFieldType` asks of an option a
   * `sql` / `cast` template interpolates, since a template's values are its
   * whole injection surface.
   *
   * Declared ON THE TYPE rather than as a switch over kinds in `refinement.ts`,
   * so a tenth field type answers for itself instead of falling into whichever
   * arm a `default:` happened to pick. The default answer is the closed set's: a
   * type with a `values` set admits exactly those, so it is token-safe when they
   * all are, and a type with no set admits an unbounded range and is not.
   */
  tokenSafeValues(): boolean {
    const values = this.values();
    return values !== undefined && values.every((v) => TOKEN_PATTERN.test(String(v.value)));
  }

  /**
   * The CLOSED SET of values THIS type admits, or `undefined` when it declares
   * none (the unconstrained default). Total on the value-category union so
   * every consumer of membership — equality selectivity, the model-facing
   * description, `toValueSchema`, the write check, the param meet — asks ONE
   * question instead of testing for the classes that happen to carry a `values`
   * option today.
   *
   * It is deliberately NOT recursive. A CONTAINER declares no set of its own —
   * an `array<text one of a|b>` admits ARRAYS, not `a` and `b` — so surfacing
   * its element's set here would make `eqSelectivity` answer `1/n` for a
   * predicate that compares whole arrays, and would render the column as
   * `array one of a|b`. The element's set reaches the behaviours that DO make
   * sense for a container by other roads: `toValueSchema` validates
   * element-wise, {@link closedSetViolation} walks into elements, `meet` meets
   * element types, and the description renders the item type inside `array<…>`.
   */
  values(): readonly FieldValueDef[] | undefined {
    return undefined;
  }

  /**
   * The first closed-set violation in `raw`, or `undefined` when there is none.
   * The recursive counterpart to {@link values}: it answers for a whole written
   * VALUE, so a container walks into its elements.
   *
   * It exists because the write check cannot be one accessor deep. Asking only
   * `values()` accepted `SET tags = ['bogus']` on an `array<text one of a|b>`
   * silently — while that column's own `toValueSchema()` rejected the very same
   * array — so a value the type refused reached SQL. Asking `validValue(raw)`
   * instead would have over-reached in the other direction, turning every
   * declared bound (`minLength`, `min`/`max`) into a write-time refusal, which
   * is a different feature. This asks exactly the membership question, at every
   * depth.
   */
  closedSetViolation(raw: JsonValue): ClosedSetViolation | undefined {
    const values = this.values();
    if (!values || isClosedSetMember(values, raw)) return undefined;
    return { at: [], value: raw, values };
  }

  /**
   * The fraction of rows a non-indexed EQUALITY predicate on a column of this
   * type is expected to keep, when the type itself knows better than the
   * package-wide `EQ_SELECTIVITY` guess. A closed value set of `n` members
   * answers `1/n`: a two-value flag keeps half the table, a fifty-value code
   * keeps 2% — otherwise both would be costed at the same fixed third.
   * `undefined` means "no better estimate; use the fixed one".
   *
   * Derived from {@link values} rather than overridden per class, so a type
   * that declares a closed set cannot forget to declare its selectivity —
   * `money` did exactly that, carrying a `values` set through its inner
   * `NumberOptions` and still costing `= x` at the fixed guess.
   */
  eqSelectivity(): number | undefined {
    return eqSelectivityOf(this.values());
  }

  /**
   * The MEET of this type and `other`: the most specific type whose values
   * satisfy BOTH, or `undefined` when no such type exists.
   *
   * The constructive form of {@link comparableWith} — and a STRICTLY stronger
   * question. `comparableWith` asks whether the two live in the same value
   * category; a meet also has to reconcile their CONSTRAINTS, so two `text`
   * types with disjoint closed sets are comparable and have no meet. (The
   * converse never happens: a meet implies comparability.) A custom FieldType
   * that widens `comparableWith` should override {@link meetWith} to match, or
   * the two answers drift apart.
   *
   * It exists for bind params, which are typed from EVERY place they are used
   * (`ParamSet`): `enum ⊓ text = enum`, `text{minLength:5} ⊓ text{maxLength:10}`
   * carries both bounds, and `enum{a,b} ⊓ enum{b,c} = enum{b}`. The operation is
   * commutative, associative and idempotent — see `field-types/_meet.ts` — which
   * is what makes the inferred type independent of the order the walk happened
   * to visit the uses in. It is also SOUND: the meet accepts nothing that both
   * operands do not. All four are property-tested (`param-meet.test.ts`).
   *
   * IT IS THE *GREATEST* LOWER BOUND FOR EVERY TYPE BUILT THROUGH `from` — AND
   * ONLY A LOWER BOUND FOR ONE BUILT BY HAND. The distinction is the whole of
   * the caveat, so it is worth stating exactly.
   *
   * A closed set IS the value schema (`toValueSchema` short-circuits on it), so
   * a meet narrows a merged set by the merged scalar constraints. For a
   * SELF-INCONSISTENT type — one whose own set and own constraints disagree —
   * that narrowing bites even against the unconstrained type of its own kind:
   *
   *     x = new TextFieldType({ values:['ab'], minLength:5 })
   *     x.validValue('ab')  ⇒  true        (the set short-circuits the bound)
   *     x ⊓ text            ⇒  undefined   (not x)
   *
   * The narrowing itself is not optional — keeping `1` from
   * `text{values:[1,'b']} ⊓ text` would ADMIT a value plain `text` refuses, i.e.
   * break soundness, which is the law a validator actually depends on. So the
   * declaration is what had to go: since `0.6.6` such a set is REFUSED where
   * declarations are read (`field-type.bad-values` from `from` / `parseType`,
   * plus a per-kind member schema that no longer offers a `number` field a text
   * member). Over everything a DEF can express, `x ⊓ ⊤ = x` therefore holds
   * unconditionally, and `param.conflict` can no longer blame a query for a
   * defect in the type.
   *
   * The public CONSTRUCTORS still do not validate — the same caveat
   * `TextOptions.pattern` carries for an uncompilable regex — so
   * `new TextFieldType({ values:['ab'], minLength:5 })` remains buildable and
   * remains a lower bound only. `param-meet.test.ts` asserts the law over a type
   * set it first proves `parseFieldType` can build, and exercises the hand-built
   * road separately, so neither half can rot into the other.
   */
  meet(other: FieldType): FieldType | undefined {
    // Identical types short-circuit, which is what makes the meet EXACTLY
    // idempotent: no option is re-derived, no member list is re-ordered, and a
    // (self-contradictory) type is never quietly narrowed against itself.
    //
    // The premise below — "same kind + same builtin JSON ⇒ interchangeable" —
    // holds for every type whose JSON captures its identity, which is every
    // builtin EXCEPT `relation`: `inverseVia` is deliberately never serialized,
    // so two JSON-identical relations can differ in it and `a ⊓ b` / `b ⊓ a` can
    // return different OBJECTS. Harmless as used (a param's relation type is
    // never traversed as a join, and `toJSON` erases the difference anyway), but
    // worth knowing before reaching for `meet` outside param inference.
    if (this === other) return this;
    // The REFINEMENT meets through the flat `meetExact` lattice, INDEPENDENTLY
    // of the options bag: a registered name meets only itself, and an unrefined
    // base is TOP, so a refinement meets its own base to the refinement. That is
    // the whole of the `as` algebra — the composition of two independent meets
    // is a meet, so commutativity, associativity, idempotence and soundness all
    // carry over from `meetWith` with no new law to prove.
    //
    // The operands are the compiled INSTANCES, not the names. Two registries can
    // compile one name differently, and taking the left operand's instance made
    // `a ⊓ b` and `b ⊓ a` — JSON-identical, so a property test comparing defs is
    // blind to it — admit different VALUES and answer different `sqlType` /
    // `avgBytes`. Same name, different compilation, is a genuine conflict: there
    // is no third refinement that is both.
    const as = meetExact(this.declaredRefinement, other.declaredRefinement);
    if (!as.ok) return undefined;
    // The refinement's OWN options meet the same way, per key: unset is TOP,
    // equal keeps, different conflicts. A single-valued attribute has no other
    // lattice — there is no third SRID that is both 4326 and 3857 — and it is the
    // rule `pattern` / `currency` / `timezone` already follow, so the three laws
    // carry over unchanged. An UNREFINED operand contributes no bag at all, which
    // is why `Geometry{srid:3857} ⊓ json` keeps 3857 rather than conflicting with
    // the declared default.
    const withOptions = meetRefinementOptions(this.declaredOptions, other.declaredOptions);
    if (!withOptions.ok) return undefined;
    // The short-circuit compares the BUILTIN halves, not the full defs, for the
    // same reason the two halves meet separately: `meetWith`'s documented
    // default is "no meet", and it is only correct for an option-less kind
    // BECAUSE two such types were always JSON-identical and never reached it.
    // A refinement breaks that premise — `bool{as:'Flag'}` and plain `bool` are
    // not JSON-identical — so comparing full defs would send an option-less kind
    // into a default that answers `undefined`, and `x ⊓ ⊤ = x` would fail for
    // every refinement over `bool`, `date` or `json`.
    const met = this.kind === other.kind && sameJson(this.builtinJSON(), other.builtinJSON())
      ? this
      : this.meetWith(other);
    if (met === undefined) return undefined;
    // A refinement refines exactly ONE base kind, and `FieldTypeRefinement.refine`
    // refuses any other pairing — so the tag survives only if the MET type is
    // still that kind. The two cross-kind families (`number`/`money`,
    // `date`/`timestamp`) answer with whichever side is the more specific, so a
    // meet can legitimately change kind underneath a tag: `money{as:'Usd'} ⊓
    // number` is still a money and keeps it, while `number{as:'Score'} ⊓ money`
    // is a MONEY and cannot.
    //
    // THE CHECK IS ON THE RESULT, NOT ON THE TWO OPERANDS' KINDS, and that is the
    // load-bearing half. Refusing whenever the operands' kinds differ is NOT
    // ASSOCIATIVE — `money ⊓ number` is a money, so `usd ⊓ (money ⊓ number)`
    // succeeds where `(usd ⊓ money) ⊓ number` fails (measured: 176 mismatches
    // over the property set). Asking about the RESULT is stable however a fold
    // groups, because the check ESTABLISHES its own premise: a surviving tag
    // implies `kind(a ⊓ b) === r.base`, so a later meet against that result can
    // only move to the strictly more specific side of the family — which is
    // absorbing in both families, so the outer check fires too and the two
    // groupings agree.
    //
    // Two further reasons for REFUSING rather than dropping the tag, both real
    // and both weaker than the one above: stapling it on regardless produced
    // `{kind:'money', …, as:'Score'}`, a def this very registry throws on, which
    // reached callers through `params()`; and dropping it is outright UNSOUND —
    // it drops the refinement's stricter value gate, so `score ⊓ money` would
    // admit a `7` that `score` itself refuses.
    if (as.value !== undefined && met.kind !== as.value.base) return undefined;
    // The bag rides with the TAG: a dropped tag drops the options it belonged to,
    // because an option is meaningless without the declaration that named it.
    return met.withRefinement(as.value, as.value === undefined ? undefined : withOptions.value);
  }

  /**
   * The kind-specific half of {@link meet}, reached only for two types that are
   * NOT already identical. A type carrying options overrides it to reconcile
   * them, and a type comparable ACROSS kinds (`number`/`money`,
   * `date`/`timestamp`) delegates to whichever side is the more specific.
   *
   * The default is "no meet", which is exactly right for a kind with NO
   * options — two such types are always JSON-identical, so `meet` has already
   * answered and this is never reached for them — and deliberately fail-LOUD
   * for a kind that gains options and forgets to override: reporting a spurious
   * `param.conflict` is visible, whereas the tempting default of "same kind ⇒
   * return `this`" would silently pick the left operand, which is the
   * order-dependence this whole mechanism exists to remove.
   */
  protected meetWith(_other: FieldType): FieldType | undefined {
    return undefined;
  }

  /**
   * The {@link TextCasing} this type DECLARES for textual matching /
   * comparison, or `undefined` when it declares none — in which case the
   * engine's `textCasing` default applies (see `text-casing.ts`).
   *
   * `undefined` is a distinct answer from any of the three casings, and the
   * distinction is what keeps a declaration authoritative: a type that says
   * nothing INHERITS the deployment's default, and can never out-vote a field
   * that did say something. Only `text` declares one; every other kind
   * case-folds nothing, so the question is moot for it — a comparison with a
   * non-text operand never consults a casing at all.
   */
  textCasing(): TextCasing | undefined {
    return undefined;
  }

  // ─── Value validation / schema ────────────────────────────────────────

  /**
   * Zod schema for a raw JS VALUE of this field type, honoring options
   * (e.g. number min/max/int, text length/pattern). Distinct from the
   * static `toSchema`, which schemas the JSON *definition*.
   *
   * A refinement's declared `value` is applied as a CONJUNCTION, never as a
   * replacement. It is a stricter gate on the BASE, but a use site may narrow
   * further (`{kind:'text', as:'uuid', pattern:'^a'}`), and answering with the
   * declaration's schema alone would ADMIT a value the field's own options
   * refuse — i.e. break the soundness law the meet is property-tested against.
   */
  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    const builtin = this.builtinValueSchema(opts);
    const declared = this.declaredRefinement?.value;
    return declared === undefined ? builtin : z.intersection(builtin, declared);
  }

  /** The BUILTIN's own value schema, before any refinement narrows it. */
  protected abstract builtinValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny;

  /**
   * Whether `raw` is a valid value of this type. Default: delegate to
   * `toValueSchema`. Subclasses rarely need to override.
   */
  validValue(raw: JsonValue): boolean {
    return this.toValueSchema().safeParse(raw).success;
  }

  // ─── Cost / storage ───────────────────────────────────────────────────

  /**
   * Estimated average bytes a value of this type occupies — a refinement's
   * declared estimate when it has one (a `uuid` stores 16 bytes, not the 32 an
   * unbounded `text` is guessed at), else the builtin's.
   */
  avgBytes(): number {
    return this.declaredRefinement?.avgBytes ?? this.builtinAvgBytes();
  }

  /** The BUILTIN's own byte estimate, before any refinement corrects it. */
  protected abstract builtinAvgBytes(): number;

  // ─── SQL ──────────────────────────────────────────────────────────────

  /**
   * A neutral base SQL type name for this field type. Phase 5 dialects may
   * override per-dialect; to avoid a phase-5 dependency this signature
   * takes no dialect and returns a generic ANSI-ish type string.
   */
  abstract toSQLType(): string;

  // ─── Node ─────────────────────────────────────────────────────────────

  /** Short readable description — the kind plus any salient options. */
  toCode(_registry?: Registry, _options?: CodeOptions): string {
    return this.kind;
  }
}
