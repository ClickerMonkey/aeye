/**
 * num / math cases — arithmetic, rounding, min/max, clamp, gcd, list
 * aggregation, and a loop-based reduction. Each case is an NL `request` to
 * generate a gin function `(args) => output`, proven by `a.produces(oracle)`
 * over several `inputs` (see `types.ts` / `assert.ts`).
 *
 * Two of the eight cases exercise the harder surfaces the seed files model:
 *  - `num-currency-convert` is a fns-with-DISTRACTORS case whose intended
 *    `toEur` hides an un-guessable FX rate (copied shape from `functions.ts`);
 *    it is ALSO the CUSTOM-TYPE case — its arg is a registered `Money` obj.
 *  - `num-gcd`      is the LOOP-based one (Euclid's algorithm).
 *
 * Every oracle is a trivial, obviously-correct plain-JS function over the raw
 * input; the diverse inputs (0, negatives, empty list) defeat a hard-coded
 * answer, and the `note` names the near-miss a wrong construct would produce.
 */
import { a } from './assert';
import type { EvalCase, FnSpec } from './types';

/** The EUR-per-USD rate the intended `toEur` function hides from the model. */
const EUR_RATE = 0.9137;
/** A distractor GBP rate — close enough to tempt, wrong enough to fail. */
const GBP_RATE = 0.7845;

/** `{ amount: num }` — the single argument every currency fn in the case takes. */
const AMOUNT_ARG = { name: 'obj', props: { amount: { type: { name: 'num' } } } } as const;

/** One solver (`toEur`) + three distractors for the conversion case. */
const currencyFns: FnSpec[] = [
  {
    name: 'toEur',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Number(args['amount']) * EUR_RATE,
    docs: 'Convert a USD amount to EUR at today\'s locked-in rate',
    probe: { amount: 100 },
  },
  {
    name: 'toGbp',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Number(args['amount']) * GBP_RATE,
    docs: 'Convert a USD amount to GBP at today\'s rate',
    distractor: true,
    probe: { amount: 100 },
  },
  {
    name: 'applyVat',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Number(args['amount']) * 1.2,
    docs: 'Add 20% VAT to an amount',
    distractor: true,
    probe: { amount: 100 },
  },
  {
    name: 'roundCents',
    args: AMOUNT_ARG,
    returns: { name: 'num' },
    impl: (args) => Math.round(Number(args['amount']) * 100) / 100,
    docs: 'Round an amount to whole cents',
    distractor: true,
    probe: { amount: 1.239 },
  },
];

