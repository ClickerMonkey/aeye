/**
 * Runtime tests for harness-schedule.ts: `When` and its rules, `Zone`, SchedulePayload over the session's program
 * grammar, schedule/add's args with its real examples, and the args authoring draft with its worked examples.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { a, ANTHROPIC_STRICT, fromGin, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, PEOPLE, XAI_STRICT, type Profile } from '../../index';
import { asTool, clone, profileProblems } from './_check';
import { modelFnNames } from './harness-fns';
import type { ProgramSessionLike } from './harness-grammar';
import * as S from './harness-schedule';
import { lines } from '../_lines';

const tool = <T>(bound: { render(p: Profile): T }, p: Profile): T => bound.render(asTool(p));
const names = modelFnNames({ type: 'tools' });
type When = a.infer<typeof S.When>;
const day = (d: string) => d as S.LocalDay;
const at = (t: string) => t as S.ClockTime;

/** The target's types bound in the authoring session (schedule server/authoring.ts:53 `prepare`). */
const session: ProgramSessionLike = {
  named: [
    { name: 'schedule/Fire', def: { name: 'obj', props: { at: { type: { name: 'num' } }, day: { type: { name: 'text' } }, date: { type: { name: 'date' } } } } },
    { name: 'database/main.orders_by_week.args', def: S.ARGS_EXAMPLES.lastWeek.args },
  ],
};

describe('When (shared/types.ts:107)', () => {
  const samples: When[] = [
    // shared/index.ts add's examples: Mondays at 9, a one-off, every night
    { dayOfWeek: [1], times: [at('09:00')] },
    { on: day('2026-12-01'), times: [at('08:30')] },
    { dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: [at('02:00')] },
    // every other week from a start, ten times, skipping Christmas
    { start: day('2026-01-05'), maxOccurrences: 10, weeksSinceEpoch: { every: 2 }, exclude: ['2026-12-25' as S.OccurrenceKey] },
    { year: { every: 1, offset: 0 }, month: [11], lastDayOfMonth: [1] },
    { year: [2027, 2028], dayOfMonth: [1, 15] },
  ];

  it('renders and round-trips on every profile', () => {
    expect(profileProblems(S.When, samples)).toEqual([]);
  });

  it('OpenAI strict: 19 optionals written null, closed, the rules in the description; Anthropic strict: ranges in words', () => {
    const strict = tool(S.When, OPENAI_STRICT).jsonSchema;
    expect(strict).toMatchObject({
      type: 'object', additionalProperties: false, description: `Rules: ${S.WHEN_RULES}`,
      properties: {
        on: { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] },
        dayOfWeek: { anyOf: [{ type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, minItems: 1 }, { type: 'null' }] },
        year: { anyOf: [{ type: 'array' }, { type: 'object', additionalProperties: false }, { type: 'null' }] },
      },
    });
    expect((strict['required'] as string[])).toHaveLength(19);
    expect(tool(S.When, ANTHROPIC_STRICT).jsonSchema).toMatchObject({ properties: { dayOfWeek: { items: { type: 'integer', description: 'At least 0. At most 6.' }, minItems: 1 } } });
  });

  it('decodes an OpenAI strict answer: 17 nulls deleted in place', () => {
    const answer = Object.fromEntries(Object.keys(tool(S.When, OPENAI_STRICT).jsonSchema['properties'] as object).map((k) => [k, null])) as Record<string, unknown>;
    answer['dayOfWeek'] = [1];
    answer['times'] = ['09:00'];
    const res = tool(S.When, OPENAI_STRICT).parse(answer);
    expect(res.ok && res.value).toEqual({ dayOfWeek: [1], times: ['09:00'] });
    expect(res.ok && res.value).toBe(answer);
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 17, parsed: 0, repaired: 0 });
  });

  it('checks the rules (whenRuleProblems) and the fields, where the model wrote them', () => {
    const r = S.When.render(LENIENT);
    const both = r.parse({ on: '2026-12-01', dayOfWeek: [1], start: '2026-01-01' });
    expect(both.ok).toBe(false);
    if (!both.ok) {
      // one issue per problem, as zod's superRefine adds them
      expect(both.issues).toEqual([
        { path: [], codePath: [], message: '`on` is a one-off, so it can\'t have day rules too (dayOfWeek): give `on`, or the rules.' },
        { path: [], codePath: [], message: '`on` is a one-off, so it has no `start`, `end` or `maxOccurrences`.' },
      ]);
    }
    for (const [bad, message] of [
      [{ maxOccurrences: 3, dayOfWeek: [1] }, '`maxOccurrences` counts from `start`, so it needs `start`.'],
      [{ start: '2026-02-01', end: '2026-01-01' }, '`start` (2026-02-01) is after `end` (2026-01-01).'],
      [{ dayOfWeek: [1], times: ['09:00', '09:00'] }, '09:00 is in `times` twice.'],
    ] as const) {
      const res = r.parse(clone(bad));
      expect(lines(res)).toBe(`- at (root): ${message}`);
    }
    const fields = tool(S.When, ANTHROPIC_STRICT).parse({ dayOfWeek: [7], times: ['25:00'], bogus: 1 });
    expect(fields.ok).toBe(false);
    if (!fields.ok) {
      expect(fields.issues.map((i) => [i.path, i.message])).toEqual([
        [['dayOfWeek', 0], 'Must be at most 6.'],
        [['times', 0], 'Must match /^([01]\\d|2[0-3]):[0-5]\\d$/.'],
        [['bogus'], 'Unknown field "bogus".'],
      ]);
    }
  });

  it('(was GAP) superRefine — each rule\'s problem should be its own issue (zod: one ctx.addIssue per problem)', () => {
    const res = S.When.render(LENIENT).parse({ on: '2026-12-01', dayOfWeek: [1], start: '2026-01-01' });
    expect(res.ok ? [] : res.issues).toHaveLength(2);
  });

  it('Zone: refined with Intl, branded', () => {
    const r = S.Zone.render(LENIENT);
    expect(r.parse('America/New_York').ok).toBe(true);
    expect(r.parse('UTC').ok).toBe(true);
    for (const bad of ['Mars/Olympus', '+05:00', 'Eastern Time']) {
      const res = r.parse(bad);
      expect(lines(res), bad).toBe('- at (root): an IANA time zone, such as America/New_York');
    }
    expect(a.object({ zone: S.Zone }).render(OPENAI_STRICT).jsonSchema['properties']).toEqual({ zone: { type: 'string', description: 'Rules: an IANA time zone, such as America/New_York' } });
  });
});

