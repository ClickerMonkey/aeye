/**
 * A bind param's type is the MEET of every use — and supplied values are
 * checked against it before execution.
 *
 * Through 0.6.5 `ParamSet.resolved` seeded with the FIRST observation and kept
 * it, rejecting any later one that was not `comparableWith` it. Two consequences,
 * both measured on that build:
 *
 *  - it was ORDER-DEPENDENT. A param compared against an `enum` in one place and
 *    plain `text` in another resolved to whichever the walk reached first — a
 *    property of where the clauses sat in the JSON, not of what the query means.
 *    The answer is the ENUM: the most specific type compatible with both uses.
 *  - it NEVER NARROWED. `text{minLength:5}` beside `text{maxLength:10}` reported
 *    one bound and dropped the other, so nothing downstream could know the real
 *    requirement.
 *
 * And a bound VALUE was never checked against any of it: `run(q, { params })`
 * bound whatever it was given.
 *
 * The meet is the fix, and its ALGEBRA is what makes the fix trustworthy — a
 * fold over uses in walk order is only order-independent if the operation is
 * commutative, associative and idempotent. Those three are property-tested here
 * over every pair and triple of a representative type set, alongside the
 * soundness property that actually matters: the meet accepts nothing that both
 * operands do not.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import { FieldType } from '../field-type';
import {
  ArrayFieldType,
  BoolFieldType,
  DateFieldType,
  JsonFieldType,
  MoneyFieldType,
  NumberFieldType,
  RelationFieldType,
  TextFieldType,
  TimestampFieldType,
} from '../field-types/index';
import { meetFieldValues } from '../field-types/_values';
import { fixture } from './_utils';
import type { ExprDef, FieldTypeKind, FieldValueDef, JsonValue, SelectDef, TypeDef, UpdateDef } from '../schema';

// ─── The type set the algebra is proved over ─────────────────────────────────

/**
 * One representative of every shape a meet has to reconcile: unconstrained,
 * bounded, patterned, closed-set (overlapping, disjoint, subset), flagged, and
 * one of each cross-kind family (`number`/`money`, `date`/`timestamp`), plus the
 * composites (`array` with and without an element type, `relation` to two
 * different targets).
 *
 * EVERY ENTRY IS A SHAPE `parseFieldType` CAN BUILD — asserted below, not
 * assumed, because that is the domain the top-identity law is stated over.
 * The three SELF-INCONSISTENT entries this table used to carry
 * (`text{values:['ab'], minLength:5}`, `text{values:['zz'], pattern:'^a'}`, and
 * a mixed-scalar `text{values:[1,'a']}`) are no longer declarable through
 * `from` — the first two are refused by `field-type.bad-values` and the third
 * by that plus the per-kind member schema. They are still constructible BY HAND,
 * which is a different road with a different guarantee; that road is exercised
 * on its own below rather than inside the algebra loops.
 */
const TYPES: Readonly<Record<string, FieldType>> = {
  text: new TextFieldType(),
  textMin5: new TextFieldType({ minLength: 5 }),
  textMax10: new TextFieldType({ maxLength: 10 }),
  textMin12: new TextFieldType({ minLength: 12 }),
  textPatA: new TextFieldType({ pattern: '^a' }),
  textPatB: new TextFieldType({ pattern: '^b' }),
  textSensitive: new TextFieldType({ sensitive: true }),
  enumAB: new TextFieldType({ values: [{ value: 'a' }, { value: 'bb' }] }),
  enumBC: new TextFieldType({ values: [{ value: 'bb', label: 'Double B' }, { value: 'c' }] }),
  enumC: new TextFieldType({ values: [{ value: 'c' }] }),
  // A DUPLICATED member: representable, and the shape that made the
  // intersection's multiplicity depend on which operand was on the left.
  enumDup: new TextFieldType({ values: [{ value: 'a' }, { value: 'a' }, { value: 'bb' }] }),
  // A set carrying a constraint ON THE SAME SIDE. Only the arrangement the
  // constraint ADMITS is declarable now, so the EXCLUDED arrangement moved to
  // the hand-built caveat test — where its refusal at `from` is the fact.
  enumPatA: new TextFieldType({ pattern: '^a', values: [{ value: 'a' }, { value: 'ab' }] }),
  enumMinOk: new TextFieldType({ minLength: 5, values: [{ value: 'abcde' }] }),
  number: new NumberFieldType(),
  numWhole: new NumberFieldType({ whole: true }),
  num2to8: new NumberFieldType({ min: 2, max: 8 }),
  num10to20: new NumberFieldType({ min: 10, max: 20 }),
  numPlaces: new NumberFieldType({ minPlaces: 1, maxPlaces: 4 }),
  enum123: new NumberFieldType({ values: [{ value: 1 }, { value: 2 }, { value: 3 }] }),
  money: new MoneyFieldType(),
  moneyUsd: new MoneyFieldType({ currency: 'USD' }),
  moneyEur: new MoneyFieldType({ currency: 'EUR', number: { min: 0 } }),
  moneySet: new MoneyFieldType({ currency: 'USD', number: { values: [{ value: 0 }, { value: 10 }] } }),
  bool: new BoolFieldType(),
  date: new DateFieldType(),
  dateNaive: new DateFieldType(false),
  dateTz: new DateFieldType(true),
  timestamp: new TimestampFieldType(),
  timestampTz: new TimestampFieldType(true),
  json: new JsonFieldType(),
  jsonSchema: new JsonFieldType({ type: 'object' }),
  arrAny: new ArrayFieldType(),
  arrText: new ArrayFieldType(new TextFieldType()),
  arrNum: new ArrayFieldType(new NumberFieldType(), 1),
  arrEnum: new ArrayFieldType(new TextFieldType({ values: [{ value: 'a' }, { value: 'bb' }] })),
  arrNested: new ArrayFieldType(new ArrayFieldType(new NumberFieldType())),
  relUser: new RelationFieldType('user', 1),
  relUserMany: new RelationFieldType('user', 5),
  relUserInverse: new RelationFieldType('user', 1, 'orders', 'userId'),
  relOrder: new RelationFieldType('order', 1),
};

