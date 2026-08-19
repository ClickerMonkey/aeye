/**
 * FIELD-TYPE REFINEMENTS — a registered NAME over a builtin base.
 *
 * `{ kind: 'text', as: 'uuid' }` is a `text` column that a deployment has named
 * `uuid` and narrowed once, centrally, instead of at every declaration site. The
 * spelling is deliberate and it is the whole reason this feature is affordable:
 *
 *  - the wire `kind` stays one of the nine builtins, so `ScalarKind` never
 *    opens, every `def.kind === 'text'` narrowing and every `instanceof
 *    TextFieldType` check stays correct by construction, and the exhaustiveness
 *    guards in the SQL / cost / value-schema switches stay unreachable;
 *  - a DECLARATION is pure JSON, so it can be persisted, sent over the wire and
 *    shown to a model, while the CODE half ({@link FieldTypeImpl}) is a separate
 *    registration — the same split `FunctionDef` has to `FunctionRun`, and for a
 *    measured reason rather than symmetry (see {@link FieldTypeImpl});
 *  - the library COMPILES the declaration into a builtin instance. A declarer
 *    never writes a `FieldType` subclass, never writes `meetWith`, and therefore
 *    cannot break the lattice laws `param-meet.test.ts` proves.
 *
 * WHAT IT BUYS, measured. A catalog that declares `id: { kind: 'text' }` at ~40
 * sites emits `LOWER("t"."id") = LOWER($1)` for every id predicate — index-
 * defeating, and a hard `function lower(uuid) does not exist` over a physical
 * uuid column. One `uuid` refinement declaring `casing: 'exact'` turns all forty
 * into a bare, sargable `=`, and it does so through the ordinary meet rather
 * than through a new rule.
 *
 * NARROWING, NEVER WIDENING. A refinement's `options` are the FLOOR every use of
 * it stands on: a use site's own options are MET with them (`FieldType.meet`),
 * so a site may narrow further and a site that tries to widen is simply absorbed
 * — the met type is a lower bound of both by construction. A site whose options
 * cannot coexist with the declaration's (`as:'uuid'` beside `maxLength: 10`) has
 * no meet at all and is REFUSED where declarations are read, next to
 * `field-type.bad-values` and `field-type.bad-pattern`. That is gin's
 * `Extension.narrow` law, and this package already satisfies it because here the
 * meet IS narrow.
 *
 * TWO OPTION VOCABULARIES, AND THEY STAY APART. `options` narrows the BASE's own
 * vocabulary and is typed straight off `FieldTypeDef`. {@link
 * FieldTypeRefinementDefFor.ownOptions} declares options the base has never
 * heard of (`srid`, `subtype`), each typed by a `FieldTypeDef` of its own, and a
 * site supplies them in a separate `with` bag. They are two bags rather than one
 * because merging them would make a `{maxLength}` template slot ambiguous
 * between the base's option and a refinement's, and would force the strictly-
 * parsed branch schemas open — after which a typo'd base option would be read as
 * somebody's custom one. Both obey the same law from opposite directions: a base
 * option narrows through the OPTIONS meet, an own option through the flat
 * `meetExact` (unset is TOP, equal keeps, different conflicts), which is the
 * only lattice a single-valued attribute has.
 *
 * BOTH ROADS, NOT ONLY SQL. A refinement's SQL half is a declaration
 * (`sql` / `cast`, per dialect); its IN-MEMORY half is
 * {@link FieldTypeImpl.compareValues}, the comparator `Value.compareTo`
 * consults. The two exist to answer the SAME question the same way — a type
 * whose stored SQL ordering differs from its stringified one gives two answers
 * for one query until it declares the comparator, and nothing static can detect
 * that (`differentialCheck` in `conformance.ts` is what can).
 */
import { z } from 'zod';
import { didYouMean } from './aids';
import type { FieldType } from './field-type';
import { SCALAR_KINDS, TOKEN_PATTERN, type ScalarKind } from './field-type';
import type { SchemaOptions } from './node';
import { QueryTypeError } from './problem';
import type { Registry } from './registry';
import type { FieldTypeDef, JsonValue } from './schema';
import { isSlot, scanTemplate, templateSlotNames, type Template, type TemplatePart } from './sql-template';

/**
 * Allowed charset for a registered refinement NAME.
 *
 * A capital is allowed, and that is a deliberate cross-library decision rather
 * than a loose default. A consumer that registers the same logical type in BOTH
 * `@aeye/gin` and this package has to spell it once: gin refuses a package type
 * name that does not START with a capital (a shipped, measured rule — a system
 * package's lower-case `time` silently shadowed a user's `time` in every
 * session), so a lower-case-only rule here would make every such name
 * unspellable in one library or the other. Measured over the two worked
 * examples: `geometry`/`latlng` are refused by gin, `Geometry`/`LatLng` would be
 * refused by a lower-case-only rule here, and no third spelling satisfies both.
 *
 * It is also the rule this package already applies to the OTHER name a third
 * party registers: `FUNCTION_NAME_PATTERN` is `^[A-Za-z_][A-Za-z0-9_.]*$`, which
 * is how `ST_Contains` registers. A dot is excluded here (a refinement name is
 * never schema-qualified and renders inside a type tag), and so is a leading
 * underscore (it reads as private in every language a declarer comes from).
 */
export const REFINEMENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The `{value}` slot of a `cast` template — the bound parameter, the ONE slot a
 * cast cannot resolve at registration because it is per-row data.
 */
const CAST_VALUE_SLOT = 'value';

/**
 * What an option value may look like when it is INTERPOLATED into a SQL
 * template. Templates are raw-interpolated (exactly as `${fn.sql}(` already is),
 * so the values spliced into them are the injection surface — not the template
 * body, which the declarer wrote. A bare identifier / number token is the widest
 * thing that is safe with no quoting rules of its own, and it covers every real
 * case (`Point`, `4326`, `36`, `USD`).
 *
 * An ALIAS of `FieldType.TOKEN_PATTERN`, not a copy. The two guard one fact from
 * opposite ends — `tokenSafeValues()` proves at REGISTRATION that every member
 * of a closed option type is a token, this proves at PARSE that each written
 * value is — so a charset that drifted by one character would let a member pass
 * the declaration and then refuse every column that wrote it. The local name is
 * kept because it says what the charset is FOR here.
 */
const TEMPLATE_VALUE_PATTERN = TOKEN_PATTERN;

/**
 * Stand-in tokens a template is CHECKED against at registration, once an
 * author-declared option can put a different value in the same slot on every
 * column.
 *
 * Through step 1 every slot resolved to a constant, so checking the RESOLVED
 * string against {@link SQL_TYPE_PATTERN} settled the question once. An
 * `ownOptions` slot does not: `{subtype}` is `Point` on one column and `Polygon`
 * on the next, and refusing at EMIT — the only place the real value is known —
 * would be a failure with no declaration to attribute it to. So the check moves
 * to the shape of the token rather than its identity.
 *
 * These three probe the only distinctions {@link SQL_TYPE_PATTERN} draws over
 * the {@link TEMPLATE_VALUE_PATTERN} charset: a token may start with a letter,
 * an underscore or a digit, and after the first character every remaining class
 * is a superset of the others. A template that resolves to a legal SQL type name
 * under ALL THREE therefore does so under every value the option can hold —
 * `{srid}` inside `geometry(Point,{srid})` passes, `{srid}_geom` (which would
 * emit `4326_geom`) is refused at the DECLARATION rather than on the one column
 * that happens to trip it.
 */
const TEMPLATE_PROBE_TOKENS: readonly string[] = ['a', '_', '0'];

/**
 * What a fully-resolved `sql` entry may look like. It lands in a raw
 * `CAST(… AS <here>)` slot, so it is held to the shape of a SQL TYPE NAME:
 * an identifier, optionally parameterized (`varchar(36)`, `geometry(Point,4326)`),
 * optionally an array (`text[]`), optionally multi-word (`timestamp with time
 * zone`).
 */
const SQL_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\([A-Za-z0-9_, ]*\))?(\[\])?$/;

/**
 * The OPTION BAG of one builtin branch — that branch's own def minus the
 * discriminant and the two refinement keys.
 *
 * DERIVED from `FieldTypeDef`, never restated: an option added to a builtin is
 * immediately declarable on a refinement of it, and an option removed from one
 * stops compiling at every declaration that still names it.
 */
export type FieldTypeOptionsOf<B extends ScalarKind> = Omit<
  Extract<FieldTypeDef, { kind: B }>,
  'kind' | 'as' | 'with'
