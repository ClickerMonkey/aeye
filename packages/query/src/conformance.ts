/**
 * `@aeye/query/conformance` — the property tests the BUILTIN field types are
 * held to, exported so a consumer can run them against its OWN declaration.
 *
 * WHY THIS IS A PACKAGE EXPORT AND NOT A PARAGRAPH IN THE DOCS. A registered
 * refinement is compiled by the library, so a declarer cannot write a `meetWith`
 * and cannot break the lattice by writing code. What a declarer CAN do is
 * declare a shape whose consequences they did not follow through — an option set
 * that makes two of their own columns un-meetable, a stricter `value` gate that
 * admits something the base bucket cannot hold, a gate that refuses nothing at
 * all. None of that is detectable at registration, because each of those
 * declarations is individually legal; it is only visible as a PROPERTY over a
 * set of types. So the honest thing is to ship the property runner rather than
 * describe the properties and hope.
 *
 * The laws are the ones `param-meet.test.ts` proves over the builtins, and this
 * module is where they now LIVE — that test calls {@link checkLatticeLaws} over
 * its own type set rather than carrying a second copy of the loops. One
 * implementation, held to the builtins on every run of this package's suite and
 * available to a consumer for theirs.
 *
 * ```ts
 * import { checkFieldType } from '@aeye/query/conformance';
 *
 * it('geometry is a well-behaved field type', () => {
 *   const report = checkFieldType(geometryDecl, { value: geoJsonSchema });
 *   expect(report.problems).toEqual([]);
 * });
 * ```
 *
 * `@aeye/query/conformance` and `@aeye/query` resolve to the SAME bundle — the
 * subpath is a curated name, not a second artifact, and the reason is recorded
 * on the re-export in `index.ts`: a second self-contained bundle carries its own
 * classes, so `instanceof` is false across the two and this harness reports
 * spurious failures for correct types (measured). Import from the subpath
 * anyway: it says what the surface is for, and it is what the docs and the
 * CHANGELOG name.
 */
import { z } from 'zod';
import { didYouMean } from './aids';
import type { QueryEngine } from './engine';
import { FieldType, SCALAR_KINDS } from './field-type';
import {
  ArrayFieldType,
  BoolFieldType,
  DateFieldType,
  JsonFieldType,
  MoneyFieldType,
  NumberFieldType,
  TextFieldType,
  TimestampFieldType,
} from './field-types/index';
import { OP_ARMS } from './exprs/comparison';
import { OperatorExpr } from './exprs/operator';
import type { OperatorDef, QueryOperator } from './operator';
import type { Problem } from './problem';
import { Problems, QueryTypeError } from './problem';
import { createRegistry, type Registry } from './registry';
import {
  REFINABLE_BASES,
  type FieldTypeCompareDecl,
  type FieldTypeImpl,
  type FieldTypeRefinement,
  type FieldTypeRefinementDef,
  type RefinableBase,
} from './refinement';
import type { ComparisonOp, ExprDef, FieldTypeDef, FieldTypeKind, JsonValue, SelectDef } from './schema';
import type { SqlValue } from './sql/emit';

// ─── The corpus ──────────────────────────────────────────────────────────────

/**
 * The default value corpus every soundness / gate check runs over — one
 * representative of each JSON shape a column can be handed.
 *
 * It is deliberately SMALL and category-spanning rather than exhaustive: the
 * properties here are universally quantified, so a counterexample is what a
 * corpus is for, and one member per shape finds the counterexamples that
 * actually occur (a `null`, an empty string, a wrong-category scalar, a
 * container where a scalar was expected). A consumer whose type has interesting
 * values of its own passes them as `samples` — a geometry's corpus should hold a
 * real GeoJSON `Point`, and nothing here can guess one.
 */
export const DEFAULT_SAMPLES: readonly JsonValue[] = [
  'a', 'bb', 'abcdefgh', '', '2026-01-01', '2026-01-01T09:30',
  0, 1, 2, 7, -1, 1.5,
  true, false, null,
  ['a'], [1], [], { x: 1 }, {},
];

/**
 * The unconstrained (TOP) type of each refinable kind — the right-hand side of
 * the `x ⊓ ⊤ = x` law.
 *
 * `relation` is absent, and that is a fact about relations rather than an
 * omission: its `to` is an IDENTITY, not a constraint, so there is no relation
 * that constrains nothing and therefore no top to meet against. It is also the
 * one base a refinement may not narrow, so nothing this module checks can
 * produce one.
 */
export function topsByKind(): Partial<Record<FieldTypeKind, FieldType>> {
  return {
    text: new TextFieldType(),
    number: new NumberFieldType(),
    money: new MoneyFieldType(),
    bool: new BoolFieldType(),
    date: new DateFieldType(),
    timestamp: new TimestampFieldType(),
    json: new JsonFieldType(),
    array: new ArrayFieldType(),
  };
}

// ─── The lattice laws ────────────────────────────────────────────────────────

/** One law's verdict: its name and every combination that broke it. */
export interface LatticeLaw {
  /** Stable law name — `commutative`, `associative`, `sound`, … */
  readonly law: string;
  /** What the law says, for a failure message that explains itself. */
  readonly states: string;
  /**
   * Every offending combination, as `"<a> ∧ <b>: <what happened>"`. EMPTY means
   * the law holds. Collected rather than thrown at the first one, because a
   * broken meet usually breaks in a family and the first counterexample is
   * rarely the informative one.
   */
  readonly violations: readonly string[];
}

/** The verdict of {@link checkLatticeLaws} — one entry per law, plus the roll-up. */
export interface LatticeLawReport {
  /** True when every law holds. */
  readonly ok: boolean;
  /** Every law, in a stable order, whether or not it holds. */
  readonly laws: readonly LatticeLaw[];
  /** Only the laws that failed — what a test asserts is empty. */
  readonly failed: readonly LatticeLaw[];
}

/** What {@link checkLatticeLaws} needs beyond the types themselves. */
export interface LatticeLawOptions {
  /**
   * The registry the types were built from. Supplied ⇒ the ROUND-TRIP law runs:
   * every type, and every type the meet produces, must re-parse on the registry
   * that produced it to exactly itself. That is the property a meet's def has to
   * satisfy to be handed back through `params()` at all.
   */
  readonly registry?: Registry;
  /** The value corpus the soundness law is proved over. Defaults to {@link DEFAULT_SAMPLES}. */
  readonly samples?: readonly JsonValue[];
  /** The TOP of each kind, for `x ⊓ ⊤ = x`. Defaults to {@link topsByKind}. */
  readonly tops?: Partial<Record<FieldTypeKind, FieldType>>;
}

/**
 * Prove the meet is a genuine meet over `types` — the six laws, plus the two the
 * `as` tag added.
 *
 * THE LAWS ARE UNCONDITIONAL AND THERE ARE NO CARVE-OUTS. A meet that needs an
 * exception is not a meet: `ParamSet` folds an arbitrary number of observations
 * in walk order, so a law that holds "except for X" means a param's inferred
 * type depends on where in the JSON tree its uses happened to sit. If a type set
 * cannot satisfy one of these, the answer is a fix to the type or a refusal at
 * the declaration — which is exactly how the `0.6.6` closed-set narrowing was
 * resolved, and why `x ⊓ ⊤ = x` is stated with no expected-failure list.
 *
 * The loops compare CANONICAL STRINGS rather than deep-equalling defs: a
 * hundred-name set is ~10^6 triples for associativity alone, and a deep compare
 * spends the whole budget inside the comparison rather than on the property.
 */
