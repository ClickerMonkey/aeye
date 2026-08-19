/**
 * ParamSet — contextual bind-parameter type inference (plan algorithm "b").
 *
 * A `param` expression (`{ kind: 'param', name }`) carries only a name; its
 * type is inferred from HOW it is used. A single `ParamSet` lives on the root
 * `QueryScope` and is shared by every child scope, so observations made deep
 * in a tree accumulate in one place.
 *
 * Two interleaved streams of information feed a ParamSet during a validate
 * walk:
 *
 *  - `reference(name, at)` — a `ParamExpr` announces it exists at a JSON
 *    path. Used to detect params that are never given a type
 *    (`param.untyped`).
 *  - `observe(name, fieldType, at, from?)` — an operator (comparison / in /
 *    between / function-call / write cell / row bound) resolved its NON-param
 *    side and tells the set what field type the param is being used AS, plus
 *    where, plus (when it has one) the resolved value the requirement came
 *    from, so the use can name the COLUMN that produced it.
 *
 * After the walk, `problems(p)` emits the type diagnostics, `checkValues(p, …)`
 * checks SUPPLIED values against the inferred types, and `resolved` / `info` /
 * `toJSON` export what was inferred.
 *
 * THE MERGED TYPE IS A MEET, NOT THE FIRST USE. Every observation of a name is
 * folded with `FieldType.meet`, which yields the most SPECIFIC type compatible
 * with all of them: a param compared against an `enum` in one place and plain
 * `text` in another is an ENUM, and `text{minLength:5}` beside
 * `text{maxLength:10}` carries both bounds. Seeding with the first observation
 * and keeping it (what this did through 0.6.5) is neither — it answers whichever
 * use the walk happened to reach first, which is a property of the JSON's shape
 * rather than of the query's meaning. Because a meet is commutative, associative
 * and idempotent (see `field-types/_meet.ts`), the fold's answer does not depend
 * on the observation order; only WHICH PAIR a conflict is reported against does.
 *
 * Type-safety note: this module performs ZERO casts. Field-type unification is
 * decided purely through `FieldType.meet`, a total method on the value-category
 * union.
 */
import type { FieldType, ScalarKind } from './field-type';
import type { JsonValue, ParamDef } from './schema';
import type { ResolvedType } from './resolved-type';
import type { FieldReference } from './queries/query';
import { describeValues } from './field-types/_values';
import type { Problems } from './problem';

/**
 * ONE recorded use of a param: where it is used and what that use requires of
 * it. The public per-use record, carrying the same grade of detail a query's
 * RESULT fields do (`QueryField`) — the full `type` for a consumer that wants
 * options / membership, plus the JSON-friendly `category` summary so a caller
 * never has to walk a FieldType just to label a column — and, additionally, the
 * `field` the requirement came from, which is the answer to "why did this param
 * get this type?".
 */
export interface ParamUse {
  /** Structural JSON path of the observing operand — where in the query this use sits. */
  readonly at: ReadonlyArray<string | number>;
  /** The field type THIS use requires the param to be. */
  readonly type: FieldType;
  /** The value category of {@link type} (`type.resolve()`) — a compact, JSON-friendly summary. */
  readonly category: ScalarKind;
  /**
   * The declared column this requirement was DERIVED from, when it came from
   * one — a comparison against `task.status`, a write into `task.status`, an
   * array op over `task.tags` (whose requirement is that column's ITEM type).
   * Absent when the requirement is structural rather than a column's: a row
   * bound is a number because it is a row COUNT, a function argument is its
   * declared parameter type, and a computed operand has no single owning field.
   */
  readonly field?: FieldReference;
}