>;

/**
 * One option a refinement declares FOR ITSELF — an option its base has never
 * heard of (`srid`, `subtype`), supplied per column in the def's `with` bag.
 *
 * `type` is an ordinary {@link FieldTypeDef}, so validation, the model-facing
 * description and the JSON round-trip all come from machinery that already
 * exists — the same reason `FunctionDef.params` types its parameters that way
 * rather than inventing a second vocabulary.
 */
export interface FieldTypeOptionDecl {
  /**
   * The option's own type, in this package's field-type vocabulary. A site's
   * value is checked against it with {@link FieldType.validValue}, at parse,
   * where the def is read.
   */
  readonly type: FieldTypeDef;
  /**
   * The value a column that names none carries. REQUIRED for an option any
   * `sql` / `cast` template interpolates — a template must resolve for EVERY
   * column, and "the site said nothing" is otherwise a hole with no answer.
   */
  readonly default?: JsonValue;
  /** What the option means, for a model. Rendered beside it in the generated schema. */
  readonly docs?: string;
}

/**
 * The OPERATOR each arm of {@link FieldTypeCompareDecl} governs, as a model
 * would write it — the one vocabulary every renderer of a refused arm derives
 * from.
 *
 * A total `Record` over the arms, and it is the ONLY place the arm key set is
 * spelled outside the interface itself. It was spelled twice more, as
 * `if (!compare.equality) …` chains in two files with two different glyph
 * vocabularies — so a FOURTH arm would have compiled clean and been mentioned by
 * neither the type tag nor the generated schema's glossary, which is exactly the
 * failure those renderers exist to prevent. Adding an arm now fails to compile
 * here, and both readers pick it up for free.
 */
export const COMPARE_ARM_OPERATORS: Readonly<Record<keyof FieldTypeCompareDecl, string>> = {
  equality: '=',
  ordering: '<',
  textMatch: 'LIKE',
};

/**
 * The operators a refinement REFUSES, in a stable order — the shared half of
 * every "what can I not write on this column" rendering.
 */
export function refusedOperators(compare: Required<FieldTypeCompareDecl>): string[] {
  const arms: (keyof FieldTypeCompareDecl)[] = Object.keys(COMPARE_ARM_OPERATORS) as (keyof FieldTypeCompareDecl)[];
  return arms.filter((arm) => !compare[arm]).map((arm) => COMPARE_ARM_OPERATORS[arm]);
}

/**
 * WHICH ARMS OF THE BUILTIN COMPARISON GRAMMAR a refinement admits.
 *
 * `ComparisonOp` is a closed 9-member union (`=`, `<>`, `<`, `<=`, `>`, `>=`,
 * `like`, `notLike`, `ilike`) and it STAYS closed — what a type declares is
 * which of them mean anything for it, not a new one. Every arm defaults to
 * `true`, so an existing declaration keeps the grammar it always had.
 *
 * The refusal is `Problems`-grade (`comparison.type`) and quotes the type's own
 * `instructions`, because "you cannot order a geometry" is only half an answer:
 * the half that saves a round trip is what to reach for instead, and the
 * declaration is the one place that knows.
 */
export interface FieldTypeCompareDecl {
  /** `=` / `<>`. Default `true`. */
  readonly equality?: boolean;
  /** `<` / `<=` / `>` / `>=`. Default `true`. */
  readonly ordering?: boolean;
  /**
   * `like` / `notLike` / `ilike`. Default `true`. Already gated by the operand's
   * CATEGORY being text, so this narrows a text refinement and is simply moot
   * for the other eight bases.
   */
  readonly textMatch?: boolean;
}

/**
 * A field-type refinement DECLARATION, for one base `B`. The union over every
 * base is {@link FieldTypeRefinementDef}, which is what `registerFieldType`
 * takes; splitting it per-base is what makes `options` narrow to the base's own
 * vocabulary at the call site.
 */
export interface FieldTypeRefinementDefFor<B extends ScalarKind> {
  /**
   * The registered name — the `as` a field declares. Held to
   * {@link REFINEMENT_NAME_PATTERN}, and it renders VERBATIM everywhere a model
   * reads it (the type tag, the generated `as` enum): never lower-cased, never
   * pluralized, never decorated. A model reads this package's surface and a
   * sibling library's in one session, and a spelling difference between them
   * reads as two different types.
   */
  readonly name: string;
  /** The BUILTIN bucket this refines. Must be a {@link ScalarKind}. */
  readonly base: B;
  /**
   * What the type MEANS, for a model. REQUIRED — and deliberately stricter than
   * `FunctionDef.instructions`, which is optional. Measured: an undocumented
   * registered item renders as a bare signature beside documented siblings, and
   * a model choosing among them is guessing. The expensive failure is not the
   * ~20 tokens of the line, it is the validate-fail retry that carries the
   * WHOLE schema a second time.
   */
  readonly instructions: string;
  /**
   * The narrowing this refinement declares, in the base's own option vocabulary.
   * Every use of the refinement stands on it (see the module docs): a site may
   * narrow further, and a site that contradicts it is refused.
   */
  readonly options?: FieldTypeOptionsOf<B>;
  /**
   * The options this refinement declares FOR ITSELF, beyond its base's
   * vocabulary — `{ srid: { type: { kind:'number', whole:true }, default: 4326 } }`.
   * A column supplies them in its `with` bag.
   *
   * They meet through the flat {@link meetExact} lattice, per key: unset is TOP,
   * equal keeps, and two DIFFERENT values conflict — because there is no third
   * SRID that is both 4326 and 3857, exactly as there is no third `pattern` that
   * is both `^a` and `^b`. So "narrow, never widen" reads here as "a use may SET
   * an option the declaration left open, and may not contradict another use".
   */
  readonly ownOptions?: Readonly<Record<string, FieldTypeOptionDecl>>;
  /**
   * Which arms of the builtin comparison grammar this type admits — see
   * {@link FieldTypeCompareDecl}. Omitted ⇒ all three, i.e. the grammar the base
   * kind already had.
   */
  readonly compare?: FieldTypeCompareDecl;
  /**
   * OTHER registered refinement names a value of this type may be compared
   * with — the declared form of the hardcoded `number`/`money` and
   * `date`/`timestamp` families in `field-type.ts`.
   *
   * It only ever GROWS the comparability relation; it never shrinks it, and that
   * is load-bearing rather than a simplification. `meet` implies
   * `comparableWith` (a property test asserts it over every pair), so a
   * declaration that could REMOVE an edge would have to remove the corresponding
   * meet with it — and the meet a restriction would have to remove is
   * `refinement ⊓ its own unrefined base`, i.e. the `x ⊓ ⊤ = x` identity. One
   * declaration would then owe the lattice a carve-out. Growing the relation
   * owes it nothing: a superset of the meets is still a superset.
   *
   * THE REGISTRY SYMMETRIZES IT. Naming a type that does not name you back
   * records the edge in BOTH directions and files a `warn`-grade note
   * (`Registry.fieldTypeComparabilityNotes`), so commutativity of
   * `comparableWith` is structural rather than the declarer's discipline — and
   * so a name may be declared before the type it names is registered, which
   * mutual pairs otherwise make impossible.
   *
   * It is NOT transitive and is not meant to be: `Meters` may be comparable with
   * `Number` and `Feet` comparable with `Number` while `Meters` and `Feet` are
   * not comparable with each other.
   */
  readonly comparableWith?: readonly string[];
  /**
   * Per-dialect SQL TYPE — the CAST target for a value of this type, keyed by
   * `Dialect.name`. A `{slot}` naming a base `options` key resolves at
   * REGISTRATION (those are constants); a slot naming an {@link ownOptions} key
   * resolves PER COLUMN, from that column's `with` bag or the option's declared
   * `default`. A dialect with no entry falls back to the builtin's answer for
   * the base kind.
   */
  readonly sql?: Readonly<Record<string, string>>;
  /**
   * Per-dialect CAST of a bound DOCUMENT into this type, keyed by
   * `Dialect.name`. `{value}` is the bound parameter slot and must appear at
   * least once; every other `{slot}` names a declared option — a base one
   * resolving at registration, an own one per column (see {@link sql}).
   *
   * ONLY DECLARABLE ON A BASE WHOSE VALUES ROUTE THROUGH `Dialect.jsonValue`
   * (see {@link CAST_CAPABLE_BASES}) — a scalar predicate binds its value
   * directly and there is no seam for a template to reach, so a `cast` on a
   * `text` base would validate at registration and then be silently inert on
   * every predicate over the column. It is refused instead. What a scalar base
   * declares is `sql`, the cast TARGET.
   *
   * A cast-capable base with no entry for a dialect falls back to the BASE's
   * cast — a fallback, not a degrade, because the base's answer is a real answer
   * for a value of the base type.
   */
  readonly cast?: Readonly<Record<string, string>>;
  /** Estimated average stored bytes, when the base's own estimate is wrong (a `uuid` is 16, not 32). */
  readonly avgBytes?: number;
  /**
   * Who declared it — surfaced when a SECOND declarer claims the same name, so
   * the refusal names the incumbent instead of just the collision.
   */
  readonly declaredBy?: string;
}

