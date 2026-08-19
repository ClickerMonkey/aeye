/**
 * TEXT CASING — how a textual comparison treats letter case, and WHO performs
 * the folding.
 *
 * Two facts hide inside "case-insensitive matching", and collapsing them into a
 * boolean is what made the old `sensitive` flag unable to express a real
 * deployment:
 *
 *  1. **What the comparison MEANS** — does `'Ada' = 'ada'` hold? This is a
 *     semantic of the query, so it must hold identically in BOTH roads (the
 *     in-memory runtime and the emitted SQL); the package tests that agreement
 *     explicitly (`runtime-sql-agreement.test.ts`).
 *  2. **WHO implements the fold in SQL** — this package, by wrapping both
 *     operands in `LOWER(...)`, or the COLUMN's own collation. A column declared
 *     `citext`, or with a non-deterministic (`deterministic = false`) collation,
 *     or on an engine whose default collation is case-insensitive (SQL Server's
 *     usual `*_CI_*`), already compares case-insensitively — so `LOWER()` there
 *     buys nothing and costs everything: it is not sargable, so every predicate
 *     over the column stops using its index.
 *
 * The cost is not only an index. `LOWER()` is a TEXT function, and this package
 * knows a column's LOGICAL type, never its physical one — a uuid-valued
 * identifier is honestly modelled as `text` (it is compared and rendered as
 * text), but on PostgreSQL `LOWER(uuid)` is `function lower(uuid) does not
 * exist`. A consumer measured exactly that: every row-security predicate
 * comparing a `uuid` owner column to the caller's id failed outright, so a
 * default meant to be forgiving produced SQL that could not run.
 *
 * Hence three states, not a flag. Each has a distinct pair of behaviours, so
 * none is a synonym for another:
 *
 * | casing       | means                              | SQL for `a = b`         | in-memory runtime |
 * |--------------|------------------------------------|-------------------------|-------------------|
 * | `'fold'`     | insensitive, THIS PACKAGE folds    | `LOWER(a) = LOWER(b)`   | folds             |
 * | `'collated'` | insensitive, the COLUMN's collation folds | `a = b`          | folds             |
 * | `'exact'`    | case-sensitive                     | `a = b`                 | compares as-is    |
 *
 * `'collated'` is the state that makes the owner's case expressible truthfully:
 * it keeps the MEANING insensitive (so the runtime still folds, and a query
 * means one thing wherever it runs) while emitting a bare, index-usable
 * comparison. It is a CLAIM ABOUT THE STORE, and an unverifiable one — this
 * package cannot read a column's collation — so declaring it over a
 * case-sensitive column is the one way to make the two roads disagree. That is
 * the trade for expressing the fact at all, and it is why it is not the default.
 *
 * WHERE THE POLICY LIVES, and why it is not the Dialect. A casing is resolved
 * from the FIELD's own declaration when it makes one, and otherwise from
 * {@link QueryEngine.textCasing}. The engine is deliberate: it is the only layer
 * BOTH roads can see (`SqlContext.engine` and `RuntimeContext.engine`), whereas
 * a `Dialect` is an argument to `toSQL` and is absent from the runtime entirely
 * — so a dialect-level default could only ever govern half of a semantic that
 * has to hold in both halves. Collation is genuinely a property of a COLUMN, so
 * the per-field declaration is the precise place to state it; the engine default
 * exists so a deployment whose columns are uniform says it once instead of on
 * every declaration.
 */

/** The casing policies, as an array (the source of the union and of the def schema's enum). */
export const TEXT_CASINGS = ['fold', 'collated', 'exact'] as const;

/** How a textual comparison treats letter case — see the table in this module's docs. */
export type TextCasing = (typeof TEXT_CASINGS)[number];

/**
 * The package's default when neither the field nor the engine declares one.
 *
 * `'fold'` — unchanged from every release before the policy existed. This
 * package is authored against by MODELS as much as by people, and a model
 * writing `status = 'Active'` against stored `active` is the case the forgiving
 * default was chosen for; flipping it would silently change which rows an
 * existing deployment's queries return, with nothing — no problem, no type
 * error, no thrown call — able to detect it. A deployment whose text columns are
 * identifiers, codes or enums (where the fold is pure cost) says so in one
 * place: `new QueryEngine(registry, { textCasing: 'exact' })`.
 */
export const DEFAULT_TEXT_CASING: TextCasing = 'fold';

/**
 * How CONSTRAINED each casing is — the one place the precedence between them is
 * declared, so the two consumers cannot drift apart:
 *
 *  - a COMPARISON whose two operands declare different casings takes the
 *    strictest (preserving the old rule that a `sensitive` field on either side
 *    forced a case-sensitive match);
 *  - a MEET (`TextFieldType.meetWith`, which types a bind param from every use
 *    at once) takes the strictest for the same reason it ORs `whole`.
 *
 * `exact` is strictest — it matches the fewest values. `fold` outranks
 * `collated` because the two agree on MEANING and disagree on who guarantees it:
 * when one operand's store folds and the other's may not, folding here is the
 * answer that is right either way.
 *
 * A max over a total order is commutative, associative and idempotent, which is
 * exactly what `ParamSet`'s order-independent fold requires (`_meet.ts`).
 */
export function casingRank(casing: TextCasing): number {
  switch (casing) {
    case 'collated':
      return 0;
    case 'fold':
      return 1;
    case 'exact':
      return 2;
  }
}

/** The stricter of two casings (see {@link casingRank}). */
export function strictestCasing(a: TextCasing, b: TextCasing): TextCasing {
  return casingRank(b) > casingRank(a) ? b : a;
}

/**
 * The casing in effect for a comparison, from the casings its operands DECLARE
 * and the engine's default.
 *
 * A declaration is authoritative: the default is consulted only when NEITHER
 * side declares one. That ordering is the whole point — a literal, a param or a
 * computed column carries no field type, so if the default were folded in
 * per-operand, an engine default of `'exact'` would silently override a column
 * that explicitly declared `'fold'` merely by comparing it to a string literal.
 */
export function effectiveCasing(
  left: TextCasing | undefined,
  right: TextCasing | undefined,
  fallback: TextCasing,
): TextCasing {
  if (left === undefined) return right ?? fallback;
  if (right === undefined) return left;
  return strictestCasing(left, right);
}

/**
 * Whether SQL must wrap both operands in `LOWER(...)`. ONLY `'fold'` does:
 * `'collated'` delegates the fold to the column, and `'exact'` does not fold.
 */
export function foldsInSql(casing: TextCasing): boolean {
  return casing === 'fold';
}

/**
 * Whether the in-memory runtime must lower-case both operands. Both
 * insensitive casings do — `'collated'` asserts the STORE folds, and the runtime
 * exists to give the same answer the store would.
 */
export function foldsAtRuntime(casing: TextCasing): boolean {
  return casing !== 'exact';
}