export function checkLatticeLaws(
  types: Readonly<Record<string, FieldType>>,
  opts?: LatticeLawOptions,
): LatticeLawReport {
  const names = Object.keys(types);
  const at = (name: string): FieldType => {
    const ft = types[name];
    /* v8 ignore next -- `names` comes from `types`, so every lookup hits */
    if (!ft) throw new Error(`checkLatticeLaws: no type named '${name}'`);
    return ft;
  };
  const samples = opts?.samples ?? DEFAULT_SAMPLES;
  const tops = opts?.tops ?? topsByKind();

  const laws: LatticeLaw[] = [];
  const law = (name: string, states: string, violations: string[]): void => {
    laws.push({ law: name, states, violations });
  };

  // 0 — TOTAL. A harness is handed types that may be WRONG; one that propagates
  // their failure never reports the defect it was called to find. So EVERY call
  // into consumer-supplied code goes through `attempt` — and "consumer-supplied"
  // is wider than it first looks, which is the lesson of the two rounds this
  // check took to get right:
  //
  //  - `meetWith`, `clone`, `toJSON`, `comparableWith` on a hand-written
  //    `FieldType` subclass (`defineFieldType` is public, and this module's own
  //    tests treat such a subclass as in-scope input);
  //  - schema CONSTRUCTION — a hand-built `text{pattern:'(['}` throws a raw
  //    `SyntaxError` out of zod's internals;
  //  - schema USE, which the first pass missed. A structural `value` gate is the
  //    documented shape for a refinement whose raw value is an object, and the
  //    obvious one — `z.string().refine(s => JSON.parse(s).type === 'Point')` —
  //    throws on `'a'`, which is the FIRST member of `DEFAULT_SAMPLES`. So the
  //    first thing a geometry declarer did crashed the harness;
  //  - even RENDERING a value: `JSON.stringify` throws on a cyclic sample.
  //
  // Violations are DEDUPED BY STAGE + MESSAGE, keeping the first site that
  // produced each. One broken method throws once per PAIR with a different label
  // each time (`t0 ∧ t1`, `t0 ∧ t2`, …) while the message is identical, so
  // deduping the whole LINE collapses nothing and a 50-type set reports one
  // defect 2,500 times.
  //
  // The key is the STAGE plus the message; the LABEL — which pair, which type —
  // rides along on the first occurrence and is not part of the key. That split
  // is the whole design, and both halves were got wrong once:
  //
  //  - keying on the whole LINE collapsed nothing, because a per-pair label
  //    differs every time (`t0 ∧ t1`, `t0 ∧ t2`, …) while the message is
  //    identical — one broken `toJSON` reported 64 times over 8 types, and 2,500
  //    times over 50;
  //  - keying on the MESSAGE alone over-collapsed, merging genuinely different
  //    failures: one type's throwing `toJSON` and another's throwing
  //    `builtinValueSchema` are two types at two stages, and with the same
  //    message they became a single line labelled with a pair naming neither.
  //
  // Stage + message separates the stages and collapses the repetition, and the
  // kept label still points at one place to start looking.
  const threwSeen = new Set<string>();
  const threw: string[] = [];
  const attempt = <T>(stage: string, fn: () => T, where?: string): T | undefined => {
    try {
      return fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const seen = `${stage}|${message}`;
      if (!threwSeen.has(seen)) {
        threwSeen.add(seen);
        threw.push(`${stage}${where === undefined ? '' : ` at ${where}`}: ${message}`);
      }
      return undefined;
    }
  };
  /** `value` as JSON for a message — total, because a cyclic sample throws. */
  const render = (value: unknown): string => attempt('JSON.stringify(sample)', () => JSON.stringify(value)) ?? '<unrenderable>';
  /** The stage label for a meet, so 2,500 identical meet failures collapse to one line. */
  const MEET = 'FieldType.meet()';

  // Every pairwise meet, computed ONCE — associativity would otherwise recompute
  // each of them |names| times.
  const pairs = new Map<string, FieldType | undefined>();
  for (const x of names) {
    for (const y of names) pairs.set(`${x}|${y}`, attempt(MEET, () => at(x).meet(at(y)), `${x} ∧ ${y}`));
  }
  const pair = (x: string, y: string): FieldType | undefined => pairs.get(`${x}|${y}`);
  // A type's canonical form for comparison. BOTH halves are guarded, and the
  // second is the one the first pass missed: `toJSON()` is a member a subclass
  // supplies, so it can throw — and it can also RETURN something
  // `JSON.stringify` refuses. A cyclic def gives `TypeError: Converting circular
  // structure to JSON` and a `BigInt` gives `Do not know how to serialize a
  // BigInt`, both from the serializer rather than from the call, both uncaught
  // when only the call was wrapped. A type that cannot be rendered compares as
  // `null` — it fails the laws it takes part in AND is reported under `total`.
  const key = (ft: FieldType | undefined): string => {
    if (ft === undefined) return 'null';
    const json = attempt('FieldType.toJSON()', () => ft.toJSON());
    return attempt('JSON.stringify(FieldType.toJSON())', () => JSON.stringify(json ?? null)) ?? 'null';
  };
  /** `ft.kind` — an ACCESSOR on a subclass, so it can throw like any other. */
  const kindOf = (ft: FieldType): FieldTypeKind | undefined => attempt('FieldType.kind', () => ft.kind);
  /** `ft.refinement` — likewise an accessor, and likewise consumer-supplied. */
  const refinementOf = (ft: FieldType): FieldTypeRefinement | undefined =>
    attempt('FieldType.refinement', () => ft.refinement);
  const metKey = (a: FieldType | undefined, b: FieldType | undefined): string =>
    key(a && b ? attempt(MEET, () => a.meet(b), `${key(a)} ∧ ${key(b)}`) : undefined);

  // 1 — COMMUTATIVE. Byte for byte, not merely equivalent: `params()` hands the
  // def out, and a def that differs by key order is a different tool schema.
  const asymmetric: string[] = [];
  for (const x of names) {
    for (const y of names) {
      const forward = key(pair(x, y));
      const backward = key(pair(y, x));
      if (forward !== backward) asymmetric.push(`${x} ∧ ${y}: ${forward} vs ${backward}`);
    }
  }
  law('commutative', 'a ⊓ b is b ⊓ a, byte for byte', asymmetric);

  // 2 — IDEMPOTENT, against itself AND against an equal-but-distinct instance.
  // The second is the one that catches a `clone()` that drops something.
  const notIdempotent: string[] = [];
  for (const x of names) {
    const self = key(at(x));
    if (key(pair(x, x)) !== self) notIdempotent.push(`${x} ∧ ${x}: ${key(pair(x, x))} vs ${self}`);
    const copy = key(attempt('FieldType.clone()', () => at(x).meet(at(x).clone()), `clone(${x})`));
    if (copy !== self) notIdempotent.push(`${x} ∧ clone(${x}): ${copy} vs ${self}`);
  }
  law('idempotent', 'a ⊓ a is a, and a ⊓ clone(a) is a', notIdempotent);

  // 3 — ASSOCIATIVE. The law a fold over uses in walk order actually depends on.
  const notAssociative: string[] = [];
  for (const x of names) {
    for (const y of names) {
      for (const z of names) {
        const left = metKey(pair(x, y), at(z));
        const right = metKey(at(x), pair(y, z));
        if (left !== right) notAssociative.push(`${x} ∧ ${y} ∧ ${z}: ${left} vs ${right}`);
      }
    }
  }
  law('associative', '(a ⊓ b) ⊓ c is a ⊓ (b ⊓ c)', notAssociative);

  // 4 — TOP IDENTITY. The meet is the GREATEST lower bound, not merely a lower
  // one: meeting with the unconstrained type of your own kind changes nothing.
  const narrowed: string[] = [];
  for (const x of names) {
    const kind = kindOf(at(x));
    const top = kind === undefined ? undefined : tops[kind];
    if (!top) continue;
    const met = key(attempt(MEET, () => at(x).meet(top), `${x} ∧ ⊤`));
    if (met !== key(at(x))) narrowed.push(`${x} ∧ ⊤: ${met} vs ${key(at(x))}`);
  }
  law('top-identity', 'x ⊓ ⊤ is x — the meet is the GREATEST lower bound', narrowed);

  // 5 — A MEET IMPLIES COMPARABILITY. The meet is the constructive form of
  // `comparableWith`, so it must live inside it. (Not the converse: two disjoint
  // closed sets are comparable and have no meet.)
  const incomparable: string[] = [];
  for (const x of names) {
    for (const y of names) {
      if (pair(x, y) !== undefined
        && attempt('FieldType.comparableWith()', () => at(x).comparableWith(at(y)), `${x} ∧ ${y}`) === false) {
        incomparable.push(`${x} ∧ ${y} has a meet but the two are not comparableWith`);
      }
    }
  }
  law('meet-implies-comparable', 'a meet exists only where the two are comparableWith', incomparable);

  // 6 — SOUND. The property a validator depends on: the merged type admits
  // nothing that both uses would not have admitted.
  //
  // `toValueSchema` is CACHED per type: it rebuilds its zod on every call, so an
  // uncached loop over |names|² × |samples| measures zod construction rather
  // than the property. A type whose schema cannot be BUILT (an uncompilable
  // `pattern`) is recorded above and treated as admitting nothing here, so one
  // broken type costs its own report line rather than the whole run.
  const schemas = new Map<FieldType, z.ZodTypeAny | undefined>();
  const admits = (ft: FieldType, v: JsonValue): boolean => {
    if (!schemas.has(ft)) schemas.set(ft, attempt('FieldType.toValueSchema()', () => ft.toValueSchema()));
    const schema = schemas.get(ft);
    if (!schema) return false;
    // `safeParse` is guarded too, and THAT is the half the first pass missed: a
    // `.refine()` body is arbitrary consumer code, so a gate that parses its
    // input throws on a sample that is not of its type. Treated as "refuses",
    // which is the conservative answer — a value the gate could not judge is not
    // evidence of unsoundness.
    return attempt('ZodType.safeParse(sample)', () => schema.safeParse(v).success) ?? false;
  };
  const unsound: string[] = [];
  for (const x of names) {
    for (const y of names) {
      const m = pair(x, y);
      if (!m) continue;
      for (const v of samples) {
        if (admits(m, v) && !(admits(at(x), v) && admits(at(y), v))) {
          unsound.push(`${x} ∧ ${y} admits ${render(v)}`);
        }
      }
    }
  }
  law('sound', 'the meet accepts nothing that both operands do not', unsound);

  // 7 — A SURVIVING TAG IS ON ITS OWN BASE KIND. The two cross-kind families
  // (`number`/`money`, `date`/`timestamp`) let a meet change kind underneath a
  // tag, and a tag on the wrong kind is a def the registry itself throws on.
  const strayTags: string[] = [];
  // 8 — …AND IT IS ONE OF THE OPERANDS' OWN INSTANCES. Names are per-registry,
  // so a tag invented from a name rather than taken from an operand would be a
  // different compilation with a different value gate and a different sqlType.
  const foreignTags: string[] = [];
  for (const x of names) {
    for (const y of names) {
      const m = pair(x, y);
      const tag = m === undefined ? undefined : refinementOf(m);
      if (!m || !tag) continue;
      const metKind = kindOf(m);
      if (metKind !== tag.base) strayTags.push(`${x} ∧ ${y}: \`${tag.name}\` refines ${tag.base}, met kind is ${String(metKind)}`);
      if (tag !== refinementOf(at(x)) && tag !== refinementOf(at(y))) {
        foreignTags.push(`${x} ∧ ${y}: \`${tag.name}\` is neither operand's own compilation`);
      }
    }
  }
  law('refinement-base', 'every surviving `as` tag is on its own base kind', strayTags);
  law('refinement-instance', "a surviving `as` tag is one of the operands' own instances", foreignTags);

  // 9 — ROUND TRIP, when a registry says which one to re-parse against. Every
  // type AND every type the meet produces must survive `toJSON` → `parse` →
  // `toJSON` unchanged, because that def is what `params()` hands a caller.
  const registry = opts?.registry;
  if (registry) {
    const broken: string[] = [];
    const roundTrip = (label: string, ft: FieldType): void => {
      // `toJSON()` sits INSIDE the guard, not outside it: it is a member a
      // subclass supplies, so a throwing one would escape this law entirely —
      // the exact shape of the bug the `total` law exists to prevent, one line
      // above where it was fixed.
      const json = attempt('FieldType.toJSON()', () => ft.toJSON());
      if (json === undefined) return;
      try {
        const reparsed = registry.parseFieldType(json).toJSON();
        if (JSON.stringify(reparsed) !== JSON.stringify(json)) {
          broken.push(`${label}: ${render(json)} re-parsed to ${render(reparsed)}`);
        }
      } catch (err) {
        broken.push(`${label}: ${render(json)} does not re-parse — ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    for (const x of names) roundTrip(x, at(x));
    for (const x of names) {
      for (const y of names) {
        const m = pair(x, y);
        if (m) roundTrip(`${x} ∧ ${y}`, m);
      }
    }
    law('round-trip', 'every type and every meet re-parses to exactly itself', broken);
  }

  // Filed LAST so its violations name everything the run tripped over, not only
  // what had happened by the time the meets were precomputed.
  law('total', 'no meet and no value schema throws — a defect is REPORTED, never raised', threw);

  const failed = laws.filter((l) => l.violations.length > 0);
  return { ok: failed.length === 0, laws, failed };
}

// ─── One declaration, checked end to end ─────────────────────────────────────

/**
 * The CODE half a consumer hands {@link checkFieldType}, plus the values it
 * wants the properties proved over.
 */
export interface FieldTypeCheckImpl extends FieldTypeImpl {
  /**
   * Values of this type, added to {@link DEFAULT_SAMPLES}. Supply real ones: the
   * default corpus spans JSON shapes, and only the declarer knows what a
   * well-formed value of THEIR type looks like — a gate that refuses everything
   * in the default corpus and everything real is vacuous in the direction that
   * matters, and nothing here can tell without one.
   */
  readonly samples?: readonly JsonValue[];
}

/**
 * The OPTION-FREE def of each refinable base, and a peer DECLARATION over it.
 *
 * Two `Record`s over `RefinableBase` rather than two casts, and that is the
 * point: `decl.base` is the whole union here, so `{ kind: decl.base }` is an
 * object TypeScript cannot relate to any BRANCH of `FieldTypeDef` — the shape a
 * cast would paper over. A table produces a concrete branch per base, and a
 * tenth refinable kind fails to compile here rather than falling through to
 * whatever a cast happened to assert.
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

/** The peer refinement's declaration, per base (see {@link BARE_DEF_OF} for why it is a table). */
const PEER_DECL_OF: Readonly<Record<RefinableBase, (name: string) => FieldTypeRefinementDef>> = {
  number: (name) => ({ name, base: 'number', instructions: PEER_INSTRUCTIONS }),
  text: (name) => ({ name, base: 'text', instructions: PEER_INSTRUCTIONS }),
  money: (name) => ({ name, base: 'money', instructions: PEER_INSTRUCTIONS }),
  bool: (name) => ({ name, base: 'bool', instructions: PEER_INSTRUCTIONS }),
  date: (name) => ({ name, base: 'date', instructions: PEER_INSTRUCTIONS }),
  timestamp: (name) => ({ name, base: 'timestamp', instructions: PEER_INSTRUCTIONS }),
  json: (name) => ({ name, base: 'json', instructions: PEER_INSTRUCTIONS }),
  array: (name) => ({ name, base: 'array', instructions: PEER_INSTRUCTIONS }),
};

/** What the peer refinement tells a model it is — required, like every other declaration's. */
const PEER_INSTRUCTIONS = 'A second refinement of the same base, registered by the conformance check so the `as` lattice is exercised against a name other than the base itself.';

/** The peer refinement's name — a legal refinement name, and one nothing real would claim. */
const PEER_NAME = 'ConformancePeer';

/** A def of `base`, optionally tagged and carrying a `with` bag — the no-cast road (see {@link BARE_DEF_OF}). */
function defOf(
  base: RefinableBase,
  as?: string,
  withOptions?: Readonly<Record<string, JsonValue>>,
): FieldTypeDef {
  const def = BARE_DEF_OF[base]();
  if (as === undefined) return def;
  return withOptions === undefined ? { ...def, as } : { ...def, as, with: withOptions };
}

/** The verdict of {@link checkFieldType}. */
export interface FieldTypeConformanceReport {
  /** True when nothing was found — what a consumer's test asserts. */
  readonly ok: boolean;
  /** Everything found, as `Problem`s: `error` blocks, `warning` is worth reading. */
  readonly problems: readonly Problem[];
  /**
   * The lattice verdict over the type set built from the declaration, or
   * `undefined` when the declaration did not register at all (in which case
   * there was nothing to prove anything about).
   */
  readonly lattice: LatticeLawReport | undefined;
}

/**
 * Run the builtins' own property tests against ONE declaration — the four
 * lattice laws, round-trip identity, `clone` equality, soundness, and (with an
 * `impl`) the two cross-library facts about its value gate.
 *
 * WHAT IT BUILDS. A fresh registry carrying `decl`, a PEER refinement over the
 * same base (which must conflict with it — a registered name meets only itself),
 * and the unrefined TOP of every refinable kind. Then, for each option the
 * declaration declares for itself, a column for every value that option can take
 * — enumerable when the option's type is a closed set, otherwise its default.
 * The result is the smallest set that exercises every arm the declaration
 * touches: the `as` lattice against another name and against its own base, the
 * OWN-OPTION lattice against a sibling column and against a column that left the
 * option unset, and the cross-kind families the tag can fall off.
 *
 * WHAT IT CANNOT DO, said plainly rather than left to be discovered: it cannot
 * tell whether the emitted SQL means what the declarer intended, and it cannot
 * tell whether an in-memory answer agrees with the database's. Those need a live
 * connection and belong in a consumer's integration suite.
 */
export function checkFieldType(
  decl: FieldTypeRefinementDef,
  impl?: FieldTypeCheckImpl,
): FieldTypeConformanceReport {
  const problems: Problem[] = [];
  const registry = createRegistry();
  try {
    registry.registerFieldType(decl);
  } catch (err) {
    problems.push(asProblem(err, ['registerFieldType'], 'conformance.registration'));
    return { ok: false, problems, lattice: undefined };
  }
  const refinement = registry.fieldTypeRefinement(decl.name);
  /* v8 ignore next -- registration just succeeded, so the refinement is there */
  if (!refinement) return { ok: false, problems, lattice: undefined };

  if (impl) {
    try {
      // The full code half, not just the gate: a check that registered less than
      // the consumer will is checking a different type than the one they ship.
      registry.registerFieldTypeImpl(decl.name, { value: impl.value, compareValues: impl.compareValues });
    } catch (err) {
      problems.push(asProblem(err, ['registerFieldTypeImpl'], 'conformance.registration'));
      return { ok: false, problems, lattice: undefined };
    }
  }

  // A PEER over the same base, so the set contains a name this one must conflict
  // with. Without it the `as` lattice is only ever exercised against its own
  // base, which is the arm that cannot fail.
  try {
    registry.registerFieldType(PEER_DECL_OF[decl.base](PEER_NAME));
  } catch (err) {
    problems.push(asProblem(err, ['peer'], 'conformance.registration'));
  }

  // `impl.samples` is consumer data reaching a SPREAD, so a non-array throws a
  // bare `TypeError` before any check runs. Reported as a problem instead, and
  // the run continues on the default corpus.
  const supplied = impl?.samples;
  if (supplied !== undefined && !Array.isArray(supplied)) {
    problems.push({
      path: ['checkFieldType', decl.name, 'samples'],
      code: 'conformance.bad-samples',
      severity: 'error',
      message: `\`samples\` must be an array of values of your type, got ${typeof supplied}.`,
    });
  }
  const samples: readonly JsonValue[] = [...DEFAULT_SAMPLES, ...(Array.isArray(supplied) ? supplied : [])];
  const types: Record<string, FieldType> = {};
  const build = (label: string, def: FieldTypeDef): void => {
    try {
      types[label] = registry.parseFieldType(def);
    } catch (err) {
      problems.push(asProblem(err, ['parseFieldType', label], 'conformance.parse'));
    }
  };

  build(decl.name, defOf(decl.base, decl.name));
  if (registry.fieldTypeRefinement(PEER_NAME)) build(PEER_NAME, defOf(decl.base, PEER_NAME));
  // One column per value of each declared own option — the arm the flat lattice
  // has to get right (two columns that set it differently must NOT meet; a
  // column that left it unset must meet either).
  for (const option of refinement.ownOptions.values()) {
    for (const value of optionValues(option.type, option.default)) {
      build(
        `${decl.name}[${option.name}=${JSON.stringify(value)}]`,
        defOf(decl.base, decl.name, { [option.name]: value }),
      );
    }
  }
  // The unrefined tops, so `x ⊓ ⊤ = x` and the cross-kind families are covered.
  const tops = topsByKind();
  for (const base of REFINABLE_BASES) {
    const top = tops[base];
    if (top) types[`⊤${base}`] = top;
  }

  const lattice = checkLatticeLaws(types, { registry, samples });
  for (const failure of lattice.failed) {
    problems.push({
      path: ['checkFieldType', decl.name, failure.law],
      code: `conformance.${failure.law}`,
      severity: 'error',
      message:
        `The meet is not ${failure.law} over \`${decl.name}\` — it must be, because a param's type is ` +
        `folded over its uses in WALK order. It states: ${failure.states}. ` +
        `${failure.violations.length} counterexample(s): ${failure.violations.slice(0, 5).join('; ')}` +
        `${failure.violations.length > 5 ? ' …' : ''}`,
    });
  }

  problems.push(...checkValueGate(decl, registry, impl, samples));
  problems.push(...checkComparator(refinement, impl, samples));
  return { ok: problems.length === 0, problems, lattice };
}

/**
 * The ORDER laws a supplied `compareValues` is held to — reflexivity,
 * antisymmetry, transitivity, numeric answers, and totality.
 *
 * They are not style points. `Value.compareTo` normalises the answer to
 * `-1 | 0 | 1` and hands it to `Array.prototype.sort`, to `min` / `max`, and to
 * every `=` / `<` predicate in the runtime — and a comparator that is not an
 * order makes each of those wrong in a DIFFERENT way, none of them detectable:
 * a non-antisymmetric one sorts differently depending on the input's initial
 * permutation, a non-transitive one produces an implementation-defined
 * permutation from `sort`, and a `NaN` answer reads as "equal" so `a = b` is
 * TRUE for values that are not, `IN` matches a member it should not, a join
 * pairs rows that do not correspond, and `min` / `max` keep whichever candidate
 * they saw first. (Not a group KEY: `DISTINCT` / `GROUP BY` key on the raw
 * value and never reach a comparator at all — see `runtime/record.ts`.) There is
 * no error channel at any of those sites, which is exactly why the check belongs
 * at the declaration.
 *
 * NULLs ARE EXCLUDED FROM THE CORPUS, and that is a fact about the contract
 * rather than a gap: `compareTo` decides NULL placement before it consults a
 * comparator (SQL's NULL ordering belongs to the SORT, not to the type), so a
 * comparator is never handed one and holding it to an opinion about one would
 * test a call that cannot happen.
 */
function checkComparator(
  refinement: FieldTypeRefinement,
  impl: FieldTypeCheckImpl | undefined,
  samples: readonly JsonValue[],
): Problem[] {
  const compare = impl?.compareValues;
  if (!compare) return [];
  const path = ['checkFieldType', refinement.name, 'compareValues'];
  const corpus = samples.filter((v) => v !== null);
  const problems: Problem[] = [];
  const bad = (code: string, message: string, severity: Problem['severity'] = 'error'): void => {
    problems.push({ path, code, severity, message });
  };

  // EVERY call below is consumer code, and the first thing a comparator does
  // with a value it did not expect is usually to throw. A throw here is the
  // finding, not a crash of the harness — `Value.compareTo` does not catch one,
  // so it would surface as an exception out of a sort with no declaration in
  // sight.
  const threw: string[] = [];
  const answered = new Map<string, number>();
  const call = (a: JsonValue, b: JsonValue): number | undefined => {
    const key = safeJson([a, b]);
    const cached = answered.get(key);
    if (cached !== undefined) return cached;
    let answer: number;
    try {
      answer = compare(a, b);
    } catch (err) {
      const line = `compareValues(${safeJson(a)}, ${safeJson(b)}): ${err instanceof Error ? err.message : String(err)}`;
      if (!threw.includes(line)) threw.push(line);
      return undefined;
    }
    if (typeof answer !== 'number' || Number.isNaN(answer)) {
      const line = `compareValues(${safeJson(a)}, ${safeJson(b)}) answered ${safeJson(answer)}`;
      if (!threw.includes(line)) threw.push(line);
      return undefined;
    }
    answered.set(key, answer);
    return answer;
  };

  const notOrder: string[] = [];
  for (const a of corpus) {
    const self = call(a, a);
    if (self !== undefined && self !== 0) notOrder.push(`compareValues(x, x) = ${self} for x = ${safeJson(a)}`);
    for (const b of corpus) {
      const ab = call(a, b);
      const ba = call(b, a);
      if (ab === undefined || ba === undefined) continue;
      if (Math.sign(ab) !== -Math.sign(ba)) {
        notOrder.push(
          `compareValues(${safeJson(a)}, ${safeJson(b)}) = ${ab} but the reverse = ${ba}`,
        );
      }
    }
  }
  // Transitivity is CUBIC, so it runs over a CAPPED corpus — and the cap takes
  // the DECLARER's own samples first. Slicing the merged corpus took a prefix of
  // `DEFAULT_SAMPLES` and dropped every supplied value, i.e. capped away exactly
  // the values a comparator has opinions about: measured, a deliberately CYCLIC
  // comparator over three supplied strings was reported as a perfect order. The
  // pairwise laws above are quadratic and run over everything.
  const declared = Array.isArray(impl?.samples) ? impl.samples.filter((v) => v !== null) : [];
  const triples = [...new Set([...declared, ...corpus])].slice(0, MAX_COMPARATOR_SAMPLES);
  for (const a of triples) {
    for (const b of triples) {
      const ab = call(a, b);
      if (ab === undefined || ab > 0) continue;
      for (const c of triples) {
        const bc = call(b, c);
        const ac = call(a, c);
        if (bc === undefined || ac === undefined || bc > 0) continue;
        if (ac > 0) {
          notOrder.push(
            `${safeJson(a)} ≤ ${safeJson(b)} ≤ ${safeJson(c)}, but compareValues(${safeJson(a)}, ${safeJson(c)}) = ${ac}`,
          );
        }
      }
    }
  }

  // ── The two facts a correct ORDER can still be wrong about ────────────────
  //
  // Both are WARNINGS and both are about a comparator that IS a total order and
  // still makes two of this package's roads disagree. Neither is detectable from
  // the declaration alone, and both are detectable from the declaration PLUS the
  // samples — which is exactly what this harness is.

  // A TEXT refinement's comparator covers the comparison arms and nothing else.
  // `comparisonCasing` suppresses its `LOWER()` fold for those arms (so `=` and
  // `<` agree across both roads), but `like` / `notLike` / `ilike`,
  // `text-search`, `text-score` and array-element containment are not comparator
  // roads at all — they fold per `casing`, which is the ENGINE default unless the
  // declaration narrows it. So one column answers two different case policies
  // depending on the operator.
  //
  // THE GATE IS `!== 'exact'`, SO IT ALSO FIRES ON A DECLARED `'fold'` OR
  // `'collated'`, and the message says which of the two it is looking at. Its
  // first version opened with "and no `options.casing`" and offered `'collated'`
  // as the second answer — both wrong, and the second actively so. MEASURED, on
  // a `text as Tag` holding `V1.2.3` against the predicate `tag = 'v1.2.3'`:
  //
  //     collated, NO comparator     run=[{"id":1}]  sql= "rel"."tag" = $1
  //     collated, WITH comparator   run=[]          sql= "rel"."tag" = $1
  //
  // `foldsInSql('collated')` is false, so the statement is identical either way
  // and a folding store matches the row; `foldsAtRuntime('collated')` is true,
  // but `compareToCase` skips the fold the moment a comparator is in effect. The
  // comparator therefore cancels the RUNTIME half of `'collated'` and nothing
  // cancels the STORE half — the exact run-vs-SQL divergence this whole
  // mechanism exists to close. `'exact'` is the only casing that can agree with
  // a comparator.
  const casing = refinement.declared.textCasing();
  if (refinement.base === 'text' && casing !== 'exact') {
    bad(
      'conformance.comparator-without-casing',
      `\`${refinement.name}\` is a \`text\` refinement with a \`compareValues\` and ` +
        `${casing === undefined ? 'no `options.casing`' : `\`options.casing: '${casing}'\``}. Its ` +
        'comparator governs `= <> < <= > >=` — and only those: the LIKE family, `text-search`, ' +
        '`text-score` and array-element containment fold per `casing`, which is the ' +
        `${casing === undefined ? "ENGINE's default (`'fold'` as shipped)" : `declared \`'${casing}'\``} ` +
        'while your comparator is whatever you wrote. One column then answers two case policies ' +
        "depending on the operator. Declare `options: { casing: 'exact' }`: it is the ONLY casing that " +
        'agrees with a comparator, and it makes the whole column one policy — the one your comparator ' +
        `already implements.${
          casing === 'collated'
            ? " `'collated'` is the one to move OFF, not a second answer: it claims the STORE folds, and" +
              ' a comparator stops the runtime folding (`Value.compareToCase` skips its fold when one is' +
              ' in effect) while the emitted SQL stays a bare `=` that the folding store still matches —' +
              ' measured, `engine.run` returned nothing, against a row the store this casing DECLARES to' +
              ' fold returns.'
            : ''
        } If the split is deliberate, drop the COMPARATOR rather than the casing — a type that wants ` +
        "this package's folding declares `casing` and no comparator.",
      'warning',
    );
  }

  // A comparator whose EQUALITY is coarser than raw-JSON identity splits this
  // package in half: the predicate roads ask the comparator, and `DISTINCT` /
  // `GROUP BY` / aggregate `DISTINCT` key on `JSON.stringify(raw)` (see
  // `queries/select.ts` `recordSignature`). Reported HERE because it is the one
  // form of the boundary that is statically visible: two samples the comparator
  // calls equal and `JSON.stringify` does not. A comparator that only REORDERS
  // (an `inet`, a semver) has identical equality and never trips this.
  //
  // Over the values the TYPE ADMITS, unlike every check above it. The order laws
  // run on the whole corpus because a comparator is genuinely reached with
  // whatever a row held; this one asks what happens to values that can actually
  // be STORED, and a comparator that stringifies quite properly calls `'a'` and
  // `['a']` equal — a pair no `text` column can hold, and a finding no declarer
  // can act on.
  const storable = corpus.filter((v) => refinement.declared.validValue(v));
  const merged: string[] = [];
  for (const [i, a] of storable.entries()) {
    for (const b of storable.slice(i + 1)) {
      if (safeJson(a) === safeJson(b)) continue;
      if (call(a, b) === 0) merged.push(`${safeJson(a)} and ${safeJson(b)}`);
    }
  }
  if (merged.length > 0) {
    bad(
      'conformance.comparator-coarser-than-identity',
      `\`compareValues\` calls values EQUAL that are not identical: ${merged.slice(0, 5).join('; ')}` +
        `${merged.length > 5 ? ' …' : ''}. That is legal and may be exactly what you meant, but this ` +
        'package only honours it on the roads that go through a comparison — `=`, `<>`, ordering, ' +
        '`BETWEEN`, `IN`, join and relation equality, `min` / `max`. `DISTINCT`, `GROUP BY` and an ' +
        "aggregate's `DISTINCT` key on the raw value's JSON, so they will keep those values APART while " +
        '`WHERE a = b` says they are the same — and a database whose column type agrees with your ' +
        'comparator will collapse them. `differentialCheck`\'s `distinct` / `group by` probes measure ' +
        'it against a real server.',
      'warning',
    );
  }

  if (threw.length > 0) {
    bad(
      'conformance.comparator-not-total',
      `\`compareValues\` did not ANSWER for every pair: ${threw.slice(0, 5).join('; ')}` +
        `${threw.length > 5 ? ' …' : ''}. It is reached from every sort, every comparison and every ` +
        '`min()` in the runtime, over whatever the row actually held — so it is asked about values that ' +
        'are not of your type, and it has to have an answer for them. Nothing catches a throw, and a ' +
        '`NaN` is read as "equal", which makes `=` true for values that are not, matches an `IN` member ' +
        'that should not match, pairs unrelated rows across a join, and leaves `min` / `max` on ' +
        'whichever candidate came first.',
    );
  }
  if (notOrder.length > 0) {
    bad(
      'conformance.comparator-not-an-order',
      `\`compareValues\` is not a total order: ${notOrder.slice(0, 5).join('; ')}` +
        `${notOrder.length > 5 ? ' …' : ''}. It must be reflexive, antisymmetric and transitive, because ` +
        'its answer goes straight to `Array.prototype.sort` — which is free to produce any permutation ' +
        'for a comparator that is not one, and does so without failing.',
    );
  }
  return problems;
}