/**
 * A field-type refinement declaration. A discriminated union over `base`, so
 * `{ base: 'text' }` type-checks its `options` against the `text` branch and
 * nothing else — and `relation` is not a member at all, so an unrefinable base
 * is a COMPILE error rather than only a registration one (the runtime check
 * stays, for a caller with no types).
 */
export type FieldTypeRefinementDef = { [B in RefinableBase]: FieldTypeRefinementDefFor<B> }[RefinableBase];

/**
 * The CODE half of a refinement — `registry.registerFieldTypeImpl(name, impl)`,
 * the exact counterpart of `registerFunctionRun` beside `registerFunction`.
 *
 * IT IS SPLIT FROM THE DECLARATION FOR A MEASURED REASON, not for symmetry. A
 * `FieldTypeRefinementDef` is what a consumer PERSISTS and replays at boot, and
 * a zod schema does not vanish under `JSON.stringify` — it stringifies into a
 * plausible husk that survives the round-trip, passes every registration check,
 * and then throws a raw `TypeError` out of zod's internals at the first
 * `validValue()`: no `QueryTypeError`, no code, no path, and the strictest gate
 * on that column silently dead. Keeping a schema on the declaration would make
 * that the DEFAULT outcome of doing the obvious thing with it. With the split,
 * a declaration is pure JSON and round-trips honestly, and the half that cannot
 * survive a round-trip is the half nobody tries to store.
 */
export interface FieldTypeImpl {
  /**
   * A STRICTER value gate than the base's own (`z.uuid()` for a `uuid`), applied
   * in CONJUNCTION with the field's own schema — never as a replacement, since a
   * use site may narrow further and answering with this alone would admit values
   * the field's own options refuse (see `FieldType.toValueSchema`).
   *
   * `FieldTypeDef` has no record branch, so this is also the declared home of a
   * STRUCTURAL value contract for a refinement whose raw value is an object.
   */
  readonly value?: z.ZodTypeAny;
  /**
   * HOW TWO VALUES OF THIS TYPE ORDER, in the IN-MEMORY runtime — the hook
   * `Value.compareTo` consults before its own rules (`runtime/value.ts`).
   *
   * WHAT IT IS FOR, precisely. `Value.compareTo` compares numbers numerically,
   * booleans false-first, and EVERYTHING ELSE by `String(raw)`. So a refinement
   * whose stored SQL type orders differently from its stringified form answers
   * two different things for one query depending on which road ran it:
   * `{ base:'text', sql:{postgres:'inet'} }` holding `10.0.0.2` and `10.0.0.10`
   * orders them by address at the database (`inet` compares numerically) and
   * lexicographically here (`'10.0.0.10' < '10.0.0.2'`). Declaring a comparator
   * is how the runtime is told what the store already knew.
   *
   * IT GOVERNS EQUALITY TOO, and deliberately: `Value.equals` / `identical` are
   * `compareTo(...) === 0`, so ONE comparator keeps ordering and equality from
   * contradicting each other. That is also why there is no separate
   * `equalValues` — and the reason is the SQL half rather than tidiness. A btree
   * operator class requires its `=` and its `<` to be consistent, so a single
   * comparator is the faithful model of the thing the emitted statement actually
   * runs on; two hooks would let this package describe an index Postgres would
   * refuse to build.
   *
   * THE CONSEQUENCE, which is easy to miss: a type whose EQUALITY is finer than
   * its ordering has to TIE-BREAK inside the comparator. Answering `0` for two
   * values you consider distinct does not merely conflate them under `=` — it
   * also leaves their relative ORDER undefined, so `ORDER BY` returns them in
   * whichever order the sort happened to produce and the database returns them
   * in whichever order its index happened to hold. Semver build metadata, a
   * username sorted case-insensitively, and a zoned timestamp ordered by instant
   * are all this shape: compare the primary key first, then the tie-breaker, and
   * both roads become deterministic together.
   *
   * IT OUT-RANKS CASE FOLDING. `Value.compareToCase` consults it before folding,
   * because a type that has said how its values compare has said so including
   * their case; a refinement that wants the package's folding declares no
   * comparator and sets `options.casing` instead.
   *
   * IT IS HANDED VALUES THAT ARE NOT OF YOUR TYPE — a comparison, a sort key or
   * a `min()` reaches it with whatever the row held, which is what makes it a
   * comparator rather than an assertion. Return a negative / zero / positive
   * number; a `NaN` or non-numeric answer is read as "equal" rather than allowed
   * to corrupt a sort, and a THROW is not caught. `checkFieldType`
   * property-tests reflexivity, antisymmetry, transitivity and totality over
   * your samples; `differentialCheck` settles the one question neither it nor
   * registration can — whether it agrees with the database.
   */
  readonly compareValues?: ValueComparator;
}

/**
 * A refinement's in-memory ordering ({@link FieldTypeImpl.compareValues}) — the
 * `Array.prototype.sort` contract over two RAW values.
 *
 * Typed against `JsonValue` rather than against a narrowed value type, because
 * it is reached from `Value.compareTo`, which is total over every cell a row can
 * hold and cannot know that a given cell really is of your type. A comparator
 * written as though it will only ever see well-formed values of its own type is
 * the shape that throws out of a sort.
 */
export type ValueComparator = (a: JsonValue, b: JsonValue) => number;

/**
 * The OPTION-FREE def of each builtin kind — the target the declared `options`
 * are assigned onto to reconstitute the base's own `FieldTypeDef`.
 *
 * A table rather than a nine-arm switch, and `Object.assign` rather than a
 * spread, for one reason each. The table is a `Record<ScalarKind, …>`, so a
 * tenth builtin kind fails to COMPILE here instead of falling through to
 * whatever a spread happened to produce. And `Object.assign(def, options)` types
 * as `FieldTypeDef & <options>` — which IS a `FieldTypeDef` — whereas
 * `{ ...options, kind: base }` is an object TypeScript cannot relate to any
 * branch, because it will not see through the `Omit` that `FieldTypeOptionsOf`
 * is built from. Same object at runtime, and no cast.
 *
 * `relation` is absent because a `relation` BASE is refused outright
 * ({@link REFINABLE_BASES}) — it is also the one kind with no option-free form,
 * which is the same fact seen from the other side.
 */
const BARE_DEF_OF: Readonly<Record<RefinableBase, () => FieldTypeDef>> = {
  number: () => ({ kind: 'number' }),
  text: () => ({ kind: 'text' }),
  money: () => ({ kind: 'money' }),
  bool: () => ({ kind: 'bool' }),
  date: () => ({ kind: 'date' }),
  timestamp: () => ({ kind: 'timestamp' }),
  json: () => ({ kind: 'json' }),
  array: () => ({ kind: 'array' }),
};

/**
 * The bases a refinement may narrow: every `ScalarKind` EXCEPT `relation`.
 *
 * A relation carries an IDENTITY (`to`) and a cardinality ESTIMATE (`count`),
 * neither of which is a constraint a name can narrow — the same fact
 * `param-meet.test.ts` already records by giving `relation` no TOP ("its `to` is
 * an identity, not a constraint, so there is no relation that constrains
 * nothing"). Measured consequence of allowing it: a site had to restate `to` and
 * `count` verbatim, which is the exact duplication this feature removes, and a
 * declaration that named only `count` registered cleanly and then refused every
 * column that used it, blaming the column. Refused at the declaration instead.
 */
export const REFINABLE_BASES = SCALAR_KINDS.filter((kind) => kind !== 'relation');

/** A base a refinement may narrow (see {@link REFINABLE_BASES}). */
export type RefinableBase = Exclude<ScalarKind, 'relation'>;

/** {@link REFINABLE_BASES} as a membership test over the WIDER `ScalarKind`. */
const REFINABLE_BASE_SET: ReadonlySet<ScalarKind> = new Set<ScalarKind>(REFINABLE_BASES);

