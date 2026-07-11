/**
 * date / temporal cases — add/subtract a duration, diff two dates, compare
 * (before/after/equal), extract a calendar part, and clamp/min-max of dates.
 *
 * Follows the EvalCase contract (see `types.ts`) and the `a` builder
 * (`assert.ts`): each case is a NL `request` to generate a gin function
 * `(args) => output`, proven by `a.produces(oracle)` over several `inputs`.
 *
 * PLAIN-VALUE SHAPES (what an oracle MUST return — verified against the harness's
 * `toPlain`, which is what outputs are compared as):
 *  - `date`      → a FULL ISO-8601 string at UTC midnight, e.g.
 *                  `"2020-01-15T00:00:00.000Z"` (NOT the trimmed `YYYY-MM-DD`;
 *                  the runtime is a JS `Date` and `toPlain` calls `toISOString()`).
 *  - `timestamp` → a full ISO-8601 string, e.g. `"2021-03-10T06:00:00.000Z"`.
 *  - `duration`  → a bare `number` of MILLISECONDS.
 *  - `num`/`bool`→ a plain number / boolean.
 *
 * DETERMINISM: every date/timestamp is an EXPLICIT input (never "now"), given as
 * a UTC ISO string so gin's UTC calendar math (`getUTC*` / `setUTC*` in
 * `src/natives/temporal.ts`) matches the JS oracle exactly. Inputs are chosen off
 * any DST edge and all-UTC, so there is no timezone ambiguity.
 *
 * GIN SEMANTICS the oracles mirror (from `src/natives/temporal.ts`):
 *  - `date.month` is 1-BASED (Jan = 1), unlike JS `getUTCMonth()`.
 *  - `date.diffDays(other)` = round((self − other) / 1 day): SELF minus OTHER.
 *  - `date.before/after` are STRICT (`<` / `>`); equal dates are neither.
 *  - `timestamp.addDuration(ms)` shifts by raw milliseconds (negative subtracts).
 *  - `timestamp.diff(other)` = self − other as a `duration` (ms);
 *    `duration.totalDays` = ms / 86_400_000 (fractional).
 */
import { a } from './assert';
import type { EvalCase, FnSpec } from './types';

// ════════════════════════════════════════════════════════════════════════════
// Shared constants + oracle helpers (documented, deterministic, UTC-only)
// ════════════════════════════════════════════════════════════════════════════

/** Milliseconds in one 24-hour day — the unit gin's day math divides by. */
const MS_PER_DAY = 86_400_000;

/**
 * The service-level-agreement offset (in days) that the intended `slaDueDate`
 * function HIDES from the model in the distractor case — unknowable unless the
 * model calls that specific function.
 */
const SLA_DAYS = 45;

/** Add `n` whole days to a UTC ISO date string; returns the resulting ISO string
 *  (mirrors `date.addDays`, which mutates via `setUTCDate`). */
function addUtcDays(iso: string, n: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString();
}

/** Move a UTC ISO date to the first day of its month (a distractor transform). */
function startOfUtcMonth(iso: string): string {
  const d = new Date(iso);
  d.setUTCDate(1);
  return d.toISOString();
}

/** A `{ date: date }` argument shape shared by every function in the SLA case. */
const DATE_ARG = { name: 'obj', props: { date: { type: { name: 'date' } } } } as const;

/**
 * The date-transform functions for the distractor case: one solver
 * (`slaDueDate`, which alone knows the +45-day SLA offset) and three distractors
 * that each apply a DIFFERENT, guessable transform.
 */