/**
 * How many samples the CUBIC transitivity loop runs over (see
 * {@link checkComparator}). Twelve is `MAX_DESCRIBED_VALUES`' order of
 * magnitude and 1,728 triples, which is a check rather than a benchmark.
 */
const MAX_COMPARATOR_SAMPLES = 12;

// ─── One OPERATOR declaration, checked end to end ────────────────────────────

/** What {@link checkOperator} needs beyond the declaration. */
export interface OperatorCheckOptions {
  /**
   * The registry to register into. Supply one already carrying the field-type
   * REFINEMENTS the operands name — an operand typed `{kind:'json',
   * as:'Geometry'}` cannot compile on a registry with no `Geometry`, and
   * "register your types first" is a fact about the declaration rather than a
   * failure of it. Defaults to a bare {@link createRegistry}.
   */
  readonly registry?: Registry;
}

/** The verdict of {@link checkOperator}. */
export interface OperatorConformanceReport {
  /** True when nothing was found — what a consumer's test asserts. */
  readonly ok: boolean;
  /** Everything found, as `Problem`s: `error` blocks, `warning` is worth reading. */
  readonly problems: readonly Problem[];
  /**
   * The lattice verdict over the operand / output types, or `undefined` when the
   * declaration did not register at all. It should be identical to the verdict
   * WITHOUT the operator — see {@link checkOperator}.
   */
  readonly lattice: LatticeLawReport | undefined;
}

