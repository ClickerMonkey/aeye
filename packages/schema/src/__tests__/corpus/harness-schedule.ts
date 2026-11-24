/**
 * CORPUS: the schedule system (E:\GitHub\harness\systems\schedule), ported to `a`.
 *
 * Sources:
 * - shared/types.ts: LocalDay, ClockTime, OccurrenceKey (patterned, branded), Zone (refined with Intl, branded),
 *   Every (strict), `When` (strict, ~20 optional day rules, `superRefine(whenProblems)`), SchedulePayload (strict; `args`
 *   a gin program over `fire` and `previous`), Fire, PreviousFiring;
 * - shared/index.ts: the fns' args (`AddArgs`, `ChangeArgs` = schedule + `partialOf(Settings)`, `skip`, `pause`) with
 *   their real examples, and the `Limits` config (gin decl);
 * - server/authoring.ts: the args authoring draft (`{ program }`, a gin Expr over the session's bound types) and its
 *   worked examples (`ARGS_EXAMPLES`).
 *
 * zod → `a`: `.superRefine` adding one issue per problem → one `.refine` returning the problems as one message (GAP
 * superRefine: one issue per problem); `.default(x)` → `.default(x)`; `ginAs(When)` is gone — the fns' args
 * use the `a` schemas directly, so the model sees the patterns and rules gin's conversion drops.
 */
import { expectTypeOf } from 'expect-type';
import { a, type Brand, type JsonValue } from '../../index';
import { Grammar, type ExprT, type ProgramSessionLike, type TypeDefT } from './harness-grammar';
import { fnNameOf, QualifiedName, withFnNames, type ModelFnNamesLike } from './harness-fns';

// ============================================================================
// shared/types.ts
// ============================================================================

/** types.ts:13 */
export const LocalDay = a.string().pattern(/^\d{4}-\d{2}-\d{2}$/).brand<'LocalDay'>();
export type LocalDay = a.infer<typeof LocalDay>;
/** types.ts:16 */
export const ClockTime = a.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).brand<'ClockTime'>();
export type ClockTime = a.infer<typeof ClockTime>;
/** types.ts:19 */
export const OccurrenceKey = a.string().pattern(/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/).brand<'OccurrenceKey'>();
export type OccurrenceKey = a.infer<typeof OccurrenceKey>;