/**
 * The bases whose VALUES are bound through `Dialect.jsonValue` — the ONE seam a
 * declared `cast` template can reach.
 *
 * `writeCellSql` routes a cell there when the value is an object or the column
 * is `json`; every other road (a scalar comparison, a literal, a bound param)
 * emits the value directly. So a `cast` on a `text` base validates at
 * registration and can then never fire — measured on the documented `uuid`
 * example, whose predicate stayed `WHERE "thing"."id" = $1`. It is refused
 * rather than accepted-and-inert.
 */
const CAST_CAPABLE_BASES: ReadonlySet<ScalarKind> = new Set<ScalarKind>(['json', 'array']);

/**
 * Every key a DECLARATION may carry. An unknown one is REFUSED rather than
 * ignored, because "ignored" is how the failure this whole split exists to
 * prevent comes back in a different disguise.
 *
 * The measured case is `value`. It used to live on the declaration and now lives
 * on the impl, and TypeScript's excess-property check only fires on an INLINE
 * literal — so `registerFieldType(JSON.parse(stored) as FieldTypeRefinementDef)`,
 * which is the road the docs advertise, type-checks and silently drops the
 * strictest gate on the column. Same end state as a revived husk, reached by a
 * different road.
 *
 * The list is checked against the interface below, so adding a key to one
 * without the other does not compile.
 */
const DECLARATION_KEYS = [
  'name',
  'base',
  'instructions',
  'options',
  'ownOptions',
  'compare',
  'comparableWith',
  'sql',
  'cast',
  'avgBytes',
  'declaredBy',
] as const;

/** {@link DECLARATION_KEYS} as a membership test over an arbitrary key string. */
const DECLARATION_KEY_SET: ReadonlySet<string> = new Set<string>(DECLARATION_KEYS);

/**
 * Keys that MOVED, so their refusal can say where they went instead of just
 * "unknown".
 *
 * A `Map`, not an object literal, because it is indexed by an ARBITRARY key
 * taken off a caller's declaration — and `{}['toString']` is a function, so a
 * declaration carrying a `toString` key produced the model-facing message
 * *"It moved to function toString() { [native code] }"*. A `Map` has no
 * prototype chain to fall through.
 */
const RELOCATED_KEYS: ReadonlyMap<string, string> = new Map([
  ['value', '`registerFieldTypeImpl(name, { value })` — it is a zod schema, and a declaration is JSON'],
]);

type Assert<T extends true> = T;
/** `DECLARATION_KEYS` covers the declaration exactly — neither list may drift. */
type _DeclarationKeysAreExact = Assert<
  Exclude<keyof FieldTypeRefinementDefFor<'text'>, (typeof DECLARATION_KEYS)[number]> extends never
    ? (typeof DECLARATION_KEYS)[number] extends keyof FieldTypeRefinementDefFor<'text'> ? true : false
    : false
>;

/**
 * `value` with every object's keys sorted, at every depth — the canonical form a
 * `with` bag is stored in.
 *
 * `meet` and the identity short-circuit compare two types by their SERIALIZED
 * form, so two columns whose option objects differ only in key order would be
 * two different types: `{meta:{a:1,b:2}} ⊓ {meta:{b:2,a:1}}` had no meet at all.
 * Commutative either way (both directions agreed on `undefined`), so no law
 * caught it — which is exactly why the canonicalization has to be structural
 * rather than left to the arrangement a law happens to notice.
 */
function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== 'object') return value;
  const sorted: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = value[key];
    if (inner !== undefined) sorted[key] = canonicalJson(inner);
  }
  return sorted;
}

/** Throw a declaration-defect `QueryTypeError` for refinement `name`. */
function refuse(name: string, path: (string | number)[], message: string): never {
  throw new QueryTypeError({
    path: ['registerFieldType', name, ...path],
    code: 'field-type.bad-refinement',
    severity: 'error',
    message,
  });
}

/**
 * The declared options as an interpolable `slot → token` table, refusing any
 * value that is not a safe bare token (see {@link TEMPLATE_VALUE_PATTERN}).
 * A composite option (`values`, `item`) has no token form and is simply absent,
 * so naming one in a template reads as an unknown slot — which is the honest
 * message, since there is nothing to interpolate.
 */
function templateSlots(options: object): Map<string, string> {
  const slots = new Map<string, string>();
  for (const [key, value] of Object.entries(options)) {
    const token = templateToken(value);
    if (token !== undefined) slots.set(key, token);
  }
  return slots;
}

/**
 * An option this refinement declares FOR ITSELF, compiled: its declared type as
 * a `FieldType` (so a site's value is checked by the machinery that already
 * checks every other value) beside the declaration it came from.
 */
export interface CompiledFieldTypeOption {
  /** The option name — the key a column writes in its `with` bag. */
  readonly name: string;
  /** The option's declared type, parsed. */
  readonly type: FieldType;
  /** The declared type's def, for the generated schema and for describing it. */
  readonly typeDef: FieldTypeDef;
  /** The value a column that names none carries, or `undefined`. */
  readonly default: JsonValue | undefined;
  /** What the option means, for a model. */
  readonly docs: string | undefined;
  /** Whether any `sql` / `cast` template interpolates it — which is what makes its values an injection surface. */
  readonly interpolated: boolean;
}

/**
 * Compile `template` against the slots that resolve NOW (`constants`, the base
 * options) and the slots that resolve PER COLUMN (`deferred`, the own options
 * plus `keep`), refusing an unknown one with a `didYouMean`.
 */