/**
 * Check ONE operator declaration — the counterpart of {@link checkFieldType},
 * and deliberately a different set of questions, because an operator is a
 * different kind of thing.
 *
 * A refinement is a LATTICE PARTICIPANT: it changes what every meet over its
 * base answers, so its check is a property over a set of types. An operator is a
 * LEAF: it declares operand types and emits SQL, and it changes nothing about
 * how any type behaves. So the laws it is held to are the ones only a set can
 * see FAIL — and the interesting assertion is that they still HOLD, i.e. that
 * registering an operator has not perturbed the lattice over the very types it
 * names. (`registerOperator` parses those types through the registry, which is
 * exactly the sort of thing that could freeze a vocabulary or share a compiled
 * refinement instance wrongly; the law set is what would notice.)
 *
 * Plus the three things a REGISTRATION cannot check, each with a real failure
 * behind it:
 *
 *  1. **Every declared dialect is REGISTERED here.** `emit: { postgress: … }` is
 *     a legal declaration — `emit` is keyed by an arbitrary string, and it has
 *     to be, since a dialect may be registered after the operator. So a typo
 *     produces an operator that registers cleanly, describes itself normally,
 *     and is REFUSED at emit on every dialect that exists. Reported as an error,
 *     because there is no reading of it that is intended.
 *  2. **Every `examples` string parses, and is an example OF THIS OPERATOR.** An
 *     example is raw JSON round-tripped verbatim into a prompt, so a malformed
 *     one teaches a model malformed syntax — the most expensive kind of wrong,
 *     since the model will reproduce it and then fail validation.
 *  3. **Every example's `args` name the DECLARED operands.** The structural
 *     parser accepts any record of exprs (the operand check is validation's job,
 *     and an example has no query around it to validate), so this is the only
 *     place a shipped example's operand names are compared with the declaration.
 */
export function checkOperator(
  decl: OperatorDef,
  opts?: OperatorCheckOptions,
): OperatorConformanceReport {
  const problems: Problem[] = [];
  const registry = opts?.registry ?? createRegistry();
  try {
    registry.registerOperator(decl);
  } catch (err) {
    problems.push(asProblem(err, ['registerOperator'], 'conformance.registration'));
    return { ok: false, problems, lattice: undefined };
  }
  const operator = registry.operator(decl.name);
  /* v8 ignore next -- registration just succeeded, so the operator is there */
  if (!operator) return { ok: false, problems, lattice: undefined };

  const dialects = registry.dialectList().map((d) => d.NAME);
  for (const declared of operator.dialects()) {
    if (dialects.includes(declared)) continue;
    problems.push({
      path: ['checkOperator', decl.name, 'emit', declared],
      code: 'conformance.unknown-dialect',
      severity: 'error',
      message:
        `\`emit\` declares SQL for dialect \`${declared}\`, which is not registered on this registry ` +
        `(registered: ${dialects.length > 0 ? dialects.join(', ') : 'none'}). A dialect key is an ` +
        'arbitrary string — it has to be, since a dialect may be registered after an operator — so a ' +
        `typo here produces an operator that registers cleanly and is REFUSED at emit everywhere.`,
    });
  }

  const operandNames = operator.operands.map((o) => o.name);
  for (const [index, example] of (decl.examples ?? []).entries()) {
    problems.push(...checkOperatorExample(decl.name, index, example, operandNames, registry));
  }
  problems.push(...checkOperatorShadowsRefusal(operator));
  problems.push(...checkOperandCastsAreWritable(operator, dialects));

  // The operand / output types, plus every unrefined top, so the laws run over a
  // set in which the operator's own types actually participate.
  const types: Record<string, FieldType> = {};
  for (const operand of operator.operands) {
    if (operand.fieldType) types[`${decl.name}.${operand.name}`] = operand.fieldType;
  }
  types[`${decl.name}.output`] = operator.output;
  const tops = topsByKind();
  for (const base of REFINABLE_BASES) {
    const top = tops[base];
    if (top) types[`⊤${base}`] = top;
  }
  const lattice = checkLatticeLaws(types, { registry });
  for (const failure of lattice.failed) {
    problems.push({
      path: ['checkOperator', decl.name, failure.law],
      code: `conformance.${failure.law}`,
      severity: 'error',
      message:
        `The meet is not ${failure.law} over the types \`${decl.name}\` names. An operator changes nothing ` +
        'about how a type meets, so this failure belongs to one of those TYPES rather than to the ' +
        `operator — run \`checkFieldType\` on it. It states: ${failure.states}. ` +
        `${failure.violations.length} counterexample(s): ${failure.violations.slice(0, 5).join('; ')}` +
        `${failure.violations.length > 5 ? ' …' : ''}`,
    });
  }
  return { ok: problems.length === 0, problems, lattice };
}