/** zoned.ts:20 `isIanaZone` (dayspan's `TimeZone.isValid`): a named zone Intl knows; offsets refused. */
export function isIanaZone(zone: string): boolean {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
/** types.ts:22 `z.string().refine(isIanaZone, 'an IANA time zone, such as America/New_York').brand<'Zone'>()`. */
export const Zone = a.string().refine(isIanaZone, 'an IANA time zone, such as America/New_York').brand<'Zone'>();
export type Zone = a.infer<typeof Zone>;
/** types.ts:25 */
export const Every = a.object({ every: a.int().min(1), offset: a.int().min(0).optional() }).strict();

/** types.ts:28 `days(min, max)` */
const days = (min: number, max: number) => a.array(a.int().min(min).max(max)).min(1).optional();

/** types.ts:31 */
export const DAY_RULES = [
  'dayOfWeek', 'dayOfMonth', 'lastDayOfMonth', 'weekspanOfMonth', 'lastWeekspanOfMonth', 'weekOfMonth', 'weekOfYear', 'month', 'year',
  'daysSinceEpoch', 'weeksSinceEpoch', 'monthsSinceEpoch',
] as const;
type WhenFields = Partial<Record<(typeof DAY_RULES)[number], unknown>> & {
  readonly on?: string | undefined; readonly start?: string | undefined; readonly end?: string | undefined;
  readonly maxOccurrences?: number | undefined; readonly times?: readonly string[] | undefined;
};

/** types.ts:50 `whenRuleProblems`, verbatim. */
export function whenRuleProblems(when: WhenFields): string[] {
  const problems: string[] = [];
  const rules = DAY_RULES.filter((rule) => when[rule] !== undefined);
  if (when.on !== undefined && rules.length > 0) {
    problems.push(`\`on\` is a one-off, so it can't have day rules too (${rules.join(', ')}): give \`on\`, or the rules.`);
  }
  if (when.on !== undefined && (when.start !== undefined || when.end !== undefined || when.maxOccurrences !== undefined)) {
    problems.push('`on` is a one-off, so it has no `start`, `end` or `maxOccurrences`.');
  }
  if (when.maxOccurrences !== undefined && when.start === undefined) {
    problems.push('`maxOccurrences` counts from `start`, so it needs `start`.');
  }
  if (when.start !== undefined && when.end !== undefined && when.start > when.end) {
    problems.push(`\`start\` (${when.start}) is after \`end\` (${when.end}).`);
  }
  const seen = new Set<string>();
  for (const time of when.times ?? []) {
    if (seen.has(time)) problems.push(`${time} is in \`times\` twice.`);
    seen.add(time);
  }
  return problems;
}

/** The rules, as the model is told them (`When`'s doc comment, types.ts:103). */
export const WHEN_RULES = '`on` or day rules, not both; `maxOccurrences` needs `start`; `start` ≤ `end`; times unique.';

/** types.ts:107 `When`: dayspan's ScheduleInput (Oryoli's strict subset). */
export const When = a.object({
  on: LocalDay.optional().describe('A one-off: this day only.'),
  start: LocalDay.optional(),
  end: LocalDay.optional(),
  maxOccurrences: a.int().min(1).optional().describe('Ends after this many firings; needs `start`.'),
  dayOfWeek: days(0, 6).describe('0 = Sunday … 6 = Saturday.'),
  dayOfMonth: days(1, 31),
  lastDayOfMonth: days(1, 31).describe('1 = the last day of the month, 2 = the day before it.'),
  weekspanOfMonth: days(0, 4).describe('0 = days 1–7 ("the 1st Tuesday") … 4 = days 29–31.'),
  lastWeekspanOfMonth: days(0, 4).describe('0 = the last 7 days ("the last Friday").'),
  weekOfMonth: days(0, 5),
  weekOfYear: days(1, 53),
  month: days(0, 11).describe('0 = January … 11 = December.'),
  year: a.union([a.array(a.int()).min(1), Every]).optional().describe('Years, or every N years from the start.'),
  daysSinceEpoch: Every.optional().describe('Every N days from `start`.'),
  weeksSinceEpoch: Every.optional(),
  monthsSinceEpoch: Every.optional(),
  times: a.array(ClockTime).optional().describe('Each is a firing; none = one at 00:00.'),
  exclude: a.array(OccurrenceKey).optional().describe('Skipped firings.'),
  include: a.array(OccurrenceKey).optional().describe('Extra firings.'),
}).strict().refine((when) => {
  // GAP (superRefine): zod adds one issue per problem; a refine gives one message.
  const problems = whenRuleProblems(when as WhenFields);
  return problems.length === 0 || problems.join(' ');
}, WHEN_RULES);

type EveryT = { every: number; offset?: number };
export interface WhenT {
  on?: LocalDay; start?: LocalDay; end?: LocalDay; maxOccurrences?: number;
  dayOfWeek?: number[]; dayOfMonth?: number[]; lastDayOfMonth?: number[]; weekspanOfMonth?: number[]; lastWeekspanOfMonth?: number[];
  weekOfMonth?: number[]; weekOfYear?: number[]; month?: number[]; year?: number[] | EveryT;
  daysSinceEpoch?: EveryT; weeksSinceEpoch?: EveryT; monthsSinceEpoch?: EveryT;
  times?: ClockTime[]; exclude?: OccurrenceKey[]; include?: OccurrenceKey[];
}
expectTypeOf<a.infer<typeof When>>().toEqualTypeOf<WhenT>();
expectTypeOf<LocalDay>().toEqualTypeOf<string & Brand<'LocalDay'>>();
expectTypeOf<Zone>().toEqualTypeOf<string & Brand<'Zone'>>();

/** types.ts:144-153 */
export const Notify = a.enum(['always', 'failed', 'never']);
export const Overlap = a.enum(['skip', 'queue', 'replace']);
export const Missed = a.enum(['latest', 'none']);

/** core primitives.ts:176,179,111: Timestamp is a whole number of ms, Usd a number, ActorId an id. */
const Timestamp = a.int();
const Usd = a.number();
const ActorId = a.string().pattern(/^act_[A-Za-z0-9_-]+$/).brand<'ActorId'>();

/**
 * types.ts:156 `SchedulePayload`: `args` is a gin program over `fire` and `previous` (`GinExprDef`, the session's
 * grammar), so the payload is a result of the program grammar, bound per session.
 */
export const SchedulePayload = Grammar.result(a.object({
  fn: QualifiedName.describe('The fn it runs.'),
  when: When,
  zone: Zone,
  args: a.ref('Expr').describe('A gin program over `fire` and `previous` whose result is `fn`\'s args (a literal for fixed args). Checked against `fn`\'s args type.'),
  argsAsked: a.string().min(1).optional().describe('The words `args` was written from, when it computes anything.'),
  notify: Notify.default('always'),
  overlap: Overlap.default('skip'),
  missed: Missed.default('latest'),
  maxSpend: Usd.min(Number.MIN_VALUE).optional().describe('The most one firing may spend, in USD; it lowers the firing turn\'s per-turn budget.'),
  paused: a.object({ at: Timestamp, by: ActorId, until: LocalDay.optional() }).strict().optional().describe('Who paused it, when, and optionally until which day.'),
  runsAllowed: a.object({ at: Timestamp, by: ActorId }).strict().optional(),
}).strict());
type SchedulePayloadT = a.infer<typeof SchedulePayload>;
expectTypeOf<SchedulePayloadT['args']>().toMatchTypeOf<ExprT>();
expectTypeOf<SchedulePayloadT['when']>().toEqualTypeOf<WhenT>();
expectTypeOf<SchedulePayloadT['fn']>().toEqualTypeOf<QualifiedName>();
expectTypeOf(SchedulePayload.bind).parameters.toEqualTypeOf<[session: ProgramSessionLike]>();

/** types.ts:184 `Fire`: what the args program reads as `fire`. */
export const Fire = a.object({
  at: Timestamp.describe('The instant it was planned for.'),
  local: a.string().describe('That instant in the zone, with its offset: `2026-11-30T09:00:00-05:00`.'),
  day: LocalDay,
  time: ClockTime.optional().describe('Absent for a whole-day firing.'),
  zone: Zone,
  count: a.int().min(0).describe('Firings before this one.'),
  late: a.int().min(0).describe('Ms after `at` that it started.'),
  manual: a.boolean().describe('Run now.'),
});
/** types.ts:213 */
export const PreviousFiring = a.object({ at: Timestamp, status: a.enum(['ran', 'failed']), result: a.json().optional() });
expectTypeOf<a.infer<typeof PreviousFiring>>().toEqualTypeOf<{ at: number; status: 'ran' | 'failed'; result?: JsonValue }>();

// ============================================================================
// shared/index.ts: the fns' args
// ============================================================================

/** index.ts:56 `Settings`: what add is asked besides the fn. */
const settings = {
  when: When.describe('When it runs, in the dayspan form: `on` for once, or day rules with `times`.'),
  args: a.json().optional().describe('Fixed args for the fn, checked against its args.'),
  compute: a.string().min(1).optional().describe('Args that change with each run, in plain words.'),
  name: a.string().min(1).optional().describe('What it does, for its fn name and title.'),
  zone: Zone.optional().describe('The time zone; the person\'s when left out.'),
  notify: Notify.optional().describe('When the person is notified of a run: always (default), failed, never.'),
  overlap: Overlap.optional().describe('A run due while the last still runs: skip (default), queue, replace.'),
  missed: Missed.optional().describe('Runs missed while the hub was down: latest (default), none.'),
  maxSpend: a.number().min(0).optional().describe('The most one run may spend, in USD.'),
} as const;

/** index.ts:96 `MONDAYS` */
const MONDAYS = { dayOfWeek: [1], times: ['09:00' as ClockTime] };
/** index.ts:70 `AddArgs`, with add's three examples (index.ts:136). */
export const AddArgs = withFnNames({})
  .dynamic((names: ModelFnNamesLike) => ({ FnName: fnNameOf(names) }), { key: (names) => names })
  .result(a.object({
    fn: a.ref('FnName').describe('The fn to run, as your tools spell it.'),
    ...settings,
    allowRuns: a.boolean().optional().describe('Never set this: it is the person\'s own choice on the approval card.'),
  }).example(
    { fn: 'database/main.orders_by_week', when: MONDAYS, compute: 'week_start: the firing\'s day minus 7 days' },
    { fn: 'schedule/remind', when: { on: '2026-12-01' as LocalDay, times: ['08:30' as ClockTime] }, args: { text: 'Renew the domain name.' } },
    { fn: 'fs/nightly_backup', when: { dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: ['02:00' as ClockTime] }, notify: 'failed' },
  ));
/** index.ts:76 `ChangeArgs`: the schedule, and any of add's fields (`partialOf(Settings)`). */
export const ChangeArgs = withFnNames({})
  .dynamic((names: ModelFnNamesLike) => ({ FnName: fnNameOf(names) }), { key: (names) => names })
  .result(a.object({
    schedule: a.ref('FnName').describe('The schedule to change, by its name.'),
    fn: a.ref('FnName').optional().describe('Another fn for it to run.'),
    ...settings,
    when: settings.when.optional(),
  }));
/** index.ts:257 `skip` */
export const SkipArgs = withFnNames({})
  .dynamic((names: ModelFnNamesLike) => ({ FnName: fnNameOf(names) }), { key: (names) => names })
  .result(a.object({
    schedule: a.ref('FnName').describe('The schedule, by its name.'),
    day: LocalDay.describe('The day of the run to skip (YYYY-MM-DD), in the schedule\'s zone.'),
    time: ClockTime.optional().describe('The time of the run to skip (HH:mm), when it runs more than once that day.'),
  }).example(
    { schedule: 'schedule/weekly_orders_summary', day: '2026-12-28' as LocalDay },
    { schedule: 'schedule/hourly_ticket_check', day: '2026-12-24' as LocalDay, time: '18:00' as ClockTime },
  ));
expectTypeOf<a.infer<typeof AddArgs>>().toEqualTypeOf<{
  fn: QualifiedName; when: WhenT; args?: JsonValue; compute?: string; name?: string; zone?: Zone;
  notify?: 'always' | 'failed' | 'never'; overlap?: 'skip' | 'queue' | 'replace'; missed?: 'latest' | 'none'; maxSpend?: number; allowRuns?: boolean;
}>();
expectTypeOf<a.infer<typeof ChangeArgs>['when']>().toEqualTypeOf<WhenT | undefined>();

/** index.ts:22 `Limits`, the system's config (a gin decl, `g.duration()` = ISO duration text). */
export const LimitsDef = {
  name: 'obj',
  props: {
    minGap: { type: { name: 'optional', generic: { T: { name: 'duration' } } }, docs: 'The shortest gap between two firings of one schedule (default 15 minutes).' },
    perPerson: { type: { name: 'optional', generic: { T: { name: 'num', options: { min: 1, whole: true } } } }, docs: 'Schedules one person may have (default 50).' },
    approvals: { type: { name: 'optional', generic: { T: { name: 'enum', options: { values: { wait: 'wait', refuse: 'refuse' } } } } }, docs: 'A firing that needs approval waits for its person (default), or is refused.' },
    keep: { type: { name: 'optional', generic: { T: { name: 'obj', props: { perSchedule: { type: { name: 'num', options: { min: 1, whole: true } } }, days: { type: { name: 'num', options: { min: 1, whole: true } } } } } } }, docs: 'How many firings are kept per schedule, and for how many days (default 500 and 180).' },
  },
} as const;

// ============================================================================
// server/authoring.ts: the args program's draft and worked examples
// ============================================================================

/** authoring.ts:196 `draftSchema`: `{ program: schemas().Expr.pipe(GinExprDef) }` over the session's bound types. */
export const ArgsDraft = Grammar.result(a.object({
  program: a.ref('Expr').describe('The args program: one gin expression whose value is the fn\'s whole args object.'),
}));
/** sdk authoring.ts:404 the draft tool's args `{ draft: <schema> }`. */
export const ArgsDraftTool = Grammar.result(a.object({ draft: a.object({ program: a.ref('Expr').describe('The args program: one gin expression whose value is the fn\'s whole args object.') }) }));
expectTypeOf<a.infer<typeof ArgsDraft>['program']>().toMatchTypeOf<ExprT>();

const num = (value: number) => ({ kind: 'new' as const, type: { name: 'num' }, value });
const fire = (...path: Array<{ prop: string } | { args: Record<string, ExprT> }>): ExprT => ({ kind: 'get', path: [{ prop: 'fire' }, ...path] });
const RANGE = { name: 'obj', props: { from: { type: { name: 'text' } }, to: { type: { name: 'text' } }, limit: { type: { name: 'num' } } } } as const satisfies TypeDefT;
const TITLED = { name: 'obj', props: { title: { type: { name: 'text' } } } } as const satisfies TypeDefT;
/** authoring.ts:66 `ARGS_EXAMPLES`, verbatim. */
export const ARGS_EXAMPLES = {
  lastWeek: {
    args: RANGE,
    program: { kind: 'new', type: RANGE, value: { from: fire({ prop: 'date' }, { prop: 'addDays' }, { args: { days: num(-7) } }, { prop: 'toText' }, { args: {} }), to: fire({ prop: 'day' }), limit: num(50) } },
  },
  titled: {
    args: TITLED,
    program: { kind: 'new', type: TITLED, value: { title: { kind: 'template', template: 'Notes for {day}', params: fire() } } },
  },
} as const;