function compileTemplate(
  name: string,
  path: (string | number)[],
  template: string,
  constants: ReadonlyMap<string, string>,
  deferred: ReadonlySet<string>,
  keep?: string,
): Template {
  return scanTemplate(template, (slot): TemplatePart => {
    const constant = constants.get(slot);
    if (constant !== undefined) return { text: constant };
    if (slot === keep || deferred.has(slot)) return { slot };
    const candidates = [...constants.keys(), ...deferred, ...(keep === undefined ? [] : [keep])];
    refuse(
      name,
      path,
      `SQL template ${JSON.stringify(template)} names \`{${slot}}\`, which is not an interpolable ` +
        `declared option of \`${name}\`.${didYouMean(slot, candidates)} ` +
        `(interpolable: ${candidates.length > 0 ? candidates.map((c) => `\`{${c}}\``).join(', ') : 'none'}). ` +
        'A slot must name an option whose value is a bare identifier or number token — the templates ' +
        'are raw-interpolated into emitted SQL, so anything else is refused rather than quoted.',
    );
  });
}

/** Every own-option slot `template` still carries (`{value}` excluded). */
function deferredSlots(template: Template): Set<string> {
  const slots = templateSlotNames(template);
  slots.delete(CAST_VALUE_SLOT);
  return slots;
}

/**
 * `template` rendered with every own-option slot filled from `tokens` and
 * `{value}` left as a segment boundary — the shape both `sqlType` (one segment)
 * and `cast` (n+1 segments around n value slots) are read as.
 */
function renderTemplate(template: Template, tokens: ReadonlyMap<string, string>): string[] {
  const segments: string[] = [''];
  for (const part of template) {
    if (!isSlot(part)) segments[segments.length - 1] += part.text;
    else if (part.slot === CAST_VALUE_SLOT) segments.push('');
    // A slot with no token is unreachable: an interpolated option is refused at
    // registration unless it declares a `default`, so every slot always resolves.
    else segments[segments.length - 1] += tokens.get(part.slot) ?? '';
  }
  return segments;
}

/**
 * The SQL token form of `value`, or `undefined` when it has none.
 *
 * The ONE place a declared value becomes raw SQL text, so it is the whole
 * injection surface of the template mechanism — see
 * {@link TEMPLATE_VALUE_PATTERN}. A number and a boolean render as themselves; a
 * string must already BE a bare token; everything else (an object, an array,
 * `null`) has no token form.
 *
 * `unknown` because it answers for BOTH option vocabularies: a base option's
 * value is one of nine unrelated shapes (a bound, a flag, a `values` list, a
 * nested `FieldTypeDef`) and an own option's is any `JsonValue`. Narrowing here
 * by `typeof` is the honest form of that question, and it keeps the two roads on
 * ONE rule rather than on two that could drift.
 */
function templateToken(value: unknown): string | undefined {
  // A number goes through the SAME pattern as a string rather than being trusted
  // for being a number: `String(1e21)` is `1e+21`, `String(-4)` is `-4`, and
  // neither is a bare token. One rule, no numeric special case to get wrong.
  const text = typeof value === 'number' || typeof value === 'boolean' ? String(value)
    : typeof value === 'string' ? value
      : undefined;
  return text !== undefined && TEMPLATE_VALUE_PATTERN.test(text) ? text : undefined;
}

/** Every deferred slot of `template` bound to one probe token (see {@link TEMPLATE_PROBE_TOKENS}). */
function probeTokens(template: Template, probe: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const slot of deferredSlots(template)) tokens.set(slot, probe);
  return tokens;
}

/**
 * Compile the declaration's OWN options — the ones its base has never heard of.
 *
 * Each option's `type` goes through the same `parseFieldType` the declaration's
 * base options do, so a bad bound, an uncompilable pattern or a self-
 * contradictory closed set is refused with the message that road already has;
 * and each `default` is checked against its own type, so a declaration cannot
 * ship a default no column could have written.
 */
function compileOwnOptions(
  name: string,
  declared: Readonly<Record<string, FieldTypeOptionDecl>> | undefined,
  baseSlots: ReadonlyMap<string, string>,
  parseFieldType: (json: FieldTypeDef) => FieldType,
): Map<string, CompiledFieldTypeOption> {
  const compiled = new Map<string, CompiledFieldTypeOption>();
  for (const [key, option] of Object.entries(declared ?? {})) {
    if (!REFINEMENT_NAME_PATTERN.test(key)) {
      refuse(
        name,
        ['ownOptions', key],
        `Option name ${JSON.stringify(key)} must match ${REFINEMENT_NAME_PATTERN.source} — it is a ` +
          'template slot name and a key a model writes in a `with` bag.',
      );
    }
    // A name that a BASE option already answers as a template slot would make
    // `{maxLength}` mean two things, and nothing in the template says which.
    if (baseSlots.has(key)) {
      refuse(
        name,
        ['ownOptions', key],
        `Option \`${key}\` is already a declared BASE option of this refinement, so a \`{${key}}\` ` +
          'template slot would name two different values. Rename the declared option, or narrow the ' +
          'base option in `options` instead of redeclaring it.',
      );
    }
    if (key === CAST_VALUE_SLOT) {
      refuse(
        name,
        ['ownOptions', key],
        `\`${CAST_VALUE_SLOT}\` is reserved: it is the slot a \`cast\` template puts the BOUND VALUE in.`,
      );
    }
    if (option === null || typeof option !== 'object' || !('type' in option)) {
      refuse(
        name,
        ['ownOptions', key],
        `Option \`${key}\` must be declared as \`{ type: <FieldTypeDef>, default?, docs? }\` — its type ` +
          'is an ordinary field type, so it is validated, described and round-tripped by machinery that ' +
          'already exists.',
      );
    }
    let type: FieldType;
    try {
      type = parseFieldType(option.type);
    } catch (err) {
      refuse(
        name,
        ['ownOptions', key, 'type'],
        `Option \`${key}\` does not declare a valid field type: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (option.default !== undefined && !type.validValue(option.default)) {
      refuse(
        name,
        ['ownOptions', key, 'default'],
        `Option \`${key}\`'s default ${JSON.stringify(option.default)} is not a valid ` +
          `${type.toCode()} — the value a column inherits has to be one a column could have written.`,
      );
    }
    compiled.set(key, {
      name: key,
      type,
      typeDef: option.type,
      default: option.default,
      docs: option.docs,
      interpolated: false,
    });
  }
  return compiled;
}

/** Resolve the three {@link FieldTypeCompareDecl} arms, defaulting each to the base's own grammar. */
function compileCompare(name: string, declared: FieldTypeCompareDecl | undefined): Required<FieldTypeCompareDecl> {
  const arm = (key: keyof FieldTypeCompareDecl): boolean => {
    const value = declared?.[key];
    if (value === undefined) return true;
    if (typeof value !== 'boolean') {
      refuse(name, ['compare', key], `\`compare.${key}\` must be a boolean, got ${JSON.stringify(value)}.`);
    }
    return value;
  };
  return { equality: arm('equality'), ordering: arm('ordering'), textMatch: arm('textMatch') };
}

/**
 * Validate the declared `comparableWith` names. They are NOT resolved here: an
 * edge may name a refinement that is not registered yet (a mutual pair makes
 * that unavoidable — one of the two has to be declared first), so resolution and
 * symmetrization belong to the registry, which sees every registration.
 */
function compileComparableWith(name: string, declared: readonly string[] | undefined): readonly string[] {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) {
    refuse(name, ['comparableWith'], `\`comparableWith\` must be an array of registered refinement names, got ${JSON.stringify(declared)}.`);
  }
  const names: string[] = [];
  for (const other of declared) {
    if (typeof other !== 'string' || !REFINEMENT_NAME_PATTERN.test(other)) {
      refuse(name, ['comparableWith'], `\`comparableWith\` entry ${JSON.stringify(other)} is not a refinement name (${REFINEMENT_NAME_PATTERN.source}).`);
    }
    // Naming yourself is redundant rather than wrong — every type is comparable
    // with itself — so it is dropped rather than refused.
    if (other !== name && !names.includes(other)) names.push(other);
  }
  return names;
}

/**
 * A COMPILED refinement — the declaration plus the builtin instance its
 * `options` parse to, which is the operand every use site is met against.
 *
 * Built only by {@link FieldTypeRefinement.compile} (via
 * `Registry.registerFieldType`), so an instance in hand has already passed every
 * registration-time check.
 */
export class FieldTypeRefinement {
  private constructor(
    /** The registered name — the `as` on the wire. */
    readonly name: string,
    /** The builtin bucket this refines. */
    readonly base: ScalarKind,
    /** What this type means, for a model. */
    readonly instructions: string,
    /**
     * The declaration's own options as a parsed `FieldType` — the FLOOR a use
     * site is met against. Carries no refinement itself, so meeting it with a
     * site's type is a pure options meet.
     */
    readonly declared: FieldType,
    /**
     * The options this refinement declares FOR ITSELF, in declaration order —
     * the vocabulary a column's `with` bag may name.
     */
    readonly ownOptions: ReadonlyMap<string, CompiledFieldTypeOption>,
    /**
     * Which arms of the builtin comparison grammar this type admits, every arm
     * resolved (an omitted one defaults to `true`, i.e. the base's own grammar).
     */
    readonly compare: Required<FieldTypeCompareDecl>,
    /** The `comparableWith` names AS DECLARED, before the registry symmetrizes them. */
    readonly declaredComparableWith: readonly string[],
    /** The declared average stored bytes, or `undefined` to keep the base's estimate. */
    readonly avgBytes: number | undefined,
    /** Per dialect name, the compiled `sql` template (base slots already resolved). */
    private readonly sqlTypes: ReadonlyMap<string, Template>,
    /** Per dialect name, the compiled `cast` template (its `{value}` slots still open). */
    private readonly casts: ReadonlyMap<string, Template>,
    /** Who declared it, when they said. */
    readonly declaredBy: string | undefined,
  ) {}

  /**
   * The OTHER refinement names this type may be compared with — the declared
   * relation after the registry has symmetrized it. Mutable, and mutated ONLY by
   * {@link linkComparable}: an edge may be declared before the type on its far
   * end is registered, and both ends must end up carrying it whichever order
   * they arrive in.
   */
  private readonly comparable = new Set<string>();

  /**
   * Record a comparability edge to `other`. Registry-only — it is what makes the
   * relation symmetric, and it is called for BOTH ends of every edge, so no
   * declarer can produce a one-way one.
   */
  linkComparable(other: string): void {
    this.comparable.add(other);
  }

  /**
   * Whether a value of this type may be compared with one of the refinement
   * named `other` — itself always, plus every symmetrized declared edge.
   *
   * By NAME rather than by instance, unlike the meet. The meet has to be exact
   * because it hands back a type whose value gate and `sqlType` a caller then
   * uses; comparability only answers whether a predicate is meaningful, and
   * answering `true` for a same-named type compiled in another registry cannot
   * produce a wrong TYPE — the meet still refuses it.
   */
  comparableTo(other: string): boolean {
    return other === this.name || this.comparable.has(other);
  }

  /** The declared own-option names, in declaration order (for messages and schemas). */
  ownOptionNames(): string[] {
    return [...this.ownOptions.keys()];
  }

  /** The CODE half, when one has been registered (see {@link FieldTypeImpl}). */
  private impl: FieldTypeImpl | undefined;

