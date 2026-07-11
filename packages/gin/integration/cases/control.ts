/**
 * CONTROL-FLOW cases — branching (`if` / `switch`) and iteration (`loop`,
 * with accumulation, an inner conditional, and bounded early-exit search).
 *
 * Each case is an NL `request` to generate a gin function `(args) => output`,
 * proven by a plain-JS `a.produces(oracle)` over several `inputs` chosen to
 * exercise EVERY branch / boundary — a model that handles only one arm (returns a
 * constant, forgets the `else`, skips the accumulator) fails at least one input.
 * `a.usesKind('if'|'switch'|'loop')` is attached as an advisory (`warn`) note of
 * the intended construct; it never fails a case that reaches the right outputs a
 * different way. See `types.ts` for the contract and `assert.ts` for `a`.
 */
import { a } from './assert';
import type { EvalCase, FnSpec } from './types';

// ════════════════════════════════════════════════════════════════════════════
// Shared constants + oracles
// ════════════════════════════════════════════════════════════════════════════

/**
 * Weekday name for an ISO day-of-week number (1 = Monday … 7 = Sunday). The
 * switch oracle indexes this; index 0 is a placeholder so the 1-based `day`
 * lands on the right name.
 */
const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** User-facing label for each `ShipmentStatus` enum member (drives the switch). */
const STATUS_LABELS: Record<string, string> = {
  pending: 'Awaiting fulfillment',
  shipped: 'On its way',
  delivered: 'Delivered',
  cancelled: 'Order cancelled',
};

/**
 * The set of blocked usernames the `isBanned` predicate hides. It is genuinely
 * unknowable to the model — the ONLY way to get the right answer is to call the
 * function rather than guess who is banned. The oracle shares this exact set.
 */
const BANNED_USERS = new Set(['mallory', 'trudy', 'eve']);

/** One-integer number arg shared by the access-guard predicate fns. */
const USER_ARG = { name: 'obj', props: { user: { type: { name: 'text' } } } } as const;

/**
 * Branch-predicate gauntlet: three `text -> bool` classifiers, only `isBanned`
 * answers the request. The other two are plausible-but-wrong access checks; a
 * model that calls them (or inlines a guessed ban-list) produces the wrong label.
 */
const guardFns: FnSpec[] = [
  {
    name: 'isBanned',
    args: USER_ARG,
    returns: { name: 'bool' },
    impl: (args) => BANNED_USERS.has(String(args['user'])),
    docs: 'True if the username is on the banned list (the list is not public — you cannot guess it)',
    probe: { user: 'mallory' },
  },
  {
    name: 'isPremium',
    args: USER_ARG,
    returns: { name: 'bool' },
    impl: (args) => String(args['user']).startsWith('vip_'),
    docs: 'True if the user has a premium subscription',
    distractor: true,
    probe: { user: 'vip_carol' },
  },
  {
    name: 'isAdmin',
    args: USER_ARG,
    returns: { name: 'bool' },
    impl: (args) => String(args['user']) === 'root',
    docs: 'True if the user is an administrator',
    distractor: true,
    probe: { user: 'root' },
  },
];