/**
 * WARN when an operand's declared type carries a `cast` this operand can never
 * resolve — the emit-time `cast.unwritten-option` refusal, discovered at the
 * DECLARATION instead of at the first query that binds a document.
 *
 * WHY IT IS HERE AND NOT AT `registerOperator`, which is where the rest of an
 * operator's checks live. The question is per DIALECT — a cast interpolating
 * `{srid}` matters only on the dialect that declares it — and a dialect may be
 * registered after an operator (`defineDialect` is public and order-free), so
 * asking it at registration would order-couple the two exactly as refusing an
 * unknown `emit` key would. It is the same boundary, drawn the same way:
 * everything an operator can be judged on ALONE is refused at its declaration,
 * and everything that needs a FINISHED registry is a conformance check.
 *
 * A WARNING rather than an error, because the refusal it predicts fires only for
 * a DOCUMENT operand — a `literal`, or a param bound to one. An operand that is
 * only ever handed a column emits fine forever, and that is a legitimate
 * operator. What is not legitimate is finding out from a query.
 */
function checkOperandCastsAreWritable(operator: QueryOperator, dialects: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  for (const operand of operator.operands) {
    for (const dialect of dialects) {
      // Every type a document binds THROUGH — the operand's own, and an array
      // element's, because a native-array dialect re-enters the cast road per
      // element (see `Dialect.builtinJsonValue`).
      for (const target of castTargetsOf(operand.fieldType)) {
        const unwritten = target.uncastableOptions(dialect);
        if (unwritten.length === 0) continue;
        problems.push({
          path: ['checkOperator', operator.name, 'operands', operand.name],
          code: 'conformance.unwritable-operand-cast',
          severity: 'warning',
          message:
            `Operand \`${operand.name}\` is typed \`${target.as}\`, whose \`${dialect}\` cast interpolates ` +
            `${unwritten.map((o) => `\`{${o}}\``).join(', ')} — and the operand writes no value for ` +
            `${unwritten.length === 1 ? 'it' : 'them'}. A document bound here is REFUSED at emit ` +
            '(`cast.unwritten-option`), because resolving those slots from the type\'s DEFAULTS would ' +
            'pin a constraint on the value that nothing required it to satisfy. A column operand is ' +
            `unaffected. Either give \`${operand.name}\` a \`with\` bag naming them, or move the ` +
            `per-column part of \`${target.as}\`'s \`cast\` into its \`sql\` (the cast TARGET), leaving a ` +
            'cast that interpolates no option and is therefore position-independent.',
        });
      }
    }
  }
  return problems;
}

/**
 * Every type a bound DOCUMENT can travel through for `ft` — itself, and an
 * array's element type, recursively.
 *
 * The cast counterpart of {@link refinementsOf}, and separate from it because
 * the two answer different questions: that one asks which REFINEMENTS an operand
 * names (for the arm-shadow warning), this one asks which types a VALUE is cast
 * by (which is every level a `Dialect.jsonValue` recursion reaches).
 */
function castTargetsOf(ft: FieldType | undefined): FieldType[] {
  if (!ft) return [];
  // Recursion through the type's own `itemType()` rather than a narrowing to
  // `ArrayFieldType`: this module is also the one that ships as
  // `@aeye/query/conformance`, and two copies of a class make `instanceof` false
  // across them (the measurement in `index.ts`).
  const item = ft.itemType();
  return item ? [ft, ...castTargetsOf(item)] : [ft];
}

/**
 * WARN when an operator's NAME spells a builtin comparison token over an operand
 * whose registered type REFUSES that arm.
 *
 * It is not an error, and deliberately not refused: an operator declares its own
 * meaning, and `=` over a geometry could legitimately be a declarer's
 * exactly-equal-bytes predicate that the builtin `=` (whose semantics this
 * package does not own for that type) has no business claiming. Declaring it is
 * the author's prerogative.
 *
 * What is NOT the author's prerogative is leaving a model to resolve the
 * contradiction unaided. `describeTypes` prints `no =` on the column while
 * `describeOperators` offers a `=` over it IN THE SAME CATALOG, and nothing in
 * either block says which wins. So the declarer is told, once, at the place they
 * can act on it — the `instructions` are the only channel that reaches the model,
 * and this is the check that says to use them.
 */
function checkOperatorShadowsRefusal(operator: QueryOperator): Problem[] {
  const arm = ARM_OF_TOKEN.get(operator.name);
  if (arm === undefined) return [];
  const problems: Problem[] = [];
  for (const operand of operator.operands) {
    for (const refinement of refinementsOf(operand.fieldType)) {
      if (refinement.compare[arm]) continue;
      problems.push({
        path: ['checkOperator', operator.name, 'operands', operand.name],
        code: 'conformance.shadows-refused-arm',
        severity: 'warning',
        message:
          `\`${operator.name}\` is spelled like a builtin \`${arm}\` operator, and its operand ` +
          `\`${operand.name}\` is a \`${refinement.name}\`, which declares \`compare.${arm}: false\`. ` +
          'Both facts reach the model in ONE catalog — the type block prints the refusal, the operators ' +
          'block offers the operator — and nothing there says which wins. This is allowed (an operator ' +
          `declares its own meaning), but say in \`${operator.name}\`'s \`instructions\` how it differs ` +
          `from the builtin the type refuses, or the model has to guess.`,
      });
    }
  }
  return problems;
}

/**
 * The PUNCTUATION spellings of the LIKE family, which `ComparisonOp` names as
 * words (`like` / `notLike` / `ilike`) and no operator name may therefore use.
 *
 * These are PostgreSQL's own operator forms for exactly those predicates, and
 * they are legal operator names — so `~~` over a type declaring
 * `textMatch: false` is the realistic textMatch shadow, and the one the arm's
 * rendering glyph could never have caught. Listed rather than derived because
 * there is nothing to derive them from: they are a dialect's spelling of a
 * predicate this package names differently.
 */
const TEXT_MATCH_TOKENS: readonly string[] = ['~~', '~~*', '!~~', '!~~*'];

/**
 * SQL TOKEN → the {@link FieldTypeCompareDecl} arm it belongs to — the
 * MEMBERSHIP relation {@link checkOperatorShadowsRefusal} tests against, as
 * distinct from `COMPARE_ARM_OPERATORS`, which is a RENDERING vocabulary.
 *
 * The distinction is the whole reason this exists. `COMPARE_ARM_OPERATORS` holds
 * ONE representative glyph per arm, "as a model would write it" — so asking it
 * for membership warned on `=` and not on `<>`, on `<` and not on `<=` / `>` /
 * `>=`, and its `textMatch` entry is the WORD `LIKE`, which
 * `OPERATOR_NAME_PATTERN` refuses outright: that branch could never fire at all.
 *
 * Derived from `OP_ARMS`, the package's only op→arm mapping and a total `Record`
 * over `ComparisonOp`, so a tenth comparison operator lands here automatically.
 * Its three WORD ops (`like` / `notLike` / `ilike`) are unspellable as operator
 * names and simply never match; {@link TEXT_MATCH_TOKENS} adds the punctuation
 * spellings an engine actually accepts for them, which is where a real textMatch
 * shadow comes from.
 */
const ARM_OF_TOKEN: ReadonlyMap<string, keyof FieldTypeCompareDecl> = new Map([
  ...opArmEntries(),
  ...TEXT_MATCH_TOKENS.map((token): [string, keyof FieldTypeCompareDecl] => [token, 'textMatch']),
]);

/**
 * `OP_ARMS` as typed entries — the ONE place this module asserts what
 * `Object.entries` cannot infer.
 *
 * `Object.entries` widens a `Record`'s key to `string` unconditionally, so
 * there is no cast-free spelling that keeps `OP_ARMS` as the single op→arm
 * source; the alternative is a hand-written list of the nine operators beside
 * it, which is the duplicated key set `OP_ARMS`' own docs exist to prevent. It
 * is written ONCE and shared by the two consumers ({@link ARM_OF_TOKEN} and
 * {@link differentialCheck}) rather than spelled at each — a second copy is how
 * an assertion outlives the fact it asserted.
 */
function opArmEntries(): [ComparisonOp, keyof FieldTypeCompareDecl][] {
  return Object.entries(OP_ARMS) as [ComparisonOp, keyof FieldTypeCompareDecl][];
}

/**
 * Every registered refinement reachable from `ft` — itself, and an ARRAY's
 * element type.
 *
 * A container carries no refinement of its own while its ITEM may carry one, so
 * an `array<json as Geometry>` operand named `=` answered "no refinement" and
 * warned about nothing. One level is enough for the question being asked (does
 * this operand's declared type refuse the arm this name spells), and `item`
 * recursion covers the nested case for free.
 */
function refinementsOf(ft: FieldType | undefined): FieldTypeRefinement[] {
  if (!ft) return [];
  const own = ft.refinement ? [ft.refinement] : [];
  const item = ft.itemType();
  return item ? [...own, ...refinementsOf(item)] : own;
}

/** One shipped `examples` entry, parsed and matched against the declaration. */
function checkOperatorExample(
  name: string,
  index: number,
  example: string,
  operandNames: readonly string[],
  registry: Registry,
): Problem[] {
  const path = ['checkOperator', name, 'examples', index];
  const bad = (code: string, message: string): Problem[] => [{ path, code, severity: 'error', message }];
  let parsed: unknown;
  try {
    parsed = JSON.parse(example);
  } catch (err) {
    return bad(
      'conformance.bad-example',
      `Example ${index} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Examples ` +
        'are round-tripped VERBATIM into a prompt, so a malformed one teaches a model malformed syntax.',
    );
  }
  const problems = new Problems();
  const expr = registry.parseCheckedExpr(parsed, problems);
  if (!expr || problems.hasErrors) {
    return bad(
      'conformance.bad-example',
      `Example ${index} does not parse as an expression: ` +
        `${problems.list.map((p) => `${p.code}: ${p.message}`).join('; ')}`,
    );
  }
  if (!(expr instanceof OperatorExpr) || expr.op !== name) {
    return bad(
      'conformance.bad-example',
      `Example ${index} is not a use of \`${name}\` — an operator's examples are what a model copies, so ` +
        'one that demonstrates something else is worse than none.',
    );
  }
  const supplied = [...expr.args.keys()].sort();
  const declared = [...operandNames].sort();
  if (JSON.stringify(supplied) !== JSON.stringify(declared)) {
    return bad(
      'conformance.bad-example',
      `Example ${index} supplies operands ${supplied.join(', ') || '(none)'} but \`${name}\` declares ` +
        `${declared.join(', ')}. The structural parser accepts any \`args\` record — the operand names are ` +
        'checked by validation, which an example has no query around it to reach — so this is the only ' +
        'place a shipped example can be held to the declaration.',
    );
  }
  return [];
}