describe('schedule/add, change, skip (shared/index.ts)', () => {
  const add = S.AddArgs.bind(names);
  const examples: Array<a.infer<typeof S.AddArgs>> = [
    { fn: 'database/main.orders_by_week', when: { dayOfWeek: [1], times: [at('09:00')] }, compute: 'week_start: the firing\'s day minus 7 days' },
    { fn: 'schedule/remind', when: { on: day('2026-12-01'), times: [at('08:30')] }, args: { text: 'Renew the domain name.' } },
    { fn: 'fs/nightly_backup', when: { dayOfWeek: [0, 1, 2, 3, 4, 5, 6], times: [at('02:00')] }, notify: 'failed' },
  ];

  it('renders and round-trips the real examples on every profile', () => {
    expect(profileProblems(add, examples, { codecs: true })).toEqual([]);
    expect(profileProblems(S.ChangeArgs.bind(names), [
      { schedule: 'schedule/weekly_orders_summary', when: { dayOfWeek: [1, 4], times: [at('09:00')] } },
      { schedule: 'schedule/nightly_backup', notify: 'always' },
    ], { codecs: true })).toEqual([]);
    expect(profileProblems(S.SkipArgs.bind(names), [{ schedule: 'schedule/hourly_ticket_check', day: day('2026-12-24'), time: at('18:00') }], { codecs: true })).toEqual([]);
  });

  it('shows the examples in each model\'s spelling and shape', () => {
    const desc = tool(add, XAI_STRICT).jsonSchema['description'] as string;
    expect(desc.startsWith('Examples: {"fn":"database__main__orders_by_week","when":{"dayOfWeek":[1],"times":["09:00"]},"compute":"week_start: the firing\'s day minus 7 days"} ; ')).toBe(true);
    expect(desc).toContain('{"fn":"fs__nightly_backup","when":{"dayOfWeek":[0,1,2,3,4,5,6],"times":["02:00"]},"notify":"failed"}');
    expect(tool(S.SkipArgs.bind(names), ANTHROPIC_STRICT).jsonSchema['description']).toBe(
      'Examples: {"schedule":"schedule__weekly_orders_summary","day":"2026-12-28"} ; {"schedule":"schedule__hourly_ticket_check","day":"2026-12-24","time":"18:00"}',
    );
  });

  it('decodes a model\'s add: the fn name read back, `when` checked by its rules', () => {
    const answer = { fn: 'schedule__remind', when: { on: '2026-12-01', times: ['08:30'] }, args: { text: 'Renew the domain name.' } };
    const res = tool(add, GOOGLE_STRICT).parse(answer);
    expect(res.ok && res.value).toEqual({ ...answer, fn: 'schedule/remind' });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 1, parsed: 0, repaired: 0 });
    const bad = tool(add, GOOGLE_STRICT).parse({ fn: 'schedule__remind', when: { on: '2026-12-01', dayOfMonth: [1] }, zone: 'Moon/Base' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path)).toEqual([['when'], ['zone']]);
  });

  it('request budget: add alone passes Anthropic\'s 24 optional parameters, so `when` is sent as JSON text', () => {
    const entry = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'schedule__add', schema: add }]).get('schedule__add');
    expect(entry.strict).toBe(true);
    expect(entry.reasons).toEqual(['"schedule__add" alone: 32 optional properties (limit 24)']);
    expect(entry.adjustments).toEqual([{ kind: 'depth-limited', maxDepth: 1 }]);
    expect(entry.jsonSchema).toMatchObject({ properties: { when: { type: 'string' } } });
    // the model writes `when` as JSON text; the entry decodes it through the same rendering
    const res = entry.parseText(JSON.stringify({ fn: 'fs__nightly_backup', when: JSON.stringify({ dayOfWeek: [0, 6], times: ['02:00'] }), notify: 'failed' }));
    expect(res.ok && res.value).toEqual({ fn: 'fs/nightly_backup', when: { dayOfWeek: [0, 6], times: ['02:00'] }, notify: 'failed' });
    const t = Handlebars.compile('Like: {{encode ex}}', { noEscape: true });
    expect(t({ ex: examples[2] }, { helpers: entry.helpers() })).toBe('Like: {"fn":"fs__nightly_backup","when":"{\\"dayOfWeek\\":[0,1,2,3,4,5,6],\\"times\\":[\\"02:00\\"]}","notify":"failed"}');
    // OpenAI takes it whole
    const openai = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'schedule__add', schema: add }]).get('schedule__add');
    expect(openai.adjustments).toEqual([]);
  });

  it('the Limits config, a gin decl, is a person\'s form', () => {
    const Limits = fromGin(S.LimitsDef);
    expect(profileProblems(Limits, [{}, { minGap: 900_000, perPerson: 50, approvals: 'wait', keep: { perSchedule: 500, days: 180 } }])).toEqual([]);
    expect(Limits.render(PEOPLE).jsonSchema).toMatchObject({ properties: { minGap: { type: 'number', description: expect.stringContaining('The shortest gap between two firings of one schedule (default 15 minutes).') } } });
    const res = Limits.render(PEOPLE).parse({ perPerson: 0.5 });
    expect(lines(res)).toBe('- at perPerson: Expected a whole number.\n- at perPerson: Must be at least 1.');
  });
});