export const controlCases: EvalCase[] = [
  // ── if/else: sign of a number ────────────────────────────────────────────
  {
    id: 'control-sign',
    category: 'control',
    request:
      'Given a number `n`, return -1 if it is negative, 0 if it is exactly zero, and 1 if it is positive.',
    note: 'Three-way if/else on sign. Inputs cross every arm (negative, zero, positive, fractional); a model that returns the number itself, or only handles two arms, fails at zero or on the fractional inputs.',
    argsType: { name: 'obj', props: { n: { type: { name: 'num' } } } },
    returnType: { name: 'num' },
    inputs: [{ n: -5 }, { n: 0 }, { n: 7 }, { n: -0.5 }, { n: 3.2 }],
    assert: [
      a.produces((args) => {
        const n = Number(args['n']);
        return n < 0 ? -1 : n > 0 ? 1 : 0;
      }),
      a.usesKind('if'),
    ],
  },

  // ── if / else-if chain: letter grade from a score ────────────────────────
  {
    id: 'control-grade',
    category: 'control',
    request:
      "Convert a numeric exam score (0-100) to a letter grade: 90 or above is 'A', 80-89 is 'B', 70-79 is 'C', 60-69 is 'D', and anything below 60 is 'F'.",
    note: 'if / else-if ladder with ordered thresholds. Inputs sit ON the boundaries (90, 80, 70, 60) and just below, so an off-by-one comparison (`>` vs `>=`) or a wrong band order is caught.',
    argsType: { name: 'obj', props: { score: { type: { name: 'num', options: { min: 0, max: 100 } } } } },
    returnType: { name: 'text' },
    inputs: [{ score: 95 }, { score: 90 }, { score: 82 }, { score: 80 }, { score: 71 }, { score: 60 }, { score: 45 }, { score: 100 }, { score: 0 }],
    assert: [
      a.produces((args) => {
        const s = Number(args['score']);
        if (s >= 90) return 'A';
        if (s >= 80) return 'B';
        if (s >= 70) return 'C';
        if (s >= 60) return 'D';
        return 'F';
      }),
      a.usesKind('if'),
    ],
  },

  // ── switch: weekday name from an ISO day number ──────────────────────────
  {
    id: 'control-weekday',
    category: 'control',
    request:
      'Given a day-of-week number where 1 is Monday and 7 is Sunday, return the English weekday name.',
    note: 'switch on a small integer domain. All seven inputs are supplied, so every case body must be present and mapped to the correct name — a partial or off-by-one mapping fails immediately.',
    argsType: { name: 'obj', props: { day: { type: { name: 'num', options: { whole: true, min: 1, max: 7 } } } } },
    returnType: { name: 'text' },
    inputs: [{ day: 1 }, { day: 2 }, { day: 3 }, { day: 4 }, { day: 5 }, { day: 6 }, { day: 7 }],
    assert: [
      a.produces((args) => WEEKDAYS[Number(args['day'])]),
      a.usesKind('switch'),
    ],
  },

  // ── loop accumulation: sum 1..n ──────────────────────────────────────────
  {
    id: 'control-sum-to-n',
    category: 'control',
    request:
      'Given a non-negative whole number `n`, return the sum of all integers from 1 to n inclusive. If n is 0, the sum is 0.',
    note: 'Loop accumulation into a running total. Inputs include the empty case (0), the singleton (1), and larger n; a model that returns n itself, or n*(n-1)/2, or forgets to include n, diverges on at least one.',
    argsType: { name: 'obj', props: { n: { type: { name: 'num', options: { whole: true, min: 0 } } } } },
    returnType: { name: 'num' },
    inputs: [{ n: 0 }, { n: 1 }, { n: 5 }, { n: 10 }, { n: 100 }],
    assert: [
      a.produces((args) => {
        const n = Number(args['n']);
        let sum = 0;
        for (let i = 1; i <= n; i++) sum += i;
        return sum;
      }),
      a.usesKind('loop'),
    ],
  },

  // ── loop + inner conditional: fizzbuzz classification ────────────────────
  {
    id: 'control-fizzbuzz',
    category: 'control',
    request:
      "Given a whole number `n` (at least 1), return a list of strings for the numbers 1 through n: use 'FizzBuzz' for multiples of both 3 and 5, 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, and otherwise the number itself as a string.",
    note: 'Loop building a list with a nested branch per element. The multiple-of-15 case must be tested BEFORE 3 and 5 — inputs 15 and 16 catch a model that orders the checks wrong or emits the raw number where a word is due.',
    argsType: { name: 'obj', props: { n: { type: { name: 'num', options: { whole: true, min: 1 } } } } },
    returnType: { name: 'list', generic: { V: { name: 'text' } } },
    inputs: [{ n: 1 }, { n: 3 }, { n: 5 }, { n: 15 }, { n: 16 }],
    assert: [
      a.produces((args) => {
        const n = Number(args['n']);
        const out: string[] = [];
        for (let i = 1; i <= n; i++) {
          if (i % 15 === 0) out.push('FizzBuzz');
          else if (i % 3 === 0) out.push('Fizz');
          else if (i % 5 === 0) out.push('Buzz');
          else out.push(String(i));
        }
        return out;
      }),
      a.usesKind('loop'),
    ],
  },

  // ── bounded search / early exit: first index at/above a threshold ────────
  {
    id: 'control-first-index',
    category: 'control',
    request:
      'Given a list of numbers `nums` and a `target`, return the index of the FIRST element that is greater than or equal to target. Return -1 if no element qualifies.',
    note: 'Early-exit search: stop at the first match, not the last, and not a count. Inputs place the match at the front, in the middle, absent entirely, and in an empty list — a model that returns the last matching index, a boolean, or scans without stopping fails.',
    argsType: {
      name: 'obj',
      props: {
        nums: { type: { name: 'list', generic: { V: { name: 'num' } } } },
        target: { type: { name: 'num' } },
      },
    },
    returnType: { name: 'num' },
    inputs: [
      { nums: [5, 1, 9, 2], target: 4 },
      { nums: [1, 2, 3, 8, 4], target: 8 },
      { nums: [1, 2, 3], target: 10 },
      { nums: [], target: 0 },
      { nums: [7, 7, 7], target: 7 },
    ],
    assert: [
      a.produces((args) => {
        const nums = (args['nums'] ?? []) as ReadonlyArray<number>;
        const target = Number(args['target']);
        for (let i = 0; i < nums.length; i++) {
          if (nums[i]! >= target) return i;
        }
        return -1;
      }),
      a.usesKind('loop'),
    ],
  },

  // ── custom-type switch: enum status → user-facing label ──────────────────
  {
    id: 'control-status-label',
    category: 'control',
    request:
      "A shipment has a `status` which is one of pending, shipped, delivered, or cancelled. Return the customer-facing label for it: pending -> 'Awaiting fulfillment', shipped -> 'On its way', delivered -> 'Delivered', cancelled -> 'Order cancelled'.",
    note: 'switch over a registered enum type (ShipmentStatus). Each of the four members is supplied as an input, so the case body for every status must map to its exact label — a missing case or a mislabeled member fails.',
    setup: (registry) => {
      // Build the enum first, then NAME it via an extension so it shows up in the
      // prompt's type docs and is referenceable as `{ name: 'ShipmentStatus' }`.
      const base = registry.enum(
        { pending: 'pending', shipped: 'shipped', delivered: 'delivered', cancelled: 'cancelled' },
        registry.text(),
      );
      const ShipmentStatus = registry.extend(base, {
        name: 'ShipmentStatus',
        docs: 'The lifecycle state of a shipment.',
      });
      registry.register(ShipmentStatus);
      return [ShipmentStatus];
    },
    argsType: { name: 'obj', props: { status: { type: { name: 'ShipmentStatus' } } } },
    returnType: { name: 'text' },
    inputs: [{ status: 'pending' }, { status: 'shipped' }, { status: 'delivered' }, { status: 'cancelled' }],
    assert: [
      a.produces((args) => STATUS_LABELS[String(args['status'])]),
      a.usesKind('switch'),
      a.returnsType('text'),
    ],
  },

  // ── fns-with-distractors: branch predicate gates a condition ─────────────
  {
    id: 'control-access-guard',
    category: 'control',
    request:
      "Given a `user` name, return 'denied' if the user is banned, otherwise return 'allowed'. Use the provided ban check — you cannot know who is banned on your own.",
    note: 'Distractor gauntlet of branch predicates: only `isBanned` decides the condition; the ban-list is hidden, so guessing or calling isPremium / isAdmin gives the wrong verdict for at least one input. `usesFn(isBanned)` is a required gate because the predicate is genuinely load-bearing.',
    fns: guardFns,
    argsType: { name: 'obj', props: { user: { type: { name: 'text' } } } },
    returnType: { name: 'text' },
    inputs: [{ user: 'mallory' }, { user: 'alice' }, { user: 'eve' }, { user: 'vip_carol' }, { user: 'root' }],
    assert: [
      // The ban-list lives inside the fn, so calling it is genuinely mandatory.
      a.require(a.usesFn('isBanned')),
      a.produces((args) => (BANNED_USERS.has(String(args['user'])) ? 'denied' : 'allowed')),
      a.usesKind('if'),
    ],
  },
];