/**
 * The two cross-library facts about a supplied `value` gate: that it AGREES with
 * the declared base bucket, and that it is not VACUOUS.
 *
 * Both exist because the gate is the one half of a shared type that cannot ride
 * the wire — it is code, so it is neither persisted nor shown to a model, and
 * nothing downstream can check it. Agreement is the interesting one: a gate
 * accepting a value the BASE kind cannot hold means the column's declared bucket
 * and its declared contract disagree, and the bucket is what decides the SQL
 * type, the comparability and the cost. Vacuity is the cheap one and it is
 * measured rather than assumed: an unresolved alias degrading to `z.any()` is
 * silent, and a gate that refuses nothing is a gate in name only.
 */
function checkValueGate(
  decl: FieldTypeRefinementDef,
  registry: Registry,
  impl: FieldTypeCheckImpl | undefined,
  samples: readonly JsonValue[],
): Problem[] {
  const gate = impl?.value;
  if (!gate) return [];
  const problems: Problem[] = [];
  const bare = registry.parseFieldType(defOf(decl.base));
  // EVERY call here is consumer code. `gate.safeParse` runs a `.refine()` body,
  // and the documented shape for a struct-valued refinement —
  // `z.string().refine(s => JSON.parse(s).type === 'Point')` — throws on `'a'`,
  // the first member of `DEFAULT_SAMPLES`. So the first thing a geometry
  // declarer did crashed the harness. A sample the gate could not judge is
  // counted as REFUSED, which is conservative in both directions: it cannot
  // manufacture a base-disagreement, and it cannot hide a vacuous gate.
  const failures: string[] = [];
  const guarded = (what: string, fn: () => boolean): boolean => {
    try {
      return fn();
    } catch (err) {
      const line = `${what}: ${err instanceof Error ? err.message : String(err)}`;
      if (!failures.includes(line)) failures.push(line);
      return false;
    }
  };
  const admitted = samples.filter((v) => guarded('value gate', () => gate.safeParse(v).success));
  const outside = admitted.filter((v) => !guarded('base validValue', () => bare.validValue(v)));
  if (failures.length > 0) {
    problems.push({
      path: ['checkFieldType', decl.name, 'value'],
      code: 'conformance.gate-throws',
      severity: 'error',
      message:
        `The \`value\` gate THREW on a sample rather than refusing it: ${failures.join('; ')}. A gate is ` +
        'asked about values that are not of your type — that is what makes it a gate — so it has to ' +
        'ANSWER for them. A `.refine()` body that parses its input needs a guard, or a `z.string()` ' +
        'in front of it. Every sample it threw on was counted as refused, so the checks below ran on ' +
        'what is left.',
    });
  }
  if (outside.length > 0) {
    problems.push({
      path: ['checkFieldType', decl.name, 'value'],
      code: 'conformance.gate-disagrees-with-base',
      severity: 'error',
      message:
        `The \`value\` gate accepts ${outside.map((v) => safeJson(v)).join(', ')}, which a bare ` +
        `\`${decl.base}\` refuses. A refinement's gate is applied in CONJUNCTION with the base's, so a ` +
        'value only it accepts can never reach a column — and the disagreement means the declared bucket ' +
        'and the declared contract describe different types.',
    });
  }
  if (admitted.length === samples.length) {
    problems.push({
      path: ['checkFieldType', decl.name, 'value'],
      code: 'conformance.gate-vacuous',
      severity: 'warning',
      message:
        `The \`value\` gate accepts every one of the ${samples.length} sample values, including ` +
        `${safeJson(samples[0])}. A gate that refuses nothing is the shape an unresolved schema ` +
        'degrades to, and it degrades SILENTLY. Pass `samples` holding values of your type and values ' +
        'that are nearly it, or check that the gate is the one you meant.',
    });
  }
  return problems;
}

/**
 * The values a declared option can take, for building one column per value: the
 * members of its closed set when it has one, else just its default.
 *
 * Capped, because the set is a cross-product input — the lattice loops are cubic
 * in the number of types, so a fifty-member option would turn a conformance
 * check into a benchmark. Three members exercise every arm the flat lattice has
 * (same, different, and a third to make associativity non-trivial).
 */
function optionValues(type: FieldType, fallback: JsonValue | undefined): JsonValue[] {
  const values = type.values();
  if (values && values.length > 0) return values.slice(0, MAX_OPTION_VALUES).map((v) => v.value);
  if (fallback === undefined) return [];
  // A LEGAL NEIGHBOUR beside the default, so the flat lattice's "two different
  // values conflict" arm is actually exercised. Returning only the default built
  // a set in which every column agreed on every open option — so for
  // `srid: { type: {kind:'number', whole:true}, default: 4326 }`, the shape every
  // worked example uses, the one arm that can go wrong was never reached.
  // Filtered through the option's own type so a neighbour that is not a legal
  // value of it is dropped rather than turned into a spurious failure.
  return [fallback, ...neighboursOf(fallback).filter((v) => type.validValue(v))];
}

/**
 * One or two values NEAR `value` — a different member of the same category, for
 * exercising a single-valued option's conflict arm (see {@link optionValues}).
 * Deliberately tiny: the lattice loops are cubic in the number of types.
 */
function neighboursOf(value: JsonValue): JsonValue[] {
  if (typeof value === 'number') return [value + 1];
  if (typeof value === 'boolean') return [!value];
  if (typeof value === 'string') return [`${value}_x`];
  return [];
}

/** How many members of a closed option set the check builds a column for (see {@link optionValues}). */
const MAX_OPTION_VALUES = 3;

/**
 * `value` as JSON for a message, or a placeholder — `JSON.stringify` throws on a
 * cyclic sample, and a report that crashes while EXPLAINING a defect is the same
 * failure the `total` law exists to prevent, one layer out.
 */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '<unrenderable>';
  }
}

/**
 * `text`, or `text as IpAddress` — a field type named the way a report has to
 * name it when it is asking whether TWO of them are the same.
 *
 * `toCode()` alone renders the BASE, so two columns of different registered
 * types over one base both read `text` and the reader is told to compare two
 * identical strings. The `as` is the whole distinction there.
 */
function typeTag(ft: FieldType): string {
  return ft.as === undefined ? ft.toCode() : `${ft.toCode()} as ${ft.as}`;
}

/** A thrown `QueryTypeError` as its own `Problem`; anything else as a conformance one. */
function asProblem(err: unknown, path: (string | number)[], code: string): Problem {
  if (err instanceof QueryTypeError) return err.problem;
  return { path, code, severity: 'error', message: err instanceof Error ? err.message : String(err) };
}

/** Every kind a refinement may narrow — re-exported so a caller can loop the same set the checks do. */
export { REFINABLE_BASES, SCALAR_KINDS };

// ─── run-vs-SQL divergence: the one thing nothing static can check ───────────

/**
 * One row a live database handed back — a column-name → value map, which is what
 * every driver this could be wired to already produces (`pg`'s `result.rows`,
 * `mysql2`'s, `better-sqlite3`'s `.all()`).
 *
 * THE VALUES ARE `unknown`, DELIBERATELY, and this is the harness's second
 * unverifiable premise after "the same rows". A driver decides what a column
 * DESERIALISES to, and the defaults are not this package's JSON model: `pg`
 * hands back a `Date` for `timestamptz`, a STRING for `numeric` and `bigint`
 * (precision it will not silently lose), and a `Buffer` for `bytea`. Typed as
 * `JsonValue` this compiled only because `pg` types its rows as `any` — and a
 * DRIVER ARTIFACT filed as a divergence of the type is the most expensive kind
 * of false positive a harness can produce.
 *
 * WHICH ARTIFACTS ACTUALLY REACH THE COMPARISON, measured, because the obvious
 * example is not one of them. {@link canonical} renders both sides through
 * `JSON.stringify`, and `JSON.stringify(new Date(iso))` is byte-identical to
 * `JSON.stringify(iso)` — so a `timestamptz` `Date` beside `engine.run`'s ISO
 * string AGREES (`order asc` / `distinct` / `group by` all `agreed=true` with a
 * real `Date` on the driver side). The two that DO fire are the ones whose
 * rendering differs: a `numeric` arrives as `"1.5"` against a run-side `1.5`,
 * and a `bytea` as `{"type":"Buffer","data":[…]}` against a string. Both
 * disagree on every probe.
 *
 * So the remedy is the caller's and it is one line at their end, not a
 * normalisation this package could guess: register the type parsers that match
 * your model (`pg.types.setTypeParser(1700, Number)` for a numeric), or project
 * a text form in the column you point `columns.field` at. A first run against a
 * `numeric` column will say so loudly, which is the point of leaving it visible
 * rather than coercing.
 */
export type DifferentialRow = Readonly<Record<string, unknown>>;

/**
 * How {@link differentialCheck} reaches the live database: the emitted statement
 * and its positional params in, its rows out.
 *
 * ```ts
 * execute: async (sql, params) => (await pool.query(sql, [...params])).rows
 * ```
 *
 * It is a CALLBACK rather than a driver dependency for the reason every seam in
 * this package is: the package has no database client, must not acquire one, and
 * a consumer's pool already carries their connection, their search path and
 * their transaction.
 */
export type DifferentialExecute = (
  sql: string,
  params: readonly SqlValue[],
) => Promise<readonly DifferentialRow[]>;

/** Which COLUMNS {@link differentialCheck} drives its probes from. */
export interface DifferentialColumns {
  /** A registered Type name — and a real table of that name in the database. */
  readonly type: string;
  /** A field of `type` whose declared field type is the one under test. */
  readonly field: string;
  /**
   * A SECOND field of the same type, for the probes that need two operands — the
   * comparison arms, and every operator / function of arity ≥ 2.
   *
   * Optional, and its absence is REPORTED rather than silently narrowing the run:
   * a check that quietly skipped most of what it was asked to do would be worse
   * than one that did not run. THE SAME FIELD TYPE is not decoration either: one
   * of a different kind makes every arm illegal, which used to read as `ok: true`
   * with nothing compared and is now `conformance.differential-no-arms`.
   */
  readonly other?: string;
}

/** What {@link differentialCheck} needs. */
export interface DifferentialCheckOptions {
  /**
   * The engine to drive BOTH roads from — its registry carrying the declaration
   * under test, and its executor for {@link DifferentialColumns.type} holding
   * THE SAME ROWS the database's table holds.
   *
   * That last part is the harness's one unverifiable premise, and it is stated
   * rather than checked because nothing here can check it: if the two row sets
   * differ, every probe disagrees and the report blames the type. Point the
   * executor at the same fixture the table was seeded from.
   */
  readonly engine: QueryEngine;
  /** The dialect to emit for — a name registered on the engine's registry. */
  readonly dialect: string;
  /** The live database (see {@link DifferentialExecute}). */
  readonly execute: DifferentialExecute;
  /** The columns to drive the probes from. */
  readonly columns: DifferentialColumns;
  /** Registered OPERATOR names to exercise over those columns. Default: none. */
  readonly operators?: readonly string[];
  /** Registered scalar FUNCTION names to exercise over those columns. Default: none. */
  readonly functions?: readonly string[];
}