  /**
   * The stricter value gate this refinement's IMPL supplies, or `undefined`.
   * Read by `FieldType.toValueSchema`, which conjoins it with the field's own.
   */
  get value(): z.ZodTypeAny | undefined {
    return this.impl?.value;
  }

  /**
   * The in-memory ordering this refinement's IMPL supplies, or `undefined`.
   * Read by `FieldType.valueComparator`, which is what `Value.compareTo`
   * consults (see {@link FieldTypeImpl.compareValues}).
   */
  get compareValues(): ValueComparator | undefined {
    return this.impl?.compareValues;
  }

  /**
   * Attach the code half. Called only by `Registry.registerFieldTypeImpl`, which
   * owns the checks (that the impl is registered once, that a supplied `value`
   * is really a zod schema, that a supplied `compareValues` is really a
   * function, and that the catalog has not been parsed yet).
   */
  attachImpl(impl: FieldTypeImpl): void {
    this.impl = impl;
  }

  /** Whether a code half has already been attached (the registry's once-only check). */
  get hasImpl(): boolean {
    return this.impl !== undefined;
  }

  /**
   * Validate and compile a declaration. Every check is cheap because the
   * declaration is data, and every one of them refuses rather than warns: a
   * refinement that registered half-broken would be wrong on every column that
   * ever names it.
   */
  static compile(
    def: FieldTypeRefinementDef,
    registry: Registry,
    /**
     * How the declared `options` become a `FieldType`. Supplied by the registry
     * rather than taken off it, because this road must NOT freeze the refinement
     * vocabulary — compiling the first declaration would otherwise refuse the
     * second (`Registry.parseFieldTypeUnflagged`).
     */
    parseFieldType: (json: FieldTypeDef) => FieldType,
  ): FieldTypeRefinement {
    const { name } = def;
    if (typeof name !== 'string' || !REFINEMENT_NAME_PATTERN.test(name)) {
      refuse(
        String(name),
        [],
        `Field-type refinement name ${JSON.stringify(name)} must match ${REFINEMENT_NAME_PATTERN.source} ` +
          '(a letter, then letters / digits / underscores). Capitals are allowed deliberately, so one ' +
          'name can be spelled the same way here and in a sibling type system.',
      );
    }
    // A refinement NARROWS a builtin; it cannot BE one. Sharing the namespace
    // would make `{kind:'text', as:'text'}` a thing, and `text` would then mean
    // one type in `kind` and another in `as`.
    if (registry.fieldTypeClass(name)) {
      refuse(name, [], `\`${name}\` is a builtin field-type kind and cannot also name a refinement of one.`);
    }
    const existing = registry.fieldTypeRefinement(name);
    if (existing) {
      refuse(
        name,
        [],
        `\`${name}\` is already registered as a refinement of \`${existing.base}\`` +
          `${existing.declaredBy !== undefined ? ` by ${existing.declaredBy}` : ''}. ` +
          'The second declaration is refused rather than allowed to shadow the first: a column stored ' +
          `as \`{kind:'${existing.base}', as:'${name}'}\` would silently change meaning depending on ` +
          'which package registered last.',
      );
    }
    // An unknown key is REFUSED, not ignored — see `DECLARATION_KEYS`. Checked
    // before anything reads the declaration, so a stale `value` cannot register
    // and then sit inert.
    for (const key of Object.keys(def)) {
      if (DECLARATION_KEY_SET.has(key)) continue;
      const moved = RELOCATED_KEYS.get(key);
      refuse(
        name,
        [key],
        `Unknown declaration key \`${key}\`.` +
          `${moved !== undefined ? ` It moved to ${moved}.` : didYouMean(key, [...DECLARATION_KEYS])} ` +
          `A declaration carries only: ${DECLARATION_KEYS.join(', ')}. An unknown key is refused rather ` +
          'than dropped, because a key that is silently dropped is a fact the declarer believes is in ' +
          'force and is not.',
      );
    }

    // Read as a plain string: `def.base` is typed `RefinableBase`, so `relation`
    // is already a compile error — this is the runtime half, for an untyped
    // caller, and it earns its own message because it is the one base a declarer
    // has a reason to try.
    const base: string = def.base;
    if (base === 'relation') {
      refuse(
        name,
        ['base'],
        'A `relation` cannot be refined. Its `to` is an IDENTITY and its `count` a cardinality ESTIMATE, ' +
          'neither of which is a constraint a name can narrow — so a use site would have to restate both ' +
          'verbatim (the duplication a refinement exists to remove) and a declaration naming only one of ' +
          `them would refuse every column that used it. Refine what the relation POINTS AT instead. ` +
          `Refinable bases: ${REFINABLE_BASES.join(' | ')}.`,
      );
    }
    if (!REFINABLE_BASES.includes(def.base)) {
      refuse(
        name,
        ['base'],
        `\`base\` must be one of ${REFINABLE_BASES.join(' | ')}, got ${JSON.stringify(def.base)}. ` +
          'A refinement reuses a builtin bucket — that is what keeps every SQL, cost and comparability ' +
          'path total.',
      );
    }
    if (typeof def.instructions !== 'string' || def.instructions.trim() === '') {
      refuse(
        name,
        ['instructions'],
        '`instructions` is required and must be non-empty. An undocumented registered type renders as a ' +
          'bare tag beside documented siblings, and a model choosing among them guesses — which costs a ' +
          'whole validate-fail retry carrying the entire schema.',
      );
    }
    if (def.avgBytes !== undefined && (!Number.isFinite(def.avgBytes) || def.avgBytes <= 0)) {
      refuse(name, ['avgBytes'], `\`avgBytes\` must be a finite number greater than 0, got ${JSON.stringify(def.avgBytes)}.`);
    }

    // The options are parsed by the SAME road a builtin def takes, so a bad
    // bound, an uncompilable pattern or a closed set that contradicts its own
    // constraints is refused here with the message that road already has.
    const options: object = def.options ?? {};
    let declared: FieldType;
    try {
      declared = parseFieldType(Object.assign(BARE_DEF_OF[def.base](), def.options));
    } catch (err) {
      refuse(
        name,
        ['options'],
        `\`options\` are not a valid \`${def.base}\` declaration: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const slots = templateSlots(options);
    const ownOptions = compileOwnOptions(name, def.ownOptions, slots, parseFieldType);
    const ownNames = new Set(ownOptions.keys());

    const sqlTypes = new Map<string, Template>();
    for (const [dialect, template] of Object.entries(def.sql ?? {})) {
      const path = ['sql', dialect];
      const compiled = compileTemplate(name, path, template, slots, ownNames);
      // Checked against PROBE tokens rather than against the one resolved
      // string, because an own-option slot holds a different value on every
      // column and emit is far too late to find out. See
      // `TEMPLATE_PROBE_TOKENS` for why three probes cover every legal token.
      for (const probe of TEMPLATE_PROBE_TOKENS) {
        const probed = renderTemplate(compiled, probeTokens(compiled, probe)).join('');
        if (SQL_TYPE_PATTERN.test(probed)) continue;
        refuse(
          name,
          path,
          `SQL type ${JSON.stringify(probed)} is not a SQL type name (it is raw-interpolated into ` +
            `\`CAST(… AS …)\`). Expected something matching ${SQL_TYPE_PATTERN.source}.` +
            (deferredSlots(compiled).size > 0
              ? ` That is this template with every declared option rendered as \`${probe}\` — an option's ` +
                'value differs per column, so the template must be a legal type name for EVERY value it ' +
                'can hold, not only for one.'
              : ''),
        );
      }
      sqlTypes.set(dialect, compiled);
    }

    const casts = new Map<string, Template>();
    const declaredCasts = Object.entries(def.cast ?? {});
    if (declaredCasts.length > 0 && !CAST_CAPABLE_BASES.has(def.base)) {
      refuse(
        name,
        ['cast'],
        `A \`${def.base}\` refinement cannot declare a \`cast\`. Only a value bound through ` +
          `\`Dialect.jsonValue\` reaches a cast template (bases: ${[...CAST_CAPABLE_BASES].join(' | ')}); ` +
          `a \`${def.base}\` predicate binds its value directly, so the template would be accepted here ` +
          'and then silently inert on every predicate over the column. Declare `sql` — the cast TARGET — ' +
          'instead.',
      );
    }
    for (const [dialect, template] of declaredCasts) {
      const compiled = compileTemplate(name, ['cast', dialect], template, slots, ownNames, CAST_VALUE_SLOT);
      if (!compiled.some((part) => isSlot(part) && part.slot === CAST_VALUE_SLOT)) {
        refuse(
          name,
          ['cast', dialect],
          `Cast template ${JSON.stringify(template)} never names \`{${CAST_VALUE_SLOT}}\`, so the bound ` +
            'value would be dropped and the emitted SQL would carry one parameter fewer than the query ' +
            'supplies. A cast must place the value it casts.',
        );
      }
      casts.set(dialect, compiled);
    }

    // An option a template interpolates is the injection surface (see
    // `TEMPLATE_VALUE_PATTERN`), and its value now arrives PER COLUMN rather than
    // from the declaration — so its declared TYPE has to guarantee what the
    // declared VALUE used to be checked for.
    const interpolated = new Set<string>();
    for (const template of [...sqlTypes.values(), ...casts.values()]) {
      for (const slot of deferredSlots(template)) interpolated.add(slot);
    }
    const withInterpolation = new Map<string, CompiledFieldTypeOption>();
    for (const [key, option] of ownOptions) {
      if (!interpolated.has(key)) {
        withInterpolation.set(key, option);
        continue;
      }
      if (!option.type.tokenSafeValues()) {
        refuse(
          name,
          ['ownOptions', key],
          `Option \`${key}\` is interpolated into a SQL template, so EVERY value it can hold is spliced ` +
            'into emitted SQL as raw text — and its declared type does not bound that. Give it a CLOSED ' +
            'type: a `values` set whose members are all bare tokens, a `bool`, or a `number` with ' +
            '`whole: true`. The template body is the declarer\'s; the values are the column author\'s, ' +
            'and only a closed type makes them safe without quoting rules of their own.',
        );
      }
      if (option.default === undefined) {
        refuse(
          name,
          ['ownOptions', key],
          `Option \`${key}\` is interpolated into a SQL template but declares no \`default\`. A template ` +
            'must resolve for EVERY column, and a column that names no value would otherwise leave the ' +
            'slot with no answer at all.',
        );
      }
      if (templateToken(option.default) === undefined) {
        refuse(
          name,
          ['ownOptions', key, 'default'],
          `Option \`${key}\` interpolates into a SQL template, so its \`default\` ` +
            `(${JSON.stringify(option.default)}) must be a bare identifier or number token.`,
        );
      }
      withInterpolation.set(key, { ...option, interpolated: true });
    }

    return new FieldTypeRefinement(
      name,
      def.base,
      def.instructions,
      declared,
      withInterpolation,
      compileCompare(name, def.compare),
      compileComparableWith(name, def.comparableWith),
      def.avgBytes,
      sqlTypes,
      casts,
      def.declaredBy,
    );
  }

