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
import { OperatorExpr } from './exprs/operator';
import type { OperatorDef } from './operator';
import type { Problem } from './problem';
import { Problems, QueryTypeError } from './problem';
import { createRegistry, type Registry } from './registry';
import {
  REFINABLE_BASES,
  type FieldTypeImpl,
  type FieldTypeRefinement,
  type FieldTypeRefinementDef,
  type RefinableBase,
} from './refinement';
import type { FieldTypeDef, FieldTypeKind, JsonValue } from './schema';

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
      registry.registerFieldTypeImpl(decl.name, { value: impl.value });
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
  return { ok: problems.length === 0, problems, lattice };
}

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

/** A thrown `QueryTypeError` as its own `Problem`; anything else as a conformance one. */
function asProblem(err: unknown, path: (string | number)[], code: string): Problem {
  if (err instanceof QueryTypeError) return err.problem;
  return { path, code, severity: 'error', message: err instanceof Error ? err.message : String(err) };
}

/** Every kind a refinement may narrow — re-exported so a caller can loop the same set the checks do. */
export { REFINABLE_BASES, SCALAR_KINDS };