/**
 * HOW a probe's two answers are compared, which is a property of the probe
 * rather than a global.
 *
 *  - `'sequence'` — position by position. The ORDER probes, where the SEQUENCE
 *    is the whole property under test.
 *  - `'multiset'` — both sides sorted canonically first. Everything else, where
 *    the VALUES are the property and the `ORDER BY` is there only to give the
 *    statement a deterministic plan. A `valueProbe` projects an expression and
 *    orders by the driving FIELD, so two rows with equal driving values may come
 *    back in either order — positionally that is a disagreement, and it is not
 *    one. Comparing the multiset removes the "your driving column must be
 *    unique" precondition instead of documenting it.
 */
export type DifferentialComparison = 'sequence' | 'multiset';

/** One probe: the statement, both roads' answers, and whether they agreed. */
export interface DifferentialProbe {
  /** What this probe exercises — `order asc`, `field < other`, `&&`, `ST_Contains`. */
  readonly label: string;
  /** The statement that was emitted and executed. */
  readonly sql: string;
  /** The values `engine.run` produced, in row order. */
  readonly runValues: readonly JsonValue[];
  /**
   * The values the database produced, in row order — `unknown`, because that is
   * what a driver hands back (see {@link DifferentialRow}).
   */
  readonly sqlValues: readonly unknown[];
  /** How the two were compared (see {@link DifferentialComparison}). */
  readonly comparison: DifferentialComparison;
  /** Whether the two agreed. */
  readonly agreed: boolean;
}

/** The verdict of {@link differentialCheck}. */
export interface DifferentialReport {
  /**
   * True when NOTHING was found — every probe ran, every probe agreed, and
   * nothing the CALLER asked for was skipped. Arms this package's own validation
   * refuses do not count against it (they are in {@link unprobeable} instead):
   * a `json` type cannot be `LIKE`d, and reporting that as a finding would make
   * `ok` false for a correct declaration on its first run.
   */
  readonly ok: boolean;
  /** Everything found: a disagreement or a throw is an `error`, a skip a `warning`. */
  readonly problems: readonly Problem[];
  /** Every probe that ran, agreed or not — the record a consumer diffs across releases. */
  readonly probes: readonly DifferentialProbe[];
  /**
   * Probes that were NOT emitted because `engine.validateQuery` refuses them,
   * each with the codes it refused for — the harness's blind spots, named.
   *
   * It exists because the alternative is invisible. The arm loop enumerates all
   * nine comparison operators, and several are illegal for any given type for
   * reasons a `compare` declaration does not state (`like` over a `json` column
   * is `comparison.like`, not `compare.textMatch`). Emitting them anyway sends
   * statements this package calls invalid to a real server and files each
   * refusal as a divergence — three red herrings on a correct declaration's
   * first run, which is the failure the arm skip claims to prevent.
   */
  readonly unprobeable: readonly DifferentialSkip[];
}

/** One probe `engine.validateQuery` refused, and why (see {@link DifferentialReport.unprobeable}). */
export interface DifferentialSkip {
  /** The probe's label. */
  readonly label: string;
  /** The problem codes validation reported, in walk order. */
  readonly codes: readonly string[];
}

/**
 * Run every probe BOTH WAYS — `engine.run` and the live database — and report
 * where they disagreed. The one failure mode neither registration nor
 * {@link checkFieldType} can detect, and the reason it needs a connection.
 *
 * WHAT IT IS FOR. A registered type has two halves that must answer the same
 * question the same way: its SQL half (`sql` / `cast`, per dialect) and its
 * in-memory half (`FieldTypeImpl.compareValues`). Nothing static relates them —
 * this package cannot read a column's collation, cannot know what a PostGIS
 * `&&` returns, and cannot know that `inet` orders by address while a string
 * orders lexicographically. A declaration whose two halves disagree produces
 * TWO ANSWERS FOR ONE QUERY, silently, and which one a caller gets depends only
 * on whether they ran it or emitted it.
 *
 * WHERE IT BELONGS. A consumer's INTEGRATION suite, not their unit tests — it is
 * this package's `integration/run.ts` shape: a real connection, real fixtures,
 * and deliberately outside `npm test`. It is exported from
 * `@aeye/query/conformance` beside {@link checkFieldType} and
 * {@link checkOperator} because it answers the same question they do, one level
 * further out; nothing in this package's own suite calls it against a database.
 *
 * ```ts
 * const report = await differentialCheck({
 *   engine, dialect: 'postgres',
 *   execute: async (sql, params) => (await pool.query(sql, [...params])).rows,
 *   columns: { type: 'parcel', field: 'shape', other: 'nextShape' },
 *   operators: ['&&'], functions: ['ST_Distance'],
 * });
 * expect(report.problems).toEqual([]);
 * ```
 *
 * EVERY PROBE IS DRIVEN FROM COLUMNS, never from a bound sample, and that is a
 * deliberate boundary rather than a simplification. A bound VALUE reaches a
 * declared `cast` only in a write cell or a registered operator's operand
 * (`exprs/_bound-value.ts`); everywhere else it binds through the dialect's
 * default, which is a KNOWN and documented limit. Probing with samples would
 * therefore report that limit — the same disagreement, for every type, on every
 * run — and bury the divergence the harness exists to find. Seed the values you
 * care about into the table instead: they are then columns, and every road types
 * them.
 */
export async function differentialCheck(opts: DifferentialCheckOptions): Promise<DifferentialReport> {
  const { engine, dialect, execute, columns } = opts;
  const problems: Problem[] = [];
  const probes: DifferentialProbe[] = [];
  const unprobeable: DifferentialSkip[] = [];
  const path = ['differentialCheck', columns.type, columns.field];
  const verdict = (ok: boolean): DifferentialReport => ({ ok, problems, probes, unprobeable });

  const type = engine.registry.type(columns.type);
  const field = type?.field(columns.field);
  if (!type || !field) {
    problems.push({
      path,
      code: 'conformance.differential-unknown-column',
      severity: 'error',
      message:
        `\`columns\` names ${type ? `field '${columns.field}' of` : 'Type'} '${columns.type}', which this ` +
        'engine does not have. Every probe reads a real column, so there is nothing to compare.',
    });
    return verdict(false);
  }

  /**
   * Run one probe both ways — after asking THIS PACKAGE whether the statement is
   * legal at all.
   *
   * The validation gate is the whole reason `probe` is a closure rather than a
   * loop body. Neither `toSQL` nor `run` validates, so without it the harness
   * emits statements the package itself refuses, sends them to a real server,
   * and files each server refusal as a divergence "of the strongest kind" —
   * measured on the flagship shape, three of those on the first run of a
   * perfectly correct `json` declaration, because the arm loop enumerates
   * `like` / `notLike` / `ilike` and `comparison.like` needs a text operand.
   * Asking `validateQuery` uses the package's own authority and covers every
   * gate it grows, rather than the one gate a loop happened to know about.
   *
   * `whenRefused` says whose problem a refusal is. An ARM is enumerated by this
   * harness, so an arm the package refuses is a probe that does not EXIST for
   * this type — recorded in `unprobeable` and nothing more, or `ok` would be
   * false for every correct declaration. An operator, a function or the ordering
   * probe is asked for by the CALLER, so a refusal there is something they need
   * told.
   */
  const probe = async (
    label: string,
    def: SelectDef,
    comparison: DifferentialComparison,
    whenRefused: 'note' | 'warn' = 'warn',
  ): Promise<void> => {
    let sql: string;
    let params: readonly SqlValue[];
    let runValues: JsonValue[];
    try {
      const refused = engine.validateQuery(def);
      if (refused.hasErrors) {
        const codes = refused.list.filter((p) => p.severity === 'error').map((p) => p.code);
        unprobeable.push({ label, codes });
        if (whenRefused === 'warn') {
          problems.push({
            path: [...path, label],
            code: 'conformance.differential-unprobeable',
            severity: 'warning',
            message:
              `\`${label}\` is refused by this package's own validation (${codes.join(', ')}), so it was ` +
              'not emitted. A statement the library calls invalid tells you nothing about your type — ' +
              'the server would refuse it for its own reasons and the report would blame the ' +
              'declaration. Fix the probe (a different column, an operand of the right shape) or drop ' +
              'it from what you asked for.',
          });
        }
        return;
      }
      const emitted = engine.toSQL(def, dialect);
      sql = emitted.sql;
      params = emitted.params;
      runValues = probeValues((await engine.run(def)).rows);
    } catch (err) {
      problems.push(asProblem(err, [...path, label], 'conformance.differential-threw'));
      return;
    }
    let sqlValues: unknown[];
    try {
      sqlValues = probeValues(await execute(sql, params));
    } catch (err) {
      problems.push({
        path: [...path, label],
        code: 'conformance.differential-threw',
        severity: 'error',
        message:
          `The database REFUSED the emitted statement for \`${label}\`: ` +
          `${err instanceof Error ? err.message : String(err)}. SQL: ${sql}. That is a divergence too — ` +
          'the strongest kind, since the in-memory road answered and the emitted one could not run.',
      });
      return;
    }
    const agreed = canonical(runValues, comparison) === canonical(sqlValues, comparison);
    probes.push({ label, sql, runValues, sqlValues, comparison, agreed });
    if (agreed) return;
    problems.push({
      path: [...path, label],
      code: 'conformance.differential-disagreement',
      severity: 'error',
      message:
        `\`${label}\` answers differently in memory and at the database. \`engine.run\` gave ` +
        `${safeJson(runValues)}; \`${dialect}\` gave ${safeJson(sqlValues)}. SQL: ${sql}. One query, two ` +
        "answers: reconcile the type's SQL half (`sql` / `cast`) with its in-memory half " +
        "(`registerFieldTypeImpl`'s `compareValues`) — whichever of the two is not what you meant. If " +
        'the two look the same, check what your driver deserialises this column to (see ' +
        '`DifferentialRow`): a `numeric` arrives as the string "1.5" and a `bytea` as a `Buffer`, ' +
        'neither of which renders as what `engine.run` produced.',
    });
  };

  // ORDERING FIRST, because it is the property `compareValues` exists for and
  // the one that needs no second column. BOTH directions: a comparator that is
  // not antisymmetric can agree ascending and disagree descending.
  for (const dir of ['asc', 'desc'] as const) {
    await probe(`order ${dir}`, orderProbe(columns.type, columns.field, dir), 'sequence');
  }
  // DISTINCT and GROUP BY, which are the roads a comparator is NOT wired into:
  // they key on the raw value's JSON (`queries/select.ts` `recordSignature`),
  // while every predicate road asks the comparator. For a comparator that only
  // REORDERS the two agree and these cost two statements; for one whose equality
  // is COARSER than raw identity they are the divergence, and it is the one the
  // rest of this harness could not see. `checkFieldType` warns about the same
  // fact statically (`conformance.comparator-coarser-than-identity`) — this is
  // what settles it against a real column type.
  await probe('distinct', distinctProbe(columns.type, columns.field), 'multiset');
  await probe('group by', groupProbe(columns.type, columns.field), 'multiset');

  const other = columns.other;
  if (other === undefined) {
    problems.push({
      path,
      code: 'conformance.differential-skipped',
      severity: 'warning',
      message:
        'No `columns.other` was supplied, so only the single-column probes ran — every comparison arm ' +
        'and every operator / function of arity ≥ 2 needs a second operand, and it has to be a COLUMN ' +
        '(a bound sample would measure the known value-binding limit instead of your type). Declare a ' +
        `second field of the same type on '${columns.type}' and name it here.`,
    });
    return verdict(problems.length === 0);
  }
  const otherField = type.field(other);
  if (!otherField) {
    problems.push({
      path,
      code: 'conformance.differential-unknown-column',
      severity: 'error',
      message: `\`columns.other\` names field '${other}', which Type '${columns.type}' does not have.`,
    });
    return verdict(false);
  }

  // The comparison arms, filtered twice and for two different reasons. The
  // `compare` DECLARATION is the consumer's own statement that an arm is
  // meaningless for their type, so skipping it is silent — they said so. Every
  // other refusal is validation's, and lands in `unprobeable` (see `probe`).
  const compare = field.fieldType.refinement?.compare;
  let armsEnumerated = 0;
  const armsRefused: string[] = [];
  const armCodes = new Set<string>();
  for (const [op, arm] of opArmEntries()) {
    if (compare && !compare[arm]) continue;
    armsEnumerated += 1;
    const before = unprobeable.length;
    await probe(
      `${columns.field} ${op} ${other}`,
      predicateProbe(columns.type, columns.field, {
        kind: 'comparison',
        op,
        left: fieldRef(columns.type, columns.field),
        right: fieldRef(columns.type, other),
      }),
      'multiset',
      'note',
    );
    for (const skip of unprobeable.slice(before)) {
      armsRefused.push(op);
      for (const code of skip.codes) armCodes.add(code);
    }
  }
  // EVERY arm refused, over two columns of DIFFERENT field types, is not the
  // same finding as some arms refused, and the difference is what makes it worth
  // its own check. An arm the package refuses is silent by design
  // (`whenRefused: 'note'`) so a correct declaration's first run is clean — a
  // `json` Geometry refuses the three LIKE arms and probes the other six. But an
  // `other` of a DIFFERENT type refuses all nine, and the report then read
  // `ok: true · problems: []` having compared nothing: the `!type.field(other)`
  // guard above catches a name that does not exist, not one that exists with the
  // wrong type. That is the same failure the missing-`other` branch already
  // refuses to allow — "a check that quietly skipped most of what it was asked to
  // do would be worse than one that did not run" — reached by a road that named a
  // column.
  //
  // THE SIGNAL IS THE TYPE MISMATCH, NOT THE COUNT, and reading the count alone
  // was wrong twice over. "3 of 9 refused vs 9 of 9" is a coincidence of the
  // DEFAULT `compare` (which enumerates every arm): a conformant `json`
  // refinement declaring `compare: {equality:false, ordering:false,
  // textMatch:true}` enumerates exactly the three arms its KIND refuses (3 of 3),
  // and a HAS-MANY `relation` pair refuses all nine with no declaration at all
  // (a belongs-to refuses seven of the nine and probes `=` / `<>`). Both are
  // the SAME field type on both columns, so the message would have told the
  // reader that `'shape' is json as Geometry` and `'next' is json as Geometry`
  // differ — the defect {@link typeTag} exists to prevent, reached by another
  // road — and `ok` would be false for a correct declaration on its first run,
  // which {@link DifferentialReport.ok} refuses in terms.
  //
  // So the gate is the two TAGS, compared as the message renders them: all arms
  // refused is evidence of a mismatched `columns.other` only when there IS a
  // mismatch to name. When the two columns are the same type, every refusal is
  // one the KIND refuses, there is nothing here to compare, and the record of
  // that is `unprobeable` — the channel `whenRefused: 'note'` files it to on
  // purpose, and the only one that can carry it without failing the run.
  //
  // Gated on `armsEnumerated > 0` as well, so a type declaring every arm away
  // (`compare: {equality:false, ordering:false, textMatch:false}`) does not trip
  // it: nothing was enumerated, so nothing was refused, and the consumer said so.
  const fieldTag = typeTag(field.fieldType);
  const otherTag = typeTag(otherField.fieldType);
  if (armsEnumerated > 0 && armsRefused.length === armsEnumerated && fieldTag !== otherTag) {
    problems.push({
      path,
      code: 'conformance.differential-no-arms',
      severity: 'warning',
      message:
        `Every one of the ${armsEnumerated} comparison arm(s) this harness enumerated was refused by ` +
        `this package's own validation (${[...armCodes].join(', ')}), so NO arm was probed and this ` +
        `report says nothing about how '${columns.field}' compares — and the two columns are not the ` +
        `same field type: '${columns.field}' is ${fieldTag} and '${other}' is ${otherTag}. ` +
        '`columns.other` must be a SECOND FIELD OF THE SAME TYPE; one of another type makes every arm ' +
        'illegal, which is what this is. (A correct pairing refuses only the arms the KIND cannot take ' +
        '— a `json` type refuses the three LIKE arms — and those are reported in `unprobeable` alone.)',
    });
  }

  for (const name of opts.operators ?? []) {
    const operator = engine.lookupOperator(name);
    if (!operator) {
      problems.push(unknownCallable(path, 'operator', name, engine.registry.operatorNames()));
      continue;
    }
    await probe(
      name,
      valueProbe(columns.type, columns.field, {
        kind: 'operator',
        op: name,
        args: spreadArgs(operator.operands.map((o) => o.name), columns.type, columns.field, other),
      }),
      'multiset',
    );
  }

  for (const name of opts.functions ?? []) {
    const fn = engine.lookupFunction(name);
    if (!fn) {
      problems.push(unknownCallable(path, 'function', name, engine.registry.functionList().map((f) => f.name)));
      continue;
    }
    await probe(
      name,
      valueProbe(columns.type, columns.field, {
        kind: 'function-call',
        function: name,
        args: spreadArgs(fn.params.map((p) => p.name), columns.type, columns.field, other),
      }),
      'multiset',
    );
  }

  return verdict(problems.length === 0);
}