const NAMES = Object.keys(TYPES);
const at = (name: string): FieldType => TYPES[name]!;

/** A meet rendered for comparison — its JSON def, or `null` for a conflict (which `toEqual` compares cleanly). */
const meetJson = (a: FieldType, b: FieldType): unknown => a.meet(b)?.toJSON() ?? null;

/**
 * A meet as a canonical STRING, for the exhaustive property loops. They compare
 * ~70k results; one `expect` per comparison spends the whole budget inside
 * vitest's deep-equal rather than on the property, so each loop compares strings
 * and asserts ONCE on the collected mismatches (which is also what makes a
 * failure list every offending combination instead of only the first).
 */
const meetKey = (a: FieldType | undefined, b: FieldType | undefined): string =>
  JSON.stringify(a && b ? (a.meet(b)?.toJSON() ?? null) : null);

/**
 * The unconstrained (TOP) type of each kind, for the `x ⊓ ⊤ = x` law. `relation`
 * is absent deliberately — its `to` is an identity, not a constraint, so there
 * is no relation that constrains nothing.
 */
const TOP_BY_KIND: Partial<Record<FieldTypeKind, FieldType>> = {
  text: new TextFieldType(),
  number: new NumberFieldType(),
  money: new MoneyFieldType(),
  bool: new BoolFieldType(),
  date: new DateFieldType(),
  timestamp: new TimestampFieldType(),
  json: new JsonFieldType(),
  array: new ArrayFieldType(),
};

/** The pairwise meets, precomputed once and shared by the associativity loop. */
const PAIRS = new Map<string, FieldType | undefined>(
  NAMES.flatMap((x) => NAMES.map((y) => [`${x}|${y}`, at(x).meet(at(y))] as const)),
);
const pair = (x: string, y: string): FieldType | undefined => PAIRS.get(`${x}|${y}`);

/** Values spanning every category, for the soundness property. */
const SAMPLES: JsonValue[] = [
  'a', 'bb', 'c', 'abcdefgh', 'abcdefghijklmnop', '', 0, 1, 2, 3, 7, 15, -1, 1.5,
  true, false, null, '2026-01-01', '2026-01-01T09:30', ['a'], [1], [], { x: 1 },
];

