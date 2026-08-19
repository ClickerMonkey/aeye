/**
 * The lattice primitives every `FieldType.meet` is built from.
 *
 * A MEET is the most specific type whose values satisfy BOTH operands — the
 * constructive form of `comparableWith`, which only answers yes/no. It exists
 * because a bind PARAM is typed from every place it is used at once
 * (`ParamSet`), and "the first use wins" is neither the most specific answer nor
 * an order-independent one: a param compared against an `enum` here and plain
 * `text` there is an ENUM, whichever the walk reached first.
 *
 * THE ALGEBRA IS THE POINT. `ParamSet` folds an arbitrary number of
 * observations in walk order, so unless the operation is COMMUTATIVE,
 * ASSOCIATIVE and IDEMPOTENT the answer depends on where in the JSON tree each
 * use happened to sit. Every helper here is one of exactly four shapes, each
 * chosen because it has those three properties:
 *
 *  - {@link meetExact} — a FLAT lattice for a single-valued attribute
 *    (`pattern`, `timezone`, `currency`): absent is TOP, equal keeps, DIFFERENT
 *    conflicts. "Keep when equal, otherwise drop to absent" is the tempting
 *    alternative and it is NOT associative — `(x∧y)∧z` drops then re-adopts `z`,
 *    while `x∧(y∧z)` drops then re-adopts `x`.
 *  - {@link meetLower} / {@link meetUpper} — max / min over a bound, i.e. the
 *    tighter of the two. Absent is unbounded (TOP).
 *  - {@link meetFlag} — OR over a boolean, i.e. the more constrained of the two
 *    (`whole: true` narrows).
 *  - {@link meetRanked} — max over a RANKED enum, the same idea as `meetFlag`
 *    with more than two members (`text.casing`: `exact` ≻ `fold` ≻ `collated`).
 *
 * A conflict is reported as `{ ok: false }` rather than `undefined`, because
 * `undefined` already means "unconstrained" for every one of these attributes
 * and collapsing the two would silently WIDEN a conflicting merge into an
 * unconstrained one.
 */

/** The outcome of meeting one attribute: a value (possibly `undefined` = unconstrained), or a conflict. */
export type MeetResult<T> = { readonly ok: true; readonly value: T | undefined } | { readonly ok: false };

/** A successful attribute meet carrying `value`. */
export function met<T>(value: T | undefined): MeetResult<T> {
  return { ok: true, value };
}

/** The conflicting attribute meet — no type admits both operands. */
export const MEET_CONFLICT: MeetResult<never> = { ok: false };

/**
 * Flat-lattice meet of a SINGLE-VALUED attribute: absent is TOP (no constraint,
 * so the other side wins), equal keeps the value, and two DIFFERENT values
 * conflict — there is no third value that is both. Equality is `===` unless an
 * `eq` is supplied (used for the `json` field type's structural `schema`).
 */
export function meetExact<T>(a: T | undefined, b: T | undefined, eq: (x: T, y: T) => boolean = Object.is): MeetResult<T> {
  if (a === undefined) return met(b);
  if (b === undefined) return met(a);
  return eq(a, b) ? met(a) : MEET_CONFLICT;
}

/** Meet of a LOWER bound (`min` / `minLength` / `minItems` / `minPlaces`): the greater wins; absent is unbounded. */
export function meetLower(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/** Meet of an UPPER bound (`max` / `maxLength` / `maxItems` / `maxPlaces`): the lesser wins; absent is unbounded. */
export function meetUpper(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Whether a met `[lower, upper]` range admits NOTHING. An empty range is a
 * conflict, not a satisfiable-by-nothing type: `text{minLength:10}` met with
 * `text{maxLength:5}` describes a string that cannot exist, and reporting it as
 * a type would hand the caller a schema that rejects every value it is given
 * with no explanation of why.
 */
export function emptyRange(lower: number | undefined, upper: number | undefined): boolean {
  return lower !== undefined && upper !== undefined && lower > upper;
}

/**
 * Meet of a boolean CONSTRAINT flag: OR, i.e. the more constrained of the two.
 * `whole: true` genuinely narrows the values admitted; `semantic` / `search`
 * narrow nothing but are merged the same way so the operation stays a single,
 * provable rule. Absent is `false` — the unconstrained end — so OR has an
 * identity and never conflicts.
 */
export function meetFlag(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  if (a === undefined && b === undefined) return undefined;
  return a === true || b === true;
}

/**
 * Meet of a RANKED enum attribute: the higher-ranked (more constrained) member
 * wins, absent is TOP. The generalisation of {@link meetFlag} from two members
 * to N — `text.casing` is the first attribute whose constraint is a graded
 * choice rather than a flag, and the rank function is the ONE place its
 * precedence is declared (`casingRank`), shared with the comparison that has to
 * reconcile the same two casings.
 *
 * `Math.max` over a total order is commutative, associative and idempotent, so
 * this keeps `ParamSet`'s fold independent of the order the walk visits uses in
 * — the property this whole module exists to preserve. It can never conflict,
 * for the same reason OR cannot: a maximum always exists.
 */
export function meetRanked<T>(a: T | undefined, b: T | undefined, rank: (v: T) => number): T | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return rank(b) > rank(a) ? b : a;
}

/** Structural equality of two JSON-ish values, by canonical serialization (key order included). */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