describe('SchedulePayload and the args program (types.ts:156, server/authoring.ts)', () => {
  const payload = S.SchedulePayload.bind(session);
  const sample: a.infer<typeof S.SchedulePayload> = {
    fn: 'database/main.orders_by_week', when: { dayOfWeek: [1], times: [at('09:00')] }, zone: 'America/New_York' as S.Zone,
    args: S.ARGS_EXAMPLES.lastWeek.program, argsAsked: 'from: the run\'s day minus 7 days; to: the run\'s day', notify: 'failed', overlap: 'skip', missed: 'latest',
  };

  it('renders and round-trips on every profile (the program is recursive: JSON text where recursion isn\'t allowed)', () => {
    expect(profileProblems(payload, [sample, { ...sample, args: S.ARGS_EXAMPLES.titled.program, paused: { at: 1767225600000, by: 'act_phil' as never } }])).toEqual([]);
    // Anthropic strict (no recursion): the program's first level is an object; each place it recurs is JSON text, its
    // named types described once on the whole schema
    const claude = tool(payload, ANTHROPIC_STRICT).jsonSchema;
    expect(claude).toMatchObject({ properties: { args: { $ref: '#/$defs/Expr' } }, description: expect.stringContaining('Named types used by the fields written as JSON text:\ntype Expr = { kind: "get"; path: PathStep[] }') });
    expect(JSON.stringify((claude['$defs'] as Record<string, unknown>)['Expr'])).toContain('\\"Expr\\" contains itself, which this model cannot describe directly.');
    expect(tool(payload, OPENAI_STRICT).jsonSchema).toMatchObject({ properties: { args: { anyOf: [{ $ref: '#/$defs/Expr' }] } }, $defs: { NamedType: { enum: ['schedule/Fire', 'database/main.orders_by_week.args'] } } });
  });

  it('the authoring draft: worked examples decode on each provider', () => {
    const draft = S.ArgsDraftTool.bind(session);
    expect(profileProblems(draft, [{ draft: { program: S.ARGS_EXAMPLES.lastWeek.program } }, { draft: { program: S.ARGS_EXAMPLES.titled.program } }])).toEqual([]);
    // Anthropic strict: the program is an object; `new`'s value and `template`'s params (recursion, any) are JSON text
    const wire = tool(draft, ANTHROPIC_STRICT).encode({ draft: { program: S.ARGS_EXAMPLES.titled.program } });
    expect(wire).toEqual({ draft: { program: { kind: 'new', type: { name: 'obj', props: [{ key: 'title', value: { type: '{"name":"text"}' } }] }, value: JSON.stringify(S.ARGS_EXAMPLES.titled.program.value) } } });
    const claude = tool(draft, ANTHROPIC_STRICT).parse(clone(wire));
    expect(claude.ok && claude.value).toEqual({ draft: { program: S.ARGS_EXAMPLES.titled.program } });
    expect(claude.stats).toMatchObject({ objects: 1, parsed: 2, repaired: 0 });
    // a model that sends the value itself where JSON text was asked: taken as is, counted as a repair
    const direct = tool(draft, ANTHROPIC_STRICT).parse({ draft: { program: { kind: 'new', type: { name: 'num' }, value: 50 } } });
    expect(direct.ok && direct.value).toEqual({ draft: { program: { kind: 'new', type: { name: 'num' }, value: 50 } } });
    expect(direct.stats.repaired).toBe(1);
    const openai = tool(draft, OPENAI_STRICT).parse({ draft: { program: { kind: 'get', path: [{ prop: 'fire' }, { prop: 'day' }] } } });
    expect(openai.ok).toBe(true);
    const wrong = tool(draft, OPENAI_STRICT).parse({ draft: { program: { kind: 'get', path: [] } } });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues[0]?.path).toEqual(['draft', 'program', 'path']);
  });

  it('repair: a whole program double-encoded (a tagged union sent as a JSON string) is read, and counted', () => {
    const res = tool(S.ArgsDraftTool.bind(session), ANTHROPIC_STRICT).parse({ draft: { program: JSON.stringify({ kind: 'get', path: [{ prop: 'fire' }] }) } });
    expect(res.ok && res.value).toEqual({ draft: { program: { kind: 'get', path: [{ prop: 'fire' }] } } });
    expect(res.stats.repaired).toBe(1);
  });

  it('the grammar is kept per session until more types are bound (runtime.ts:135)', () => {
    expect(S.ArgsDraft.bind(session)).toBe(S.ArgsDraft.bind({ named: [...session.named] }));
    expect(S.ArgsDraft.bind({ named: session.named.slice(0, 1) })).not.toBe(S.ArgsDraft.bind(session));
  });
});