/** Why a param has no merged type: the two requirements that cannot be satisfied at once. */
export interface ParamConflict {
  /** The meet of every use BEFORE the offending one — what the param was required to be so far. */
  readonly required: FieldType;
  /** Where the first of those uses sits (the anchor for the accumulated requirement). */
  readonly requiredAt: ReadonlyArray<string | number>;
  /** The use that cannot be satisfied together with {@link required}. */
  readonly use: ParamUse;
  /** The rendered explanation, as it appears in the `param.conflict` problem. */
  readonly message: string;
}

/**
 * Everything known about ONE bind parameter — its uses, the type merged from
 * them, and the conflict when they have no meet. The rich counterpart to
 * {@link ParamDef}, which stays the minimal `{ name, type }` a caller binds
 * with; this is what a caller reads to EXPLAIN a param (a UI labelling an input,
 * a diagnostic saying which use forced which type).
 */
export interface ParamInfo {
  /** The parameter's name. */
  readonly name: string;
  /** Every place the bare `param` expr appears, in walk order. */
  readonly references: ReadonlyArray<ReadonlyArray<string | number>>;
  /** Every typed use, in walk order. Empty ⇒ the param is untyped. */
  readonly uses: readonly ParamUse[];
  /** The MEET of every use — absent when there are no uses, or when they conflict. */
  readonly type?: FieldType;
  /** The value category of {@link type}, when there is one. */
  readonly category?: ScalarKind;
  /** Present exactly when there are uses but no {@link type}. */
  readonly conflict?: ParamConflict;
}

/** Internal per-name accumulation. */
interface ParamRecord {
  /** Every place the bare `param` expr was referenced. */
  references: Array<ReadonlyArray<string | number>>;
  /** Every typed use recorded for this param. */
  uses: ParamUse[];
}

/** The merged outcome of one record's uses — a type, or the conflict that prevented one. */
interface MergeOutcome {
  readonly type?: FieldType;
  readonly conflict?: ParamConflict;
}

/**
 * A compact rendering of a field type for a diagnostic: its code form plus the
 * closed value set, when it declares one. The members are the whole point of a
 * membership message — they are the fix — and `FieldType.values()` makes them
 * reachable without asking which class carries them.
 */
function describeType(ft: FieldType): string {
  return `${ft.toCode()}${describeValues(ft.values())}`;
}

/** A JSON path rendered for a message; the root is named rather than shown as empty. */
function pathOf(at: ReadonlyArray<string | number>): string {
  return at.join('.') || '(root)';
}

/** Accumulates bind-parameter references + typed uses across a query, merges them, and reports conflicts as Problems. */
export class ParamSet {
  /** name → accumulated references + uses. Insertion-ordered. */
  private readonly records = new Map<string, ParamRecord>();

  private record(name: string): ParamRecord {
    let r = this.records.get(name);
    if (!r) {
      r = { references: [], uses: [] };
      this.records.set(name, r);
    }
    return r;
  }

  /** Announce that a `param` expression with `name` exists at JSON path `at`. */
  reference(name: string, at: ReadonlyArray<string | number> = []): void {
    this.record(name).references.push(at.slice());
  }

  /**
   * Record that `name` is used where a value of `fieldType` is expected, at
   * JSON path `at`. Callers invoke this AFTER resolving their non-param side,
   * and pass that resolution as `from` when they have it, so the use can name
   * the COLUMN behind the requirement.
   */
  observe(
    name: string,
    fieldType: FieldType,
    at: ReadonlyArray<string | number> = [],
    from?: ResolvedType,
  ): void {
    const field = fieldOf(from);
    this.record(name).uses.push({
      at: at.slice(),
      type: fieldType,
      category: fieldType.resolve(),
      ...(field ? { field } : {}),
    });
  }

  /** Names of every param seen (referenced and/or observed), in first-seen order. */
  names(): string[] {
    return Array.from(this.records.keys());
  }

  /**
   * The unified field type inferred for `name` — the MEET of every use — or
   * `undefined` when it was never used OR its uses conflict.
   */
  resolved(name: string): FieldType | undefined {
    return this.merge(name).type;
  }