const slaFns: FnSpec[] = [
  {
    name: 'slaDueDate',
    args: DATE_ARG,
    returns: { name: 'date' },
    impl: (args) => addUtcDays(String(args['date']), SLA_DAYS),
    docs: 'Return the SLA due date for an order date (adds the fulfilment SLA window).',
    probe: { date: '2020-01-15' },
  },
  {
    name: 'nextDay',
    args: DATE_ARG,
    returns: { name: 'date' },
    impl: (args) => addUtcDays(String(args['date']), 1),
    docs: 'Return the day after the given date.',
    distractor: true,
    probe: { date: '2020-01-15' },
  },
  {
    name: 'addWeek',
    args: DATE_ARG,
    returns: { name: 'date' },
    impl: (args) => addUtcDays(String(args['date']), 7),
    docs: 'Return the date one week later.',
    distractor: true,
    probe: { date: '2020-01-15' },
  },
  {
    name: 'startOfMonth',
    args: DATE_ARG,
    returns: { name: 'date' },
    impl: (args) => startOfUtcMonth(String(args['date'])),
    docs: 'Return the first day of the given date\'s month.',
    distractor: true,
    probe: { date: '2020-01-15' },
  },
];

export const dateCases: EvalCase[] = [
  // ── 1. add days to a date (simple) ────────────────────────────────────────
  {
    id: 'date-add-days',
    category: 'date',
    request:
      'Given a date and a whole number of days, return the date that many days later. A negative count moves the date earlier.',
    note: 'Calendar add via addDays. Inputs cross a month AND a year boundary and include a negative offset, so a model that adds raw milliseconds to the wrong field, or ignores the sign, diverges.',
    argsType: {
      name: 'obj',
      props: { date: { type: { name: 'date' } }, days: { type: { name: 'num' } } },
    },
    returnType: { name: 'date' },
    inputs: [
      { date: '2020-01-15', days: 20 }, // → within-then-into February
      { date: '2019-12-25', days: 10 }, // → crosses into 2020
      { date: '2020-03-01', days: -1 }, // → back into February (leap year)
      { date: '2020-01-31', days: 1 }, //  → month rollover
    ],
    assert: [
      a.produces((args) => addUtcDays(String(args['date']), Number(args['days']))),
      a.returnsType('date'),
    ],
  },

  // ── 2. difference between two dates in days ────────────────────────────────
  {
    id: 'date-diff-days',
    category: 'date',
    request:
      'Given a `start` date and an `end` date, return the number of whole days from start to end. It is negative when end is before start, and 0 when they are the same day.',
    note: 'Direction matters: the answer is end − start (diffDays(self=end, other=start)). Swapping the operands flips the sign; equal dates must yield 0. Inputs span a month, a year, and an equal pair.',
    argsType: {
      name: 'obj',
      props: { start: { type: { name: 'date' } }, end: { type: { name: 'date' } } },
    },
    returnType: { name: 'num' },
    inputs: [
      { start: '2021-01-10', end: '2021-01-25' }, // +15
      { start: '2021-01-31', end: '2021-03-01' }, // +29 (crosses Feb, non-leap)
      { start: '2020-12-28', end: '2021-01-04' }, // +7 across year boundary
      { start: '2021-06-15', end: '2021-06-15' }, // 0 (equal)
      { start: '2021-05-10', end: '2021-05-01' }, // -9 (end before start)
    ],
    assert: [
      a.produces((args) =>
        Math.round((new Date(String(args['end'])).getTime() - new Date(String(args['start'])).getTime()) / MS_PER_DAY),
      ),
      a.returnsType('num'),
    ],
  },

  // ── 3. compare two dates: is A strictly before B (bool) ────────────────────
  {
    id: 'date-is-before',
    category: 'date',
    request:
      'Given two dates `a` and `b`, return true when `a` falls strictly before `b`, and false otherwise (including when they are the same date).',
    note: 'Strict before. Returning `a.after(b)` inverts it; using a non-strict comparison would wrongly return true for the equal pair. Inputs cover before, after, and equal.',
    argsType: {
      name: 'obj',
      props: { a: { type: { name: 'date' } }, b: { type: { name: 'date' } } },
    },
    returnType: { name: 'bool' },
    inputs: [
      { a: '2022-02-01', b: '2022-03-01' }, // before → true
      { a: '2022-05-20', b: '2022-05-19' }, // after  → false
      { a: '2022-07-04', b: '2022-07-04' }, // equal  → false
      { a: '2019-12-31', b: '2020-01-01' }, // before across year → true
    ],
    assert: [
      a.produces((args) => new Date(String(args['a'])).getTime() < new Date(String(args['b'])).getTime()),
      a.returnsType('bool'),
    ],
  },

  // ── 4. extract a calendar part: the month (1-based) ────────────────────────
  {
    id: 'date-extract-month',
    category: 'date',
    request:
      'Given a date, return its calendar month as a number from 1 (January) to 12 (December).',
    note: 'Part extraction. gin `date.month` is 1-based; a model that leaks JS `getUTCMonth()` (0-based) is off by one — the January and December inputs make that unmistakable.',
    argsType: { name: 'obj', props: { date: { type: { name: 'date' } } } },
    returnType: { name: 'num' },
    inputs: [
      { date: '2023-01-15' }, // 1
      { date: '2023-12-31' }, // 12
      { date: '2023-07-04' }, // 7
      { date: '2023-02-28' }, // 2
    ],
    assert: [
      a.produces((args) => new Date(String(args['date'])).getUTCMonth() + 1),
      a.returnsType('num'),
    ],
  },

  // ── 5. clamp a date into [lo, hi] (min/max of dates, harder) ───────────────
  {
    id: 'date-clamp',
    category: 'date',
    request:
      'Given a `value` date and an inclusive range [`lo`, `hi`], return the value clamped into the range: return `lo` when the value is before `lo`, `hi` when it is after `hi`, otherwise the value unchanged.',
    note: 'Clamp = max(lo, min(hi, value)). Two boundary comparisons plus a conditional. Returning the value unclamped fails the out-of-range inputs; clamping to the wrong bound fails the below/above split. Values on a bound must pass through unchanged.',
    argsType: {
      name: 'obj',
      props: {
        value: { type: { name: 'date' } },
        lo: { type: { name: 'date' } },
        hi: { type: { name: 'date' } },
      },
    },
    returnType: { name: 'date' },
    inputs: [
      { value: '2024-01-01', lo: '2024-02-01', hi: '2024-11-30' }, // below → lo
      { value: '2024-12-25', lo: '2024-02-01', hi: '2024-11-30' }, // above → hi
      { value: '2024-06-15', lo: '2024-02-01', hi: '2024-11-30' }, // within → value
      { value: '2024-02-01', lo: '2024-02-01', hi: '2024-11-30' }, // on lo → value
    ],
    assert: [
      a.produces((args) => {
        const value = new Date(String(args['value']));
        const lo = new Date(String(args['lo']));
        const hi = new Date(String(args['hi']));
        const clamped = value < lo ? lo : value > hi ? hi : value;
        return clamped.toISOString();
      }),
      a.returnsType('date'),
    ],
  },

  // ── 6. add/subtract a duration to a timestamp ──────────────────────────────
  {
    id: 'timestamp-add-duration',
    category: 'date',
    request:
      'Given a `when` timestamp and a `delta` duration, return the timestamp shifted forward by the duration. A negative duration shifts it backward.',
    note: 'Duration arithmetic on the `timestamp` type (addDuration adds raw milliseconds). The negative-delta input covers the subtract direction; a model that ignores the sign or drops the sub-day part fails. Inputs cross a month and a year boundary.',
    argsType: {
      name: 'obj',
      props: { when: { type: { name: 'timestamp' } }, delta: { type: { name: 'duration' } } },
    },
    returnType: { name: 'timestamp' },
    inputs: [
      { when: '2021-03-10T06:00:00.000Z', delta: MS_PER_DAY }, //          +1 day
      { when: '2021-01-31T12:00:00.000Z', delta: MS_PER_DAY }, //          crosses into February
      { when: '2021-12-31T23:00:00.000Z', delta: 3_600_000 }, //           +1h crosses into 2022
      { when: '2021-03-10T06:00:00.000Z', delta: -21_600_000 }, //         −6h (subtract)
    ],
    assert: [
      a.produces((args) =>
        new Date(new Date(String(args['when'])).getTime() + Number(args['delta'])).toISOString(),
      ),
      a.returnsType('timestamp'),
    ],
  },

  // ── 7. fns-with-distractors: SLA due date (hidden offset) ──────────────────
  {
    id: 'date-sla-due-distractors',
    category: 'date',
    request:
      'Given an order date, return the SLA due date for the order. Use the provided SLA function — the size of the SLA window is not something you should assume.',
    note: 'Distractor gauntlet of date transforms: only `slaDueDate` knows the +45-day window. Calling nextDay (+1), addWeek (+7), or startOfMonth, or inlining a guessed offset, produces the wrong date. `usesFn(slaDueDate)` is a required gate because the window is unknowable otherwise.',
    fns: slaFns,
    argsType: { name: 'obj', props: { orderDate: { type: { name: 'date' } } } },
    returnType: { name: 'date' },
    inputs: [
      { orderDate: '2020-01-15' }, // → 2020-02-29 (leap Feb)
      { orderDate: '2020-11-20' }, // → crosses into January 2021
      { orderDate: '2021-06-01' }, // → mid-July
    ],
    assert: [
      // The +45-day window is hidden in the fn, so calling it is genuinely mandatory.
      a.require(a.usesFn('slaDueDate')),
      a.produces((args) => addUtcDays(String(args['orderDate']), SLA_DAYS)),
      a.returnsType('date'),
    ],
  },

  // ── 8. custom-type: Event span in days (fractional; hardest) ───────────────
  {
    id: 'date-event-span-days',
    category: 'date',
    request:
      'Given an Event with a `start` and `end` timestamp, return how many days long it is (end minus start, expressed in days). Partial days count as fractions, e.g. 12 hours is 0.5.',
    note: 'Custom `Event` type plus a two-step chain: diff the timestamps to a duration, then read totalDays (fractional). Rounding to whole days, or reversing start/end, fails the half-day and equal inputs. Uses a numeric tolerance because totalDays is floating.',
    setup: (registry) => {
      // Extend a STRUCTURAL obj base (not the bare 'obj' name) so the custom
      // `Event` type actually parses its `start`/`end` fields: an Extension's
      // `parse` delegates to its base, and only a base built from
      // `registry.obj({...})` carries the structural props.
      const Event = registry.extend(
        registry.obj({
          start: { type: registry.timestamp() },
          end: { type: registry.timestamp() },
        }),
        { name: 'Event', docs: 'A scheduled event with a start and end instant.' },
      );
      registry.register(Event);
      return [Event];
    },
    argsType: { name: 'obj', props: { event: { type: { name: 'Event' } } } },
    returnType: { name: 'num' },
    inputs: [
      { event: { start: '2022-06-01T00:00:00.000Z', end: '2022-06-03T12:00:00.000Z' } }, // 2.5
      { event: { start: '2022-01-30T00:00:00.000Z', end: '2022-02-02T06:00:00.000Z' } }, // 3.25 (crosses month)
      { event: { start: '2021-12-31T12:00:00.000Z', end: '2022-01-01T12:00:00.000Z' } }, // 1 (crosses year)
      { event: { start: '2022-05-05T09:00:00.000Z', end: '2022-05-05T09:00:00.000Z' } }, // 0 (equal)
    ],
    assert: [
      a.produces((args) => {
        const event = (args['event'] ?? {}) as { start: string; end: string };
        return (new Date(event.end).getTime() - new Date(event.start).getTime()) / MS_PER_DAY;
      }, { tolerance: 1e-9 }),
      a.returnsType('num'),
    ],
  },
];