describe('the meet is a genuine meet (property, over every pair and triple)', () => {
  it('is COMMUTATIVE — a ∧ b is b ∧ a, byte for byte', () => {
    const mismatched: string[] = [];
    for (const x of NAMES) {
      for (const y of NAMES) {
        const forward = meetKey(at(x), at(y));
        const backward = meetKey(at(y), at(x));
        if (forward !== backward) mismatched.push(`${x} ∧ ${y}: ${forward} vs ${backward}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('is IDEMPOTENT — a ∧ a is a', () => {
    for (const x of NAMES) {
      expect(at(x).meet(at(x))?.toJSON()).toEqual(at(x).toJSON());
      // …and against an equal-but-distinct instance, not just the same object.
      expect(at(x).meet(at(x).clone())?.toJSON()).toEqual(at(x).toJSON());
    }
  });

  it('is ASSOCIATIVE — (a ∧ b) ∧ c is a ∧ (b ∧ c)', () => {
    const mismatched: string[] = [];
    for (const x of NAMES) {
      for (const y of NAMES) {
        for (const z of NAMES) {
          const left = meetKey(pair(x, y), at(z));
          const right = meetKey(at(x), pair(y, z));
          if (left !== right) mismatched.push(`${x} ∧ ${y} ∧ ${z}: ${left} vs ${right}`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('every type in the set is one `parseFieldType` can BUILD — the domain the next law is stated over', () => {
    // The top-identity law below is UNCONDITIONAL, and it is only entitled to be
    // so because no entry here is self-inconsistent. Asserting that structurally
    // — the def road refuses such a declaration outright — is what stops the
    // law from being "true because the table was quietly curated": adding a
    // hand-built `text{values:['ab'], minLength:5}` fails HERE, at the premise,
    // rather than silently reintroducing an exception to the law.
    const registry = createRegistry();
    for (const x of NAMES) {
      const json = at(x).toJSON();
      expect(registry.parseFieldType(json).toJSON()).toEqual(json);
    }
  });

  it('is the GREATEST lower bound for a registry-built type — `x ⊓ ⊤ = x`, unconditionally', () => {
    // Through 0.6.6's first pass this law had a NAMED expected-failure set: a
    // closed set IS the value schema, so a meet narrows a merged set by the
    // merged constraints, and a type whose OWN set and constraints disagreed
    // (`text{values:['ab'], minLength:5}`) narrowed or conflicted against the
    // unconstrained type of its own kind. The narrowing was never the defect —
    // keeping `1` from `text{values:[1,'b']} ⊓ text` would ADMIT a value plain
    // text refuses, breaking the soundness law a validator depends on — the
    // DECLARATION was, and it is now refused where declarations are read
    // (`field-type.bad-values`, plus a per-kind member schema). So the exception
    // set is empty and the law is asserted with no carve-out: over every shape
    // a def can express, the meet is the greatest lower bound, and
    // `param.conflict` can no longer blame a query for a defect in the type.
    const offenders: string[] = [];
    for (const x of NAMES) {
      const top = TOP_BY_KIND[at(x).kind];
      // `relation` has no top: `to` is identity rather than a constraint, and
      // the meet drops the inverse metadata by design (see `relation.ts`).
      if (!top) continue;
      if (meetKey(at(x), top) !== JSON.stringify(at(x).toJSON())) offenders.push(`${x}: narrowed`);
    }
    expect(offenders).toEqual([]);
  });

  it('…and still only a LOWER bound for a HAND-BUILT type, which is why the law names its domain', () => {
    // The public CONSTRUCTORS do not validate — the same caveat `TextOptions.pattern`
    // already carries — so a self-inconsistent type remains constructible by
    // hand, and for one of those `x ⊓ ⊤` still narrows or conflicts. That is not
    // a gap in the meet: soundness comes first, and these are exactly the
    // declarations `from` now refuses. Kept as a test so the distinction between
    // the two roads stays measured rather than asserted only in prose.
    const tooShort = new TextFieldType({ minLength: 5, values: [{ value: 'ab' }] });
    const patExcluded = new TextFieldType({ pattern: '^a', values: [{ value: 'zz' }] });
    const mixed = new TextFieldType({ values: [{ value: 1 }, { value: 'a' }] });
    expect(tooShort.validValue('ab')).toBe(true); // the set short-circuits the bound
    expect(tooShort.meet(new TextFieldType())).toBeUndefined();
    expect(patExcluded.meet(new TextFieldType())).toBeUndefined();
    expect(mixed.meet(new TextFieldType())?.toJSON()).toEqual({ kind: 'text', values: [{ value: 'a' }] });
    // …and each of the three is refused on the def road, which is what makes the
    // unconditional law above true for everything `parseType` can produce.
    for (const hand of [tooShort, patExcluded, mixed]) {
      expect(() => TextFieldType.from(hand.toJSON())).toThrow(/closed-set member/);
    }
  });

  it('is at least as strict as comparableWith — a meet implies comparability', () => {
    const offenders: string[] = [];
    for (const x of NAMES) {
      for (const y of NAMES) {
        if (pair(x, y) !== undefined && !at(x).comparableWith(at(y))) offenders.push(`${x} ∧ ${y}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is SOUND — the meet accepts nothing that both operands do not', () => {
    // The property that makes it usable as a validator: checking a supplied
    // value against the merged type can never admit a value one of the uses
    // would have refused.
    // `validValue` rebuilds its zod schema per call, so the schemas are cached
    // per type here — otherwise the loop measures zod construction, not the
    // property.
    const schemas = new Map<FieldType, z.ZodTypeAny>();
    const admits = (ft: FieldType, v: JsonValue): boolean => {
      let s = schemas.get(ft);
      if (!s) schemas.set(ft, (s = ft.toValueSchema()));
      return s.safeParse(v).success;
    };
    const unsound: string[] = [];
    for (const x of NAMES) {
      for (const y of NAMES) {
        const m = pair(x, y);
        if (!m) continue;
        for (const v of SAMPLES) {
          if (admits(m, v) && !(admits(at(x), v) && admits(at(y), v))) {
            unsound.push(`${x} ∧ ${y} admits ${JSON.stringify(v)}`);
          }
        }
      }
    }
    expect(unsound).toEqual([]);
  });
});

describe('the meet is the SPECIFIC answer, not the first one', () => {
  it('enum ⊓ text = enum (the owner’s example)', () => {
    expect(meetJson(TYPES['enumAB']!, TYPES['text']!)).toEqual(TYPES['enumAB']!.toJSON());
    expect(meetJson(TYPES['text']!, TYPES['enumAB']!)).toEqual(TYPES['enumAB']!.toJSON());
  });

  it('enum{a,bb} ⊓ enum{bb,c} = enum{bb}, keeping the label either side declared', () => {
    // A label is display text, never a query fact, so a member that carries one
    // on only one side keeps it — and the merge stays order-independent because
    // it takes the lexicographically smallest rather than "the left one's".
    expect(meetJson(TYPES['enumAB']!, TYPES['enumBC']!)).toEqual({
      kind: 'text',
      values: [{ value: 'bb', label: 'Double B' }],
    });
  });

  it('text{minLength:5} ⊓ text{maxLength:10} carries BOTH bounds', () => {
    expect(meetJson(TYPES['textMin5']!, TYPES['textMax10']!)).toEqual({
      kind: 'text',
      minLength: 5,
      maxLength: 10,
    });
  });

  it('number ⊓ money = money — money is the narrower side of the numeric family', () => {
    expect(meetJson(TYPES['num2to8']!, TYPES['moneyUsd']!)).toEqual({
      kind: 'money',
      number: { min: 2, max: 8 },
      currency: 'USD',
    });
  });

  it('date ⊓ timestamp = timestamp — its values satisfy both', () => {
    expect(meetJson(TYPES['date']!, TYPES['timestamp']!)).toEqual({ kind: 'timestamp' });
  });

  it('array element types meet, and an unknown element adopts the known one', () => {
    expect(meetJson(TYPES['arrAny']!, TYPES['arrNum']!)).toEqual({ kind: 'array', minItems: 1, item: { kind: 'number' } });
    expect(meetJson(TYPES['arrText']!, TYPES['arrNum']!)).toBeNull();
  });

  it('a closed set is NARROWED by a constraint that arrived from the other side', () => {
    // `applied` is a member and `screening` is not long enough — the merged type
    // must admit exactly the members that satisfy both, because the closed set
    // IS the value schema.
    const status = new TextFieldType({ values: [{ value: 'applied' }, { value: 'hired' }] });
    const merged = status.meet(new TextFieldType({ minLength: 6 }));
    expect(merged?.toJSON()).toEqual({ kind: 'text', minLength: 6, values: [{ value: 'applied' }] });
    expect(merged!.validValue('hired')).toBe(false);
  });
});

describe('an EMPTY meet is a CONFLICT, not a type nothing satisfies', () => {
  it('two closed sets with no shared member have no meet', () => {
    // An empty `values` array is not representable (`compactFieldValues` drops
    // it, so `1/n` cannot divide by zero) — a "set of nothing" would round-trip
    // into an UNCONSTRAINED text type, i.e. the opposite of what was computed.
    expect(meetJson(TYPES['enumAB']!, TYPES['enumC']!)).toBeNull();
  });

  it('two disjoint bounds have no meet', () => {
    expect(meetJson(TYPES['textMin12']!, TYPES['textMax10']!)).toBeNull();
    expect(meetJson(TYPES['num2to8']!, TYPES['num10to20']!)).toBeNull();
  });

  it('two different single-valued constraints have no meet', () => {
    expect(meetJson(TYPES['textPatA']!, TYPES['textPatB']!)).toBeNull();
    expect(meetJson(TYPES['moneyUsd']!, TYPES['moneyEur']!)).toBeNull();
    expect(meetJson(TYPES['dateTz']!, TYPES['dateNaive']!)).toBeNull();
    // …while an UNDECLARED policy is TOP, so it adopts the other side's.
    expect(meetJson(TYPES['date']!, TYPES['dateNaive']!)).toEqual({ kind: 'date', timezone: false });
    expect(meetJson(TYPES['json']!, TYPES['jsonSchema']!)).toEqual({ kind: 'json', schema: { type: 'object' } });
    expect(meetJson(TYPES['jsonSchema']!, new JsonFieldType({ type: 'array' }))).toBeNull();
  });

  it('a closed set narrowed to nothing has no meet', () => {
    expect(meetJson(TYPES['enumAB']!, TYPES['textMin12']!)).toBeNull();
    // …and the numeric road to the same answer: members outside the merged bounds.
    expect(meetJson(TYPES['enum123']!, TYPES['num10to20']!)).toBeNull();
  });

  it('two NUMERIC closed sets with no shared member have no meet either', () => {
    const odd = new NumberFieldType({ values: [{ value: 1 }, { value: 3 }] });
    const even = new NumberFieldType({ values: [{ value: 2 }, { value: 4 }] });
    expect(odd.meet(even)).toBeUndefined();
    // And through `money`, whose set lives in the inner numeric bag.
    expect(new MoneyFieldType({ number: { values: [{ value: 1 }] } }).meet(even)).toBeUndefined();
  });

  it('different categories have no meet, in either direction', () => {
    expect(meetJson(TYPES['text']!, TYPES['number']!)).toBeNull();
    expect(meetJson(TYPES['relUser']!, TYPES['relOrder']!)).toBeNull();
    expect(meetJson(TYPES['bool']!, TYPES['json']!)).toBeNull();
    // A relation to the SAME target does meet, taking the tighter cardinality.
    expect(meetJson(TYPES['relUser']!, TYPES['relUserMany']!)).toEqual({ kind: 'relation', to: 'user', count: 1 });
  });
});

describe('the details of merging two closed sets', () => {
  const num = (...values: number[]): NumberFieldType => new NumberFieldType({ values: values.map((value) => ({ value })) });

  it('sorts a numeric intersection NUMERICALLY, not as text', () => {
    // `10` after `9`, which a string sort would get wrong — and the order is
    // canonical precisely so the merge is commutative.
    expect(num(10, 2, 9).meet(num(9, 10, 2, 3))?.toJSON()).toEqual({
      kind: 'number',
      values: [{ value: 2 }, { value: 9 }, { value: 10 }],
    });
  });

  it('orders a MIXED-scalar set totally — `1` and `"1"` render alike and must not confuse the sort', () => {
    // A closed set can hold both (`closedSetValueSchema` builds a union of
    // literals for exactly that reason), so the canonical comparator has to be
    // TOTAL. This is the ONLY guard on that totality — no entry in `TYPES` holds
    // both `1` and `'1'`, and none can any more: a mixed-scalar set is no longer
    // declarable through `from` (the member schema is per kind, and a numeric
    // member of a `text` set is refused by `field-type.bad-values`). The shape
    // is still reachable through the public CONSTRUCTORS, which is why the test
    // stays and why it is written against the primitive rather than a def.
    // Exercised on the primitive also because a `text` type's meet then narrows
    // a numeric member away — see the next test.
    const left: FieldValueDef[] = [{ value: 1 }, { value: '1' }, { value: 'b' }];
    const right: FieldValueDef[] = [{ value: 'b' }, { value: '1' }, { value: 1 }];
    // Numbers sort ahead of text, which is what breaks the `1` / `'1'` tie —
    // a tie would leave the order to `Array.sort`'s stability, i.e. to whichever
    // operand came first, i.e. not commutative at all.
    expect(meetFieldValues(left, right)).toEqual({ ok: true, value: [{ value: 1 }, { value: '1' }, { value: 'b' }] });
    expect(meetFieldValues(right, left)).toEqual(meetFieldValues(left, right));
  });

  it('DEDUPES — multiplicity would otherwise follow whichever operand is on the LEFT', () => {
    // A duplicate is representable (`fieldValuesSchema` does not forbid one and
    // `parseType` accepted it unchanged), and the intersection builds its lookup
    // from the RIGHT operand while iterating the LEFT — so a duplicated member
    // survived twice from one side and once from the other, and `a ⊓ b` was not
    // `b ⊓ a`. The damage was not cosmetic: the same query got a different
    // `params()`, a different `eqSelectivity` (1/3 vs 1/2, i.e. a different cost
    // estimate), `one of done|todo|todo` in the model-facing description, and a
    // repeated option in any UI built from `ParamDef.type.values`.
    const dup: FieldValueDef[] = [{ value: 'a' }, { value: 'a' }, { value: 'b' }];
    expect(meetFieldValues(dup, [{ value: 'a' }])).toEqual({ ok: true, value: [{ value: 'a' }] });
    expect(meetFieldValues([{ value: 'a' }], dup)).toEqual(meetFieldValues(dup, [{ value: 'a' }]));
    // Normalized at the ONE place that owns "what is a legal set", so a declared
    // duplicate never reaches selectivity or the description either.
    expect(new TextFieldType({ values: dup }).toJSON().values).toEqual([{ value: 'a' }, { value: 'b' }]);
    expect(TextFieldType.from({ kind: 'text', values: dup }).eqSelectivity()).toBeCloseTo(1 / 2);
  });

  it('drops a member the merged type’s own CATEGORY cannot hold — which is what keeps the meet sound', () => {
    // A `text` field declaring a NUMERIC member is a self-inconsistent
    // declaration that `toValueSchema` accepts (a closed set short-circuits the
    // string check). Merging it with plain `text` — which admits no number at
    // all — has to drop it, or the meet would admit a value one operand refuses.
    // Built BY HAND deliberately: `from` refuses this declaration now, and the
    // narrowing is what a hand-built one still relies on for soundness.
    const odd = new TextFieldType({ values: [{ value: 1 }, { value: 'b' }] });
    expect(odd.meet(new TextFieldType())?.values()).toEqual([{ value: 'b' }]);
    // …and it stays exactly itself when met with itself.
    expect(odd.meet(odd.clone())?.toJSON()).toEqual(odd.toJSON());
  });

  it('an absent set is TOP, and two identical lists come back untouched', () => {
    const list: FieldValueDef[] = [{ value: 'b' }, { value: 'a' }];
    expect(meetFieldValues(undefined, list)).toEqual({ ok: true, value: list });
    expect(meetFieldValues(list, undefined)).toEqual({ ok: true, value: list });
    expect(meetFieldValues(undefined, undefined)).toEqual({ ok: true, value: undefined });
    // Identical lists short-circuit — the ORDER survives, which is what makes
    // the meet exactly idempotent rather than idempotent-up-to-reordering.
    expect(meetFieldValues(list, [...list])).toEqual({ ok: true, value: list });
  });

  it('keeps a label declared on EITHER side, and the smaller when both declare one', () => {
    const withLabel = new TextFieldType({ values: [{ value: 'a', label: 'Alpha' }, { value: 'b' }] });
    const without = new TextFieldType({ values: [{ value: 'a' }, { value: 'b', label: 'Bravo' }] });
    expect(withLabel.meet(without)?.toJSON()).toEqual({
      kind: 'text',
      values: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Bravo' }],
    });
    const other = new TextFieldType({ values: [{ value: 'a', label: 'Zulu' }] });
    // Two labels for one member: the lexicographically smaller, because that is
    // the only choice that makes the merge order-independent.
    expect(withLabel.meet(other)?.values()).toEqual([{ value: 'a', label: 'Alpha' }]);
    expect(other.meet(withLabel)?.values()).toEqual([{ value: 'a', label: 'Alpha' }]);
  });
});

describe('the remaining constraint families', () => {
  it('meets DECIMAL-PLACE bounds, and refuses a disjoint pair', () => {
    const a = new NumberFieldType({ minPlaces: 2 });
    const b = new NumberFieldType({ maxPlaces: 4 });
    expect(a.meet(b)?.toJSON()).toEqual({ kind: 'number', minPlaces: 2, maxPlaces: 4 });
    expect(a.meet(new NumberFieldType({ maxPlaces: 1 }))).toBeUndefined();
  });

  it('ORs the `whole` constraint — the narrower of the two wins', () => {
    expect(new NumberFieldType({ min: 0 }).meet(new NumberFieldType({ whole: true }))?.toJSON()).toEqual({
      kind: 'number',
      min: 0,
      whole: true,
    });
  });

  it('refuses two money types whose AMOUNTS cannot both hold', () => {
    const small = new MoneyFieldType({ currency: 'USD', number: { max: 5 } });
    const big = new MoneyFieldType({ currency: 'USD', number: { min: 10 } });
    expect(small.meet(big)).toBeUndefined();
  });

  it('meets array element COUNTS, and refuses a disjoint pair', () => {
    const atLeast5 = new ArrayFieldType(undefined, 5);
    const atMost2 = new ArrayFieldType(undefined, undefined, 2);
    expect(atLeast5.meet(atMost2)).toBeUndefined();
    // Neither side names an element type → the merged array stays heterogeneous.
    expect(new ArrayFieldType(undefined, 1).meet(new ArrayFieldType(undefined, undefined, 3))?.toJSON()).toEqual({
      kind: 'array',
      minItems: 1,
      maxItems: 3,
    });
    // Same element type, different bounds → the element survives the merge.
    expect(new ArrayFieldType(new TextFieldType(), 1).meet(new ArrayFieldType(new TextFieldType(), 2))?.toJSON()).toEqual({
      kind: 'array',
      minItems: 2,
      item: { kind: 'text' },
    });
  });
});

// ─── The param surface over a real query ─────────────────────────────────────

const personDef: TypeDef = {
  name: 'person',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'status', type: { kind: 'text', values: [{ value: 'applied' }, { value: 'screening', label: 'In screening' }, { value: 'hired' }] } },
    { name: 'stage', type: { kind: 'text', values: [{ value: 'hired' }, { value: 'fired' }] } },
    { name: 'region', type: { kind: 'text', values: [{ value: 'north' }, { value: 'south' }] } },
    { name: 'code', type: { kind: 'text', minLength: 5 } },
    { name: 'slug', type: { kind: 'text', maxLength: 10 } },
  ],
  indexes: [{ exprs: [{ expr: { kind: 'field-ref', source: 'person', field: 'id' }, count: 1 }] }],
  count: 1000,
  bytes: 64,
};

function engineOf(): QueryEngine {
  const registry = createRegistry();
  registry.registerType(registry.parseType(personDef));
  registry.finalize();
  return new QueryEngine(registry);
}

/** `person.<field> = :<param>`. */
const eq = (field: string, param: string): ExprDef => ({
  kind: 'comparison',
  op: '=',
  left: { kind: 'field-ref', source: 'person', field },
  right: { kind: 'param', name: param },
});

/** `SELECT id FROM person WHERE <conditions ANDed>`. */
const select = (...where: ExprDef[]): SelectDef => ({
  kind: 'select',
  fields: [{ expr: { kind: 'field-ref', source: 'person', field: 'id' } }],
  from: { kind: 'type', type: 'person' },
  where,
});

describe('a param’s reported type is the meet of its uses', () => {
  it('the ENUM wins over plain text — in EITHER clause order', () => {
    const engine = engineOf();
    const enumFirst = engine.parseQuery(select(eq('status', 'p'), eq('name', 'p'))).params(engine);
    const textFirst = engine.parseQuery(select(eq('name', 'p'), eq('status', 'p'))).params(engine);
    expect(enumFirst).toEqual([
      {
        name: 'p',
        type: { kind: 'text', values: [{ value: 'applied' }, { value: 'screening', label: 'In screening' }, { value: 'hired' }] },
      },
    ]);
    // The whole point: the walk order cannot change the answer.
    expect(textFirst).toEqual(enumFirst);
  });

  it('two bounded uses report BOTH bounds', () => {
    const engine = engineOf();
    expect(engine.parseQuery(select(eq('code', 'p'), eq('slug', 'p'))).params(engine)).toEqual([
      { name: 'p', type: { kind: 'text', minLength: 5, maxLength: 10 } },
    ]);
  });

  it('two closed sets INTERSECT — the param is the one value that satisfies both', () => {
    const engine = engineOf();
    expect(engine.parseQuery(select(eq('status', 'p'), eq('stage', 'p'))).params(engine)).toEqual([
      { name: 'p', type: { kind: 'text', values: [{ value: 'hired' }] } },
    ]);
  });

  it('a single use is reported EXACTLY as it was observed (no re-derivation)', () => {
    const engine = engineOf();
    expect(engine.parseQuery(select(eq('id', 'p'))).params(engine)).toEqual([
      { name: 'p', type: { kind: 'number', whole: true } },
    ]);
  });
});

describe('engine.parameters — the per-use detail behind that answer', () => {
  it('reports every use with its path, its required type, its category, and its COLUMN', () => {
    const engine = engineOf();
    const [info] = engine.parameters(select(eq('status', 'p'), eq('name', 'p')));
    expect(info!.name).toBe('p');
    expect(info!.category).toBe('text');
    expect(info!.type!.values()).toHaveLength(3);
    expect(info!.uses.map((u) => ({ at: u.at, category: u.category, field: u.field }))).toEqual([
      { at: ['where', 0, 'right'], category: 'text', field: { type: 'person', field: 'status' } },
      { at: ['where', 1, 'right'], category: 'text', field: { type: 'person', field: 'name' } },
    ]);
    // Each use carries the FULL field type, not just the summary — the first is
    // the closed set, which is what made the merged answer the enum.
    expect(info!.uses[0]!.type.values()).toHaveLength(3);
    expect(info!.uses[1]!.type.values()).toBeUndefined();
    expect(info!.references).toEqual([['where', 0, 'right'], ['where', 1, 'right']]);
    expect(info!.conflict).toBeUndefined();
  });

  it('names the COLUMN behind a WRITE cell’s param too', () => {
    const update: UpdateDef = { kind: 'update', type: 'person', set: { status: { kind: 'param', name: 'next' } } };
    const [info] = engineOf().parameters(update);
    expect(info!.uses[0]!.field).toEqual({ type: 'person', field: 'status' });
    expect(info!.category).toBe('text');
  });

  it('names the ARRAY column behind an array-op param — its ITEM type is the requirement', () => {
    // Every `observe` site with a column in hand attributes its use to it; an
    // array op is the one whose requirement is the column's ITEM type rather
    // than the column's own, which is a reason to say WHICH column, not a reason
    // to answer "unknown" for one operator out of five.
    const fx = fixture();
    const def: SelectDef = {
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'user', field: 'id' } }],
      from: { kind: 'type', type: 'user' },
      where: [
        {
          kind: 'array-op',
          op: 'contains',
          target: { kind: 'field-ref', source: 'user', field: 'tags' },
          value: [{ kind: 'param', name: 'tag' }],
        },
      ],
    };
    const [info] = fx.engine.parameters(def);
    expect(info!.category).toBe('text');
    expect(info!.uses[0]!.field).toEqual({ type: 'user', field: 'tags' });
  });

  it('reports a param with NO column origin as such (a row bound is a row count, not a field)', () => {
    const [info] = engineOf().parameters({ ...select(), limit: { kind: 'param', name: 'take' } });
    expect(info!.uses).toEqual([{ at: ['limit'], type: info!.uses[0]!.type, category: 'number' }]);
    expect(info!.uses[0]!.field).toBeUndefined();
  });

  it('answers `undefined` for a name it has never seen', () => {
    const engine = engineOf();
    const scope = engine.globalScope();
    engine.validateQuery(select(eq('status', 'p')), scope);
    expect(scope.params.info('p')).toBeDefined();
    expect(scope.params.info('nosuch')).toBeUndefined();
  });

  it('reports an UNTYPED param with its references and no type', () => {
    const engine = engineOf();
    const def = select({ kind: 'is-null', value: { kind: 'param', name: 'lonely' } });
    const [info] = engine.parameters(def);
    expect(info!.name).toBe('lonely');
    expect(info!.uses).toEqual([]);
    expect(info!.type).toBeUndefined();
    expect(engine.validateQuery(def).list.map((p) => p.code)).toEqual(['param.untyped']);
  });

  it('reports a CONFLICTED param in full, where `params()` drops it', () => {
    const engine = engineOf();
    const def = select(eq('status', 'p'), eq('id', 'p'));
    const [info] = engine.parameters(def);
    expect(info!.type).toBeUndefined();
    expect(info!.uses).toHaveLength(2);
    expect(info!.conflict!.required.resolve()).toBe('text');
    expect(info!.conflict!.use.category).toBe('number');
    expect(info!.conflict!.use.at).toEqual(['where', 1, 'right']);
    // `params()` reports only what can be BOUND, so a conflicted param is absent
    // from it — its explanation lives here.
    expect(engine.parseQuery(def).params(engine)).toEqual([]);
  });
});