  /**
   * Everything known about `name`: its references, its uses, the merged type,
   * and the conflict when there is none. `undefined` for a name this set has
   * never seen.
   */
  info(name: string): ParamInfo | undefined {
    const r = this.records.get(name);
    return r && this.buildInfo(name, r);
  }

  /** Every param this set has seen, in first-seen order — the full introspection surface. */
  all(): ParamInfo[] {
    return Array.from(this.records, ([name, r]) => this.buildInfo(name, r));
  }

  /** Assemble one param's public view: its record plus the merged outcome. */
  private buildInfo(name: string, r: ParamRecord): ParamInfo {
    const { type, conflict } = this.merge(name);
    return {
      name,
      references: r.references,
      uses: r.uses,
      ...(type ? { type, category: type.resolve() } : {}),
      ...(conflict ? { conflict } : {}),
    };
  }

  /**
   * Fold this param's uses into their meet. Recomputed rather than memoized:
   * uses accumulate DURING the walk (a `param` expr resolves its own type
   * mid-walk, before the later uses exist), so a cached answer would pin the
   * partial one. The fold is linear in the number of uses of ONE param.
   */
  private merge(name: string): MergeOutcome {
    const r = this.records.get(name);
    if (!r || r.uses.length === 0) return {};
    const first = r.uses[0]!;
    let acc = first.type;
    for (let i = 1; i < r.uses.length; i++) {
      const use = r.uses[i]!;
      const next = acc.meet(use.type);
      if (next === undefined) {
        return { conflict: { required: acc, requiredAt: first.at, use, message: conflictMessage(name, acc, first.at, use) } };
      }
      acc = next;
    }
    return { type: acc };
  }

  /**
   * Emit param TYPE diagnostics into `p`:
   *  - `param.untyped`  — referenced but never used against any type, so its
   *    input type cannot be inferred. Reported at each reference site.
   *  - `param.conflict` — used in ways with no common type. The message names
   *    both requirements AND both paths, and says WHICH of the two failed: two
   *    different value categories, or one category whose constraints cannot be
   *    satisfied together (two closed sets sharing no member, two disjoint
   *    length bounds). Reported at the offending use.
   */
  problems(p: Problems): void {
    for (const [name, r] of this.records) {
      if (r.uses.length === 0) {
        // Never used against a type → untyped. Report at every reference.
        for (const at of r.references) {
          p.at([...at], () => {
            p.error(
              'param.untyped',
              `Parameter '${name}' is never compared against a typed value, so its type cannot be inferred. Use it in a comparison / filter / function argument against a known field.`,
            );
          });
        }
        continue;
      }
      const { conflict } = this.merge(name);
      if (conflict) {
        p.at([...conflict.use.at], () => {
          p.error('param.conflict', conflict.message);
        });
      }
    }
  }