/** Euclid's algorithm over the ABSOLUTE values — the oracle for `num-gcd`. */
function gcd(x: number, y: number): number {
  let a = Math.abs(x);
  let b = Math.abs(y);
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

export const numCases: EvalCase[] = [
  // ── 1. arithmetic (add) — the simplest possible case ──────────────────────
  {
    id: 'num-add-two',
    category: 'num',
    request: 'Given two numbers `a` and `b`, return their sum.',
    note: 'Plain arithmetic add. Returning `a`, the product, or the difference passes the first input but the negative / fractional inputs expose it.',
    argsType: { name: 'obj', props: { a: { type: { name: 'num' } }, b: { type: { name: 'num' } } } },
    returnType: { name: 'num' },
    inputs: [
      { a: 2, b: 3 },
      { a: -5, b: 5 },
      { a: 1.5, b: 2.25 },
    ],
    assert: [
      a.produces((args) => Number(args['a']) + Number(args['b'])),
      a.returnsType('num'),
    ],
  },

  // ── 2. abs (+ sub) — absolute difference ──────────────────────────────────
  {
    id: 'num-abs-diff',
    category: 'num',
    request: 'Given two numbers `a` and `b`, return the absolute value of their difference (how far apart they are).',
    note: 'abs-of-subtraction. `a - b` (unsigned) gives a negative when b > a; the reversed / equal inputs make the sign error visible.',
    argsType: { name: 'obj', props: { a: { type: { name: 'num' } }, b: { type: { name: 'num' } } } },
    returnType: { name: 'num', options: { min: 0 } },
    inputs: [
      { a: 3, b: 10 },
      { a: -4, b: -9 },
      { a: 5, b: 5 },
    ],
    assert: [
      a.produces((args) => Math.abs(Number(args['a']) - Number(args['b']))),
      a.returnsType('num'),
    ],
  },

  // ── 3. round / floor / ceil — round to the nearest integer ────────────────
  {
    id: 'num-round-nearest',
    category: 'num',
    request: 'Given a number `x`, round it to the nearest whole number.',
    note: 'Rounding (not floor / ceil / truncate). floor(2.8)=2 and ceil(2.3)=3 both diverge from round on the mixed inputs; the whole-number return type also rejects passing `x` through unrounded.',
    argsType: { name: 'obj', props: { x: { type: { name: 'num' } } } },
    returnType: { name: 'num', options: { whole: true } },
    // Inputs avoid exact `.5` ties so the answer is unambiguous regardless of
    // half-rounding convention.
    inputs: [
      { x: 2.3 },
      { x: 2.8 },
      { x: -1.6 },
    ],
    assert: [
      a.produces((args) => Math.round(Number(args['x']))),
      a.returnsType('num'),
    ],
  },

  // ── 4. clamp — constrain x to [lo, hi] ────────────────────────────────────
  {
    id: 'num-clamp-range',
    category: 'num',
    request: 'Given a number `x` and a range `lo`..`hi`, return `x` clamped into that range: `lo` if `x` is below it, `hi` if above, otherwise `x` unchanged.',
    note: 'Two-sided clamp. Applying only a floor (max with lo) leaks the above-range input; only a ceiling (min with hi) leaks the below-range one. Inputs hit below / inside / above.',
    argsType: {
      name: 'obj',
      props: { x: { type: { name: 'num' } }, lo: { type: { name: 'num' } }, hi: { type: { name: 'num' } } },
    },
    returnType: { name: 'num' },
    inputs: [
      { x: 5, lo: 0, hi: 10 },
      { x: -3, lo: 0, hi: 10 },
      { x: 99, lo: 0, hi: 10 },
    ],
    assert: [
      a.produces((args) => Math.min(Math.max(Number(args['x']), Number(args['lo'])), Number(args['hi']))),
      a.returnsType('num'),
    ],
  },

  // ── 5. min / max — spread (largest minus smallest) ────────────────────────
  {
    id: 'num-range-spread',
    category: 'num',
    request: 'Given three numbers `a`, `b`, and `c`, return the spread: the largest of the three minus the smallest.',
    note: 'Exercises BOTH max and min over three values. Using only two of the three, or subtracting in the wrong order, fails on the all-negative / all-equal inputs.',
    argsType: {
      name: 'obj',
      props: { a: { type: { name: 'num' } }, b: { type: { name: 'num' } }, c: { type: { name: 'num' } } },
    },
    returnType: { name: 'num', options: { min: 0 } },
    inputs: [
      { a: 3, b: 7, c: 1 },
      { a: -5, b: -1, c: -9 },
      { a: 4, b: 4, c: 4 },
    ],
    assert: [
      a.produces((args) => {
        const xs = [Number(args['a']), Number(args['b']), Number(args['c'])];
        return Math.max(...xs) - Math.min(...xs);
      }),
      a.returnsType('num'),
    ],
  },

  // ── 6. sum / average over a list<num> ─────────────────────────────────────
  {
    id: 'num-average-list',
    category: 'num',
    request: 'Given a list of numbers `values`, return their arithmetic mean (the sum divided by the count). An empty list averages to 0.',
    note: 'Reduce-then-divide. Returning the sum (skipping the divide), or dividing by a wrong count, diverges on the multi-element inputs; the empty list must be guarded to avoid a divide-by-zero.',
    argsType: {
      name: 'obj',
      props: { values: { type: { name: 'list', generic: { V: { name: 'num' } } } } },
    },
    returnType: { name: 'num' },
    inputs: [
      { values: [2, 4, 6] },
      { values: [] },
      { values: [10, -4, 3] },
      { values: [5] },
    ],
    assert: [
      a.produces((args) => {
        const values = (args['values'] ?? []) as ReadonlyArray<number>;
        if (values.length === 0) return 0;
        return values.reduce((s, n) => s + n, 0) / values.length;
      }),
      a.returnsType('num'),
    ],
  },

  // ── 7. loop-based — greatest common divisor (Euclid) ──────────────────────
  {
    id: 'num-gcd',
    category: 'num',
    request: 'Given two whole numbers `a` and `b`, return their greatest common divisor (the largest whole number that divides both). gcd(n, 0) is n.',
    note: 'Loop-based (Euclid): repeatedly replace (a, b) with (b, a mod b) until b is 0. A single mod / div, or returning min(a, b), only coincidentally matches; the coprime and zero inputs break those shortcuts.',
    argsType: {
      name: 'obj',
      props: {
        a: { type: { name: 'num', options: { whole: true } } },
        b: { type: { name: 'num', options: { whole: true } } },
      },
    },
    returnType: { name: 'num', options: { whole: true, min: 0 } },
    inputs: [
      { a: 12, b: 18 },
      { a: 17, b: 5 },
      { a: 48, b: 36 },
      { a: 9, b: 0 },
    ],
    assert: [
      a.produces((args) => gcd(Number(args['a']), Number(args['b']))),
      a.returnsType('num'),
      // Euclid needs iteration; a `loop` (or self-`recurse`) is the natural shape.
      a.warn(a.usesKind('loop')),
    ],
  },

  // ── 8. custom type + fns-with-distractors — USD → EUR conversion ──────────
  {
    id: 'num-currency-convert',
    category: 'num',
    request: 'Given a `Money` value in USD, return the equivalent amount in EUR. Use the provided conversion function — the exchange rate is not something you should assume.',
    note: 'Custom `Money` type PLUS a distractor gauntlet: only `toEur` knows the FX rate. Guessing a rate, or calling toGbp / applyVat / roundCents, produces the wrong number. `usesFn(toEur)` is a required gate because the rate is unknowable otherwise.',
    setup: (registry) => {
      // Extend a STRUCTURAL `obj({...})` base — `extend('obj', {props})` drops
      // the fields at runtime (parse delegates to the empty base).
      const Money = registry.extend(
        registry.obj({ amount: { type: registry.num() }, currency: { type: registry.text() } }),
        { name: 'Money', docs: 'A monetary amount in a given currency.' },
      );
      registry.register(Money);
      return [Money];
    },
    fns: currencyFns,
    argsType: { name: 'obj', props: { money: { type: { name: 'Money' } } } },
    returnType: { name: 'num' },
    inputs: [
      { money: { amount: 100, currency: 'USD' } },
      { money: { amount: 0, currency: 'USD' } },
      { money: { amount: 49.99, currency: 'USD' } },
    ],
    assert: [
      // The rate is hidden in the fn, so calling it is genuinely mandatory.
      a.require(a.usesFn('toEur')),
      a.produces((args) => {
        const m = (args['money'] ?? {}) as { amount: number };
        return m.amount * EUR_RATE;
      }),
      a.returnsType('num'),
    ],
  },
];