  /**
   * The field type a use site declaring `as: <this>` resolves to — the MEET of
   * this refinement's declared options and the site's own, tagged with this
   * refinement.
   *
   * The meet is the whole enforcement: its result is a lower bound of BOTH, so a
   * site can only ever narrow, and a site whose options cannot coexist with the
   * declaration's has no meet and is refused here. No new lattice law is
   * introduced — `as` itself merges through the existing flat `meetExact`, in
   * which a registered name meets only itself and an unrefined base is TOP.
   */
  refine(site: FieldType, withOptions?: Readonly<Record<string, JsonValue>>): FieldType {
    if (site.kind !== this.base) {
      throw new QueryTypeError({
        path: ['as'],
        code: 'field-type.refinement-base',
        severity: 'error',
        message:
          `\`as: '${this.name}'\` refines a \`${this.base}\`, but this field declares ` +
          `\`kind: '${site.kind}'\`. Write \`{ kind: '${this.base}', as: '${this.name}' }\`.`,
      });
    }
    const met = this.declared.meet(site);
    if (met === undefined) {
      throw new QueryTypeError({
        path: ['as'],
        code: 'field-type.refinement-conflict',
        severity: 'error',
        message:
          `This field narrows \`${this.name}\` to something no value satisfies: ` +
          `${JSON.stringify(site.toJSON())} has no meet with the refinement's own ` +
          `${JSON.stringify(this.declared.toJSON())}. A use site may narrow \`${this.name}\` further; ` +
          'it may not contradict it.',
      });
    }
    return met.withRefinement(this, this.checkOwnOptions(withOptions));
  }

  /**
   * A column's `with` bag, checked and canonicalized — or `undefined` when it
   * declares none.
   *
   * Checked HERE, where the def is read, for the same reason every other
   * declaration defect is: emit is the only other place the values are known,
   * and a refusal there has no declaration to point at. Canonicalized (keys
   * sorted, empty dropped) because `toJSON` feeds `meet`'s identity comparison
   * and a bag that serialized in insertion order would make two equal types
   * unequal.
   */
  private checkOwnOptions(
    withOptions: Readonly<Record<string, JsonValue>> | undefined,
  ): Readonly<Record<string, JsonValue>> | undefined {
    const entries = Object.entries(withOptions ?? {}).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return undefined;
    const bag: Record<string, JsonValue> = {};
    for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const option = this.ownOptions.get(key);
      if (!option) {
        const names = this.ownOptionNames();
        throw new QueryTypeError({
          path: ['with', key],
          code: 'field-type.unknown-option',
          severity: 'error',
          message:
            `\`${this.name}\` declares no option \`${key}\`.${didYouMean(key, names)} ` +
            `(declared: ${names.length > 0 ? names.join(', ') : 'none'}). An unknown option is refused ` +
            'rather than carried, because a column whose declaration says something the type never reads ' +
            'is a fact its author believes is in force and is not.',
        });
      }
      if (!option.type.validValue(value)) {
        // The closed set is spelled out rather than left to `toCode()`, which
        // renders a `text{values:[…]}` as a bare `text`. A refusal that does not
        // name the alternatives costs the retry it was supposed to prevent.
        const members = option.type.values();
        throw new QueryTypeError({
          path: ['with', key],
          code: 'field-type.bad-option',
          severity: 'error',
          message:
            `\`${this.name}.${key}\` is declared ${option.type.toCode()}` +
            `${members ? ` (one of ${members.map((m) => String(m.value)).join('|')})` : ''}, and ` +
            `${JSON.stringify(value)} is not one.`,
        });
      }
      // Belt AND braces on the injection surface. The declared type being closed
      // is the structural guarantee (checked at registration); this is the
      // per-value one, and it is what makes `sqlType` / `cast` total — with both,
      // no reachable value can produce a token the templates were not checked for.
      if (option.interpolated && templateToken(value) === undefined) {
        throw new QueryTypeError({
          path: ['with', key],
          code: 'field-type.bad-option',
          severity: 'error',
          message:
            `\`${this.name}.${key}\` is interpolated into emitted SQL, so its value must be a bare ` +
            `identifier or number token; ${JSON.stringify(value)} is not.`,
        });
      }
      // Key-sorted at EVERY depth, not just the top. The bag is compared by its
      // serialized form (`meet` does, `withRefinement`'s identity check does), and
      // an object-valued option would otherwise make `{meta:{a:1,b:2}}` and
      // `{meta:{b:2,a:1}}` two different types — the same argument that sorts the
      // bag's own keys, which the first pass applied one level and stopped.
      bag[key] = canonicalJson(value);
    }
    return bag;
  }

  /**
   * The EFFECTIVE value of own option `key` for a column carrying `options` —
   * the column's own, else the declared `default`, else `undefined`.
   *
   * A default is resolved on READ rather than materialized into the bag, and
   * that is what keeps the flat lattice honest: materializing it would make a
   * column that said nothing carry `Geometry` and a column that said `Polygon`
   * CONFLICT with it, when the second is exactly the narrowing the first left
   * room for.
   */
  optionValue(key: string, options: Readonly<Record<string, JsonValue>> | undefined): JsonValue | undefined {
    const own = options?.[key];
    return own !== undefined ? own : this.ownOptions.get(key)?.default;
  }

  /** Every own option's effective value for a column carrying `options`, as interpolable tokens. */
  private optionTokens(options: Readonly<Record<string, JsonValue>> | undefined): Map<string, string> {
    const tokens = new Map<string, string>();
    for (const key of this.ownOptions.keys()) {
      const token = templateToken(this.optionValue(key, options));
      if (token !== undefined) tokens.set(key, token);
    }
    return tokens;
  }

  /**
   * The declared SQL type for `dialect` on a column carrying `options`, or
   * `undefined` to keep the builtin's answer.
   *
   * Resolved per COLUMN rather than at registration, because an own option holds
   * a different value on every column — `geometry({subtype},{srid})` is
   * `geometry(Point,4326)` on one and `geometry(Polygon,3857)` on the next. Every
   * token it can splice was proved safe at registration (a closed declared type)
   * and again at parse (the value itself), so this cannot fail.
   */
  sqlType(dialect: string, options?: Readonly<Record<string, JsonValue>>): string | undefined {
    const template = this.sqlTypes.get(dialect);
    return template && renderTemplate(template, this.optionTokens(options)).join('');
  }

  /**
   * The declared cast for `dialect` as literal segments around the `{value}`
   * slot, or `undefined` to keep the base's cast. Own-option slots resolve
   * against `options`, exactly as {@link sqlType}'s do.
   */
  cast(dialect: string, options?: Readonly<Record<string, JsonValue>>): readonly string[] | undefined {
    const template = this.casts.get(dialect);
    return template && renderTemplate(template, this.optionTokens(options));
  }

  /**
   * The own-option names this refinement's `cast` for `dialect` INTERPOLATES, or
   * an empty set.
   *
   * Asked by a VALUE position, which is not a column and therefore has no
   * honest value for those slots. {@link cast} fills them from the column's own
   * bag ELSE the option's declared DEFAULT, and that default-fill is exactly
   * right for a column (it is a fact about that column) and exactly wrong for a
   * value: a default is the TYPE's, not this value's, so filling it PINS a
   * constraint the value was never required to satisfy — measured, a
   * `geometry(Point,4326)` typmod cast applied to a Polygon document, which
   * PostGIS rejects outright.
   *
   * This is the same rule the model-facing renderer follows for an operand
   * (`llm/describe.ts`'s `'operand'` tag style shows only what a declaration
   * WROTE, never the refinement's defaults). One rule, two surfaces: what a
   * declaration did not write is not a constraint anyone may assert on its
   * behalf.
   */
  castOptions(dialect: string): ReadonlySet<string> {
    const template = this.casts.get(dialect);
    return template ? deferredSlots(template) : new Set<string>();
  }
}