  /**
   * Check SUPPLIED param values against the type each param's uses require —
   * the check that turns "bound and silently wrong" into a stated problem. Ran
   * BEFORE execution, and reported as Problems rather than thrown, so a bad
   * binding reads like every other diagnostic this package emits.
   *
   * Three findings, and only one of them blocks:
   *  - `param.value` (ERROR) — the value does not satisfy the merged type. A
   *    `null` never does this: a param is always potentially-null (see
   *    `ParamExpr.resolve`), and binding SQL NULL is a legitimate thing to ask
   *    for.
   *  - `param.missing` (WARNING) — a typed param has no value. Not an error,
   *    because an unbound param deliberately binds NULL, which `autoPaginate`
   *    relies on to mean "no limit / no offset".
   *  - `param.unknown` (WARNING) — a value was supplied under a name this query
   *    has no param for, which is what a typo looks like. Not an error, because
   *    one params bag is routinely reused across several queries.
   *
   * A RELATION-typed param is exempt from the value check — see the comment at
   * the site; it binds an IDENTITY, which for a composite key is a keyed object
   * the relation's own value schema does not describe.
   *
   * A param with NO merged type is skipped: `param.untyped` / `param.conflict`
   * (from {@link problems}) already say why, and there is nothing to check
   * against.
   */
  checkValues(p: Problems, values: Readonly<Record<string, JsonValue | undefined>>): void {
    for (const [name, r] of this.records) {
      const { type } = this.merge(name);
      if (!type) continue;
      const raw = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
      // A merged type exists only when there is at least one use, so the first
      // use is always there to anchor the problem at.
      p.at([...r.uses[0]!.at], () => {
        if (raw === undefined) {
          p.warn(
            'param.missing',
            `Parameter '${name}' (${describeType(type)}) has no supplied value, so it binds SQL NULL.`,
          );
          return;
        }
        // NULL is bindable against any param: a param is always potentially-null.
        if (raw === null || type.validValue(raw)) return;
        // A RELATION-typed param is exempt, for the reason `validateWriteValue`
        // already exempts a relation COLUMN: what you bind to one is the target's
        // IDENTITY — a scalar for a single-column key, a `{ pk }` OBJECT for a
        // composite one — and `RelationFieldType.toValueSchema()` describes only
        // the scalar case, so checking against it would refuse every legitimate
        // composite binding. Checking the identity properly needs the target's
        // primary key, which is the same separate piece of work.
        if (type.resolve() === 'relation') return;
        p.error(
          'param.value',
          `Parameter '${name}' was given ${JSON.stringify(raw)}, which is not a valid value of the type its uses require: ${describeType(type)}.`,
        );
      });
    }
    for (const name of Object.keys(values)) {
      if (this.records.has(name)) continue;
      const known = this.names();
      p.warn(
        'param.unknown',
        `A value was supplied for '${name}', which is not a parameter of this query. ${
          known.length > 0 ? `Its parameters are: ${known.join(', ')}.` : 'It takes no parameters.'
        }`,
      );
    }
  }

  /**
   * Export the resolved params as `ParamDef[]` for building the query's input
   * schema + binding map. Params that are untyped or in conflict are SKIPPED:
   * a `ParamDef` exists to say what to bind, and one without a type would be a
   * lie about a param nothing can bind correctly. Their problems are reported
   * by {@link problems}, and {@link all} still reports them in full — with their
   * uses and their conflict — for a caller that wants to explain rather than
   * bind. (That split is why `ParamDef.type` stays required.)
   */
  toJSON(): ParamDef[] {
    const out: ParamDef[] = [];
    for (const name of this.records.keys()) {
      const ft = this.resolved(name);
      if (ft) out.push({ name, type: ft.toJSON() });
    }
    return out;
  }
}

/** The declared column behind a resolution, when it has one (a whole Type / computed value does not). */
function fieldOf(from: ResolvedType | undefined): FieldReference | undefined {
  return from?.kind === 'field' ? { type: from.type.name, field: from.field.name } : undefined;
}

/**
 * Render a `param.conflict`. Names both requirements and both paths, and
 * distinguishes the two ways a meet fails: DIFFERENT value categories (nothing
 * is both a number and a text), versus the same category whose constraints
 * cannot hold at once (two closed sets sharing no member, two disjoint bounds,
 * two different patterns) — a distinction the reader cannot make from the paths
 * alone, and the reason the rendered types carry their value sets.
 */
function conflictMessage(
  name: string,
  required: FieldType,
  requiredAt: ReadonlyArray<string | number>,
  use: ParamUse,
): string {
  const here = `'${describeType(required)}' at ${pathOf(requiredAt)}`;
  const there = `'${describeType(use.type)}' at ${pathOf(use.at)}`;
  return required.comparableWith(use.type)
    ? `Parameter '${name}' is used inconsistently: ${here} and ${there} are both ${required.resolve()} but share no value that satisfies both.`
    : `Parameter '${name}' is used inconsistently: ${here} but ${there}.`;
}