/**
 * One side's answer, rendered for comparison: as a SEQUENCE, or as a sorted
 * MULTISET (see {@link DifferentialComparison}).
 *
 * The multiset sort is over each value's own JSON rendering, which is the same
 * canonicalisation the comparison itself uses — so it is a stable total order on
 * exactly the values being compared, and it needs no opinion about how the
 * TYPE orders (which is the thing under test and must not be assumed).
 */
function canonical(values: readonly unknown[], comparison: DifferentialComparison): string {
  const rendered = values.map((v) => safeJson(v));
  return safeJson(comparison === 'multiset' ? [...rendered].sort() : rendered);
}

/**
 * The alias every probe projects under. ONE name for every statement, so the two
 * roads are read the same way and a probe's shape is not part of its comparison.
 */
const PROBE_COLUMN = 'probe';

/**
 * The `probe` cell of each row, in row order — the ONE reading applied to both
 * roads, so a difference in the two answers is never a difference in how they
 * were read.
 *
 * A row with no `probe` column reads as NULL. That cannot happen on the run side
 * (every probe projects the alias) and can on the SQL side, where the rows come
 * from a consumer's driver: one that lower-cases identifiers, or is handed a
 * `RETURNING`-less statement, hands back something else. Reading it as NULL
 * makes the disagreement VISIBLE in the report rather than a `undefined` that
 * `JSON.stringify` silently drops from the comparison.
 */
function probeValues<T>(rows: readonly Readonly<Record<string, T>>[]): (T | null)[] {
  return rows.map((r) => r[PROBE_COLUMN] ?? null);
}

/** `{ kind:'field-ref', source, field }` — the only expr a probe builds twice. */
function fieldRef(source: string, field: string): ExprDef {
  return { kind: 'field-ref', source, field };
}

/**
 * Fill a callable's declared argument names from the two probe columns,
 * ALTERNATING so a binary callable gets one of each and a unary one gets the
 * field under test.
 *
 * Alternating rather than "the field first, the other for the rest" because
 * arguments are ORDERED and a non-commutative callable (`<->`, `@>`,
 * `ST_Contains`) is exactly where a divergence hides: handing both roads the
 * same asymmetric argument list is what makes the comparison mean anything.
 */
function spreadArgs(
  names: readonly string[],
  source: string,
  field: string,
  other: string,
): Record<string, ExprDef> {
  const args: Record<string, ExprDef> = {};
  names.forEach((name, i) => {
    args[name] = fieldRef(source, i % 2 === 0 ? field : other);
  });
  return args;
}

/** `SELECT <field> AS probe FROM <type> ORDER BY <field> <dir>` — the ordering probe. */
function orderProbe(type: string, field: string, dir: 'asc' | 'desc'): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr: fieldRef(type, field), as: PROBE_COLUMN }],
    from: { kind: 'type', type },
    order: [{ expr: fieldRef(type, field), dir }],
  };
}

/**
 * `SELECT DISTINCT <field> AS probe FROM <type> ORDER BY <field>` — the probe
 * for the one road a comparator is NOT wired into.
 *
 * `DISTINCT` keys on the raw value's JSON in this package's runtime while the
 * predicate roads ask the declared comparator, so a comparator whose equality is
 * COARSER than raw identity keeps values apart here that `WHERE a = b` calls the
 * same — and a database whose column type agrees with the comparator collapses
 * them. That gap and the harness's blind spot were the same shape until this
 * probe existed.
 */
function distinctProbe(type: string, field: string): SelectDef {
  return { ...orderProbe(type, field, 'asc'), distinct: true };
}

/**
 * `SELECT <field> AS probe FROM <type> GROUP BY <field> ORDER BY <field>` — the
 * grouping twin of {@link distinctProbe}, and a separate probe because it is a
 * separate implementation (`recordSignature`, not the DISTINCT sweep).
 *
 * It projects the group KEY and no aggregate, which is the smallest legal
 * grouped SELECT and keeps what is compared to the one thing under test: how
 * many distinct keys each road thinks there are.
 */
function groupProbe(type: string, field: string): SelectDef {
  return { ...orderProbe(type, field, 'asc'), groupBy: [fieldRef(type, field)] };
}

/**
 * `SELECT <field> AS probe FROM <type> WHERE <predicate> ORDER BY <field>` — a
 * PREDICATE probe, which compares WHICH ROWS survived rather than what the
 * predicate evaluated to (a `bool` renders differently across drivers, and row
 * membership is the fact a predicate actually decides).
 *
 * Ordered by the field so the two roads' row order is the STATEMENT's rather
 * than each engine's own, which is what makes a positional comparison legitimate
 * at all.
 */
function predicateProbe(type: string, field: string, where: ExprDef): SelectDef {
  return { ...orderProbe(type, field, 'asc'), where: [where] };
}

/** `SELECT <expr> AS probe FROM <type> ORDER BY <field>` — a VALUE probe. */
function valueProbe(type: string, field: string, expr: ExprDef): SelectDef {
  return {
    kind: 'select',
    fields: [{ expr, as: PROBE_COLUMN }],
    from: { kind: 'type', type },
    order: [{ expr: fieldRef(type, field), dir: 'asc' }],
  };
}

/** A named operator / function this engine does not have — a caller typo, reported rather than thrown. */
function unknownCallable(
  path: readonly (string | number)[],
  what: string,
  name: string,
  registered: readonly string[],
): Problem {
  return {
    path: [...path, name],
    code: 'conformance.differential-unknown-callable',
    severity: 'error',
    message:
      `No ${what} '${name}' is registered on this engine.${didYouMean(name, [...registered])} ` +
      `(registered: ${registered.length > 0 ? registered.join(', ') : 'none'}).`,
  };
}