/**
 * The `as` KEY of one builtin branch's generated def schema — a `z.enum` of the
 * refinements registered over THAT base, or a key that REFUSES any value when
 * none are.
 *
 * This is what makes the vocabulary REAL rather than advisory. The def schema is
 * what a model authors a Type against, and it was built from the static
 * `BUILTIN_FIELD_TYPES` array — so with an open `as: string` a model would be
 * free to invent `{kind:'text', as:'uuid4'}` and only find out at parse. Offered
 * as an enum, the only names it can write are names that exist.
 *
 * Filtered BY BASE, because a refinement of `text` is not a choice a `number`
 * field has; and each name carries its `instructions` inline, because a bare
 * list of names tells a model what it may write and not what any of them mean.
 * The names render VERBATIM — a model reads this surface and a sibling type
 * system's in one session, and a spelling difference between them reads as two
 * different types.
 *
 * THE EMPTY CASE IS A REFUSAL, NOT AN OMISSION, and the difference is the whole
 * point of the key. Omitting it let zod STRIP an `as` a model wrote on a base
 * with no registrations — and the normal pipeline is `Tool.parse` →
 * `engine.parseType(result)`, so `parseType` never sees the raw def and the loud
 * `field-type.unknown-refinement` never fires. The identical mistake was caught
 * on `text` and silently discarded on `json`.
 *
 * `z.never()` refuses any value while `.optional()` keeps the key absent-able,
 * and it is the right refusal for two reasons: `z.undefined()` is
 * UNREPRESENTABLE in JSON Schema (it throws, and under `unrepresentable: 'any'`
 * it renders as "permit anything" — the opposite of the intent), whereas `never`
 * renders as `{"not":{}}`. That is true of ONE BRANCH's schema; converting the
 * whole `fieldTypeDefSchema` union is a separate, pre-existing matter (see the
 * known limit in `CHANGELOG.md`).
 *
 * Returns a spreadable fragment rather than a schema so a branch declares the
 * key exactly where it declares the rest of its wire shape.
 */
export function refinementKeySchema(
  base: ScalarKind,
  opts?: SchemaOptions,
): { as: z.ZodTypeAny; with: z.ZodTypeAny } {
  // A base that can never be refined says so, rather than "none registered
  // HERE" — which would imply another registry could have one.
  if (!REFINABLE_BASE_SET.has(base)) {
    return {
      as: z.never().optional().describe(`A ${base} cannot be refined — omit \`as\`.`),
      with: z.never().optional().describe(`A ${base} cannot be refined — omit \`with\`.`),
    };
  }
  const registered = (opts?.registry?.fieldTypeRefinementList() ?? []).filter((r) => r.base === base);
  const [first, ...rest] = registered.map((r) => r.name);
  if (first === undefined) {
    return {
      as: z
        .never()
        .optional()
        .describe(`No registered type refines a ${base} here — omit \`as\`.`),
      with: z
        .never()
        .optional()
        .describe(`No registered type refines a ${base} here — omit \`with\`.`),
    };
  }
  // The glossary carries each type's REFUSED comparison arms beside its
  // instructions, because this schema is read while a model is CHOOSING a type
  // for a column and the refusal is otherwise only discoverable by writing a
  // predicate and failing validation — which costs a retry carrying the whole
  // schema to save the handful of tokens this adds.
  const glossary = registered
    .map((r) => `${r.name} — ${r.instructions}${refusedArmsNote(r)}`)
    .join(' ');
  return {
    as: z
      .enum([first, ...rest])
      .optional()
      .describe(
        `Narrow this ${base} to a registered type. It carries that type's own constraints; you may ` +
          `constrain further here, never loosen. ${glossary}`,
      ),
    with: refinementOptionsSchema(base, registered, opts),
  };
}

/**
 * ` (refuses: <, LIKE)` for a type that declares arms of the comparison grammar
 * do not apply to it, or `''`. Rendered as the OPERATORS a model would write
 * rather than as the declaration's key names — the reader is choosing an
 * operator, not writing a declaration.
 */
function refusedArmsNote(refinement: FieldTypeRefinement): string {
  const refused = refusedOperators(refinement.compare);
  return refused.length === 0 ? '' : ` (refuses: ${refused.join(', ')})`;
}

/**
 * The `with` KEY of one branch's generated def schema — the options the
 * refinements over that base declare FOR THEMSELVES.
 *
 * Keyed by option NAME across every refinement of the base rather than
 * discriminated on the `as` the model chose, because zod cannot make one key's
 * shape depend on another's without turning the branch into a union whose size
 * is the number of registered refinements. So the schema is a GUIDE — it names
 * every option that exists, with its type and its owner — and `parseFieldType`
 * is the gate: an option belonging to a different refinement of the same base is
 * offered here and refused there (`field-type.unknown-option`).
 *
 * STRICT, unlike the branch objects around it, and deliberately: a stripped
 * unknown key is the exact failure the empty-`as` case documents. A model that
 * writes `with: { srid: 4326 }` on a type with no `srid` must hear about it, not
 * silently get a column with no SRID.
 *
 * Each option renders as its OWN declared type's value schema, so a closed
 * `subtype` arrives as an enum the model cannot invent a member of — the same
 * argument that makes `as` an enum rather than a string.
 */
function refinementOptionsSchema(
  base: ScalarKind,
  registered: readonly FieldTypeRefinement[],
  opts?: SchemaOptions,
): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  const glossary: string[] = [];
  for (const refinement of registered) {
    for (const option of refinement.ownOptions.values()) {
      const existing = shape[option.name];
      const schema = option.type.toValueSchema(opts);
      // Two refinements of one base may name one option; the model is told which
      // is which in the glossary, and the parse decides.
      shape[option.name] = (existing === undefined ? schema : z.union([existing, schema])).optional();
      glossary.push(
        `${refinement.name}.${option.name}: ${option.type.toCode()}` +
          `${option.default === undefined ? '' : ` (default ${JSON.stringify(option.default)})`}` +
          `${option.docs === undefined ? '' : ` — ${option.docs}`}`,
      );
    }
  }
  if (glossary.length === 0) {
    return z
      .never()
      .optional()
      .describe(`No registered type refining a ${base} declares options of its own — omit \`with\`.`);
  }
  return z
    .strictObject(shape)
    .optional()
    .describe(
      "Values for the options the type named in `as` declares for itself. Omit an option to take its " +
        `declared default. ${glossary.join('; ')}`,
    );
}