describe('param.conflict says WHICH kind of conflict it is', () => {
  it('different categories name both types and both paths', () => {
    const problems = engineOf().validateQuery(select(eq('status', 'p'), eq('id', 'p'))).list;
    const conflict = problems.find((x) => x.code === 'param.conflict')!;
    expect(conflict.message).toContain('where.0.right');
    expect(conflict.message).toContain('where.1.right');
    expect(conflict.message).toContain('number');
  });

  it('the SAME category with no common value says so, and names the members', () => {
    // Two closed sets that do not overlap are `comparableWith` (both text) and
    // still have no meet — the message has to explain that, or it reads as a
    // bug.
    const engine = engineOf();
    const disjoint = select(eq('status', 'p'), eq('region', 'p'));
    const conflict = engine.validateQuery(disjoint).list.find((x) => x.code === 'param.conflict')!;
    expect(conflict.message).toContain('are both text but share no value that satisfies both');
    expect(conflict.message).toContain('one of applied|screening (In screening)|hired');
  });
});

// ─── Pre-execution validation of supplied values ─────────────────────────────

describe('engine.checkParams — supplied values, checked before execution', () => {
  const codes = (p: { list: { code: string }[] }): string[] => p.list.map((x) => x.code);

  it('accepts a value that satisfies the merged type', () => {
    const engine = engineOf();
    expect(codes(engine.checkParams(select(eq('status', 'p'), eq('name', 'p')), { p: 'hired' }))).toEqual([]);
  });

  it('REFUSES a value that each use would have admitted but the MEET does not', () => {
    // `applied` is a member of `status` and `fired` is a member of `stage`;
    // neither is a member of the intersection, which is the whole requirement.
    const engine = engineOf();
    const def = select(eq('status', 'p'), eq('stage', 'p'));
    for (const value of ['applied', 'fired']) {
      const problems = engine.checkParams(def, { p: value }).list;
      expect(problems.map((x) => x.code)).toEqual(['param.value']);
      expect(problems[0]!.message).toContain(`Parameter 'p' was given "${value}"`);
      expect(problems[0]!.message).toContain('one of hired');
    }
    expect(codes(engine.checkParams(def, { p: 'hired' }))).toEqual([]);
  });

  it('REFUSES a value violating a bound that came from the OTHER use', () => {
    const engine = engineOf();
    const def = select(eq('code', 'p'), eq('slug', 'p'));
    // 12 chars: long enough for `code` (min 5), too long for `slug` (max 10).
    expect(codes(engine.checkParams(def, { p: 'abcdefghijkl' }))).toEqual(['param.value']);
    expect(codes(engine.checkParams(def, { p: 'abcdefg' }))).toEqual([]);
  });

  it('accepts NULL for any param — binding SQL NULL is a legitimate ask', () => {
    const engine = engineOf();
    expect(codes(engine.checkParams(select(eq('status', 'p')), { p: null }))).toEqual([]);
  });

  it('WARNS (never errors) on a missing value — an unbound param binds NULL on purpose', () => {
    const engine = engineOf();
    const problems = engine.checkParams(select(eq('status', 'p')), {}).list;
    expect(problems.map((x) => x.code)).toEqual(['param.missing']);
    expect(problems[0]!.severity).toBe('warning');
    expect(problems[0]!.message).toContain('one of applied|screening (In screening)|hired');
    // An explicitly-undefined entry is the same thing: `toSQL` binds NULL for it.
    expect(codes(engine.checkParams(select(eq('status', 'p')), { p: undefined }))).toEqual(['param.missing']);
  });

  it('WARNS on a value supplied under a name the query has no param for', () => {
    const engine = engineOf();
    const problems = engine.checkParams(select(eq('status', 'p')), { p: 'hired', typo: 1 }).list;
    expect(problems.map((x) => x.code)).toEqual(['param.unknown']);
    expect(problems[0]!.severity).toBe('warning');
    expect(problems[0]!.message).toContain('Its parameters are: p.');
    // …and says so plainly when the query takes none.
    expect(engine.checkParams(select(), { typo: 1 }).list[0]!.message).toContain('It takes no parameters.');
  });

  it('stands aside for a RELATION param — an identity may be a keyed object', () => {
    // What you bind to a relation is the target's IDENTITY: a scalar for a
    // single-column key, a `{ pk }` object for a composite one. The relation's
    // own value schema is a bare string, so checking against it would refuse
    // every legitimate composite binding — the same reason `validateWriteValue`
    // exempts a relation COLUMN from `write.type`.
    const fx = fixture();
    const update: UpdateDef = { kind: 'update', type: 'order', set: { userId: { kind: 'param', name: 'u' } } };
    expect(fx.engine.parameters(update)[0]!.category).toBe('relation');
    expect(codes(fx.engine.checkParams(update, { u: 'user-1' }))).toEqual([]);
    expect(codes(fx.engine.checkParams(update, { u: { id: 'user-1', tenant: 3 } }))).toEqual([]);
  });

  it('says NOTHING about a param whose uses conflict — `param.conflict` already did', () => {
    const engine = engineOf();
    expect(codes(engine.checkParams(select(eq('status', 'p'), eq('id', 'p')), { p: 'hired' }))).toEqual([]);
  });

  it('anchors each problem at the param’s first use, so a report can underline it', () => {
    const engine = engineOf();
    expect(engine.checkParams(select(eq('status', 'p')), { p: 'nope' }).list[0]!.path).toEqual(['where', 0, 'right']);
  });

  it('rides on validateQuery when values are supplied, and is silent when they are not', () => {
    const engine = engineOf();
    const def = select(eq('status', 'p'));
    expect(engine.validateQuery(def).list).toEqual([]);
    expect(codes(engine.validateQuery(def, undefined, undefined, { params: { p: 'nope' } }))).toEqual(['param.value']);
  });

  it('checks a value against a param used ONLY as a row bound', () => {
    const engine = engineOf();
    const paged: SelectDef = { ...select(), limit: { kind: 'param', name: 'take' } };
    expect(codes(engine.checkParams(paged, { take: 'lots' }))).toEqual(['param.value']);
    expect(codes(engine.checkParams(paged, { take: 25 }))).toEqual([]);
  });
});
