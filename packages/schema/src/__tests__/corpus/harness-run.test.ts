/**
 * Runtime tests for harness-run.ts: the static toolset, `run` (as sent today and as `a` types it), a fleet fn's `on`,
 * `database/run_query` and `test`, on every profile family, plus the static toolset as one request.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, XAI_STRICT, type AnySchema, type Profile } from '../../index';
import { asTool, profileProblems, unexplained } from './_check';
import { fnNameOf, modelFnNames, type ModelFnNamesLike, type QualifiedName } from './harness-fns';
import * as R from './harness-run';

const tool = <T>(bound: { render(p: Profile): T }, p: Profile): T => bound.render(asTool(p));
const compile = (t: string) => Handlebars.compile(t, { noEscape: true });
const names = modelFnNames({ type: 'tools' });

/** A saved query's args (systems/database argsTypeOf: params, then paging and sorting) and schedule/remove's. */
const ordersByStatus = a.object({
  status: a.enum(['open', 'paid']).describe('Compared with database/main.orders.status.'),
  limit: a.int().min(1).max(500).optional().describe('How many rows (50 when empty).'),
  offset: a.int().min(0).optional().describe('How many rows to skip, for the next page.'),
  sort: a.array(a.object({ column: a.enum(['customer', 'total']), dir: a.enum(['asc', 'desc']) })).optional(),
}).strict();
const ctxFor = (n: ModelFnNamesLike, machines: readonly string[] = []): R.RunCtx => {
  const scheduleRemove = a.object({ schedule: fnNameOf(n).describe('The schedule, by its name.') }).strict();
  const table: Record<string, AnySchema> = { 'database/main.orders_by_status': ordersByStatus, 'schedule/remove': scheduleRemove };
  return { names: n, machines, argsOf: (fn) => table[fn] };
};
const ctx = ctxFor(names, ['laptop', 'desktop']);

describe('the static toolset\'s hub fns: inspect, load, unload (sdk/src/hub.ts:877-903)', () => {
  it('render and round-trip on every profile, with their real examples', () => {
    expect(profileProblems(R.InspectArgs.bind(names), [{ name: 'fs/edit', detail: 'full' }, { name: 'fs/Entry' }], { codecs: true })).toEqual([]);
    expect(profileProblems(R.LoadArgs.bind(names), [{ names: ['fs/read', 'fs/edit'], detail: 'signature' }, { names: ['database/guide'] }], { codecs: true })).toEqual([]);
    expect(profileProblems(R.UnloadArgs.bind(names), [{ names: ['fs/edit'] }], { codecs: true })).toEqual([]);
  });

  it('examples are shown in the model\'s spelling and shape', () => {
    expect(tool(R.InspectArgs.bind(names), OPENAI_STRICT).jsonSchema['description']).toBe('Examples: {"name":"fs__edit","detail":"full"} ; {"name":"fs__Entry","detail":null}');
    expect(tool(R.InspectArgs.bind(names), ANTHROPIC_STRICT).jsonSchema['description']).toBe('Examples: {"name":"fs__edit","detail":"full"} ; {"name":"fs__Entry"}');
  });

  it('`load` needs at least one name; refused where the model wrote it', () => {
    const res = tool(R.LoadArgs.bind(names), OPENAI_STRICT).parse({ names: [], detail: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues).toEqual([{ path: ['names'], codePath: ['names'], message: 'Must have at least 1 items.' }]);
    expect(tool(R.LoadArgs.bind(names), ANTHROPIC_STRICT).jsonSchema).toMatchObject({ properties: { names: { type: 'array', minItems: 1 } } });
  });
});

describe('run (core/src/modes.ts:75 RunArgs), as the harness sends it', () => {
  const samples: Array<a.infer<typeof R.RunArgs>> = [
    // hub modes.ts:84 RUN_TOOL_INSTRUCTIONS' example
    { fn: 'hub__fns_examples', args: { fn: 'hub__fns_get' } },
    { fn: 'database__main__orders_by_status', args: { status: 'paid', sort: [{ column: 'customer', dir: 'asc' }] }, on: 'laptop' as a.infer<typeof R.RunArgs>['on'] & string },
    { fn: 'fs__read', args: {} },
  ];

  it('renders and round-trips on every profile', () => {
    expect(profileProblems(R.RunArgs, samples)).toEqual([]);
    expect(tool(R.RunArgs, OPENAI_STRICT).jsonSchema).toMatchObject({
      properties: {
        fn: { type: 'string', minLength: 1, description: 'The fn to run, by its qualified name (fs/read).' },
        args: { anyOf: [{ type: 'array', items: { properties: { key: { type: 'string' }, value: { type: 'string', description: 'Write the value as JSON text.' } } } }, { type: 'null' }] },
      },
    });
    expect(tool(R.RunArgs, GOOGLE_STRICT).jsonSchema).toMatchObject({ properties: { args: { type: 'object', additionalProperties: {} } } });
  });

  it('decodes each provider\'s answer: pairs of JSON text (OpenAI/Anthropic strict), an open object (xAI, Gemini)', () => {
    const openai = { fn: 'fs__read', args: [{ key: 'path', value: '"notes.md"' }, { key: 'lines', value: '[1,20]' }], on: null };
    const r1 = tool(R.RunArgs, OPENAI_STRICT).parse(openai);
    expect(r1.ok && r1.value).toEqual({ fn: 'fs__read', args: { path: 'notes.md', lines: [1, 20] } });
    expect(r1.stats).toEqual({ objects: 1, arrays: 0, edits: 2, parsed: 2, repaired: 0 });
    const xai = { fn: 'fs__read', args: { path: 'notes.md' } };
    const r2 = tool(R.RunArgs, XAI_STRICT).parse(xai);
    expect(r2.ok && r2.value).toBe(xai);
    expect(r2.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
  });

  it('repairs args sent as a string holding their JSON (hub/src/execution/arg-repair.ts) where records are open objects', () => {
    for (const p of [XAI_STRICT, GOOGLE_STRICT, LENIENT]) {
      const res = tool(R.RunArgs, p).parse({ fn: 'database__main__orders_by_status', args: '{"status": "paid"}' });
      expect(res.ok && res.value, p.id).toEqual({ fn: 'database__main__orders_by_status', args: { status: 'paid' } });
      expect(res.stats.repaired, p.id).toBe(1);
    }
  });

  it('(was GAP) repair on a pairs dialect — args sent as a JSON string of the OBJECT (as models do) should be read as the record', () => {
    const res = tool(R.RunArgs, OPENAI_STRICT).parse({ fn: 'database__main__orders_by_status', args: '{"status": "paid"}', on: null });
    expect(res.ok && res.value).toEqual({ fn: 'database__main__orders_by_status', args: { status: 'paid' } });
  });

  it('`on` must be a machine name', () => {
    const res = tool(R.RunArgs, ANTHROPIC_STRICT).parse({ fn: 'fs__read', on: 'My Laptop' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toBe('- at on: Must match /^[a-z][a-z0-9-]*$/.');
  });
});

describe('run as `a` types it: args checked against the named fn\'s signature (RunCall)', () => {
  const bound = R.RunCall.bind(ctx);

  it('renders on every profile; args are JSON text whose type is given by fn on strict dialects', () => {
    const samples = [
      { fn: 'database/main.orders_by_status' as QualifiedName, args: { status: 'paid' }, on: 'laptop' },
      { fn: 'schedule/remove' as QualifiedName, args: { schedule: 'schedule/weekly_orders_summary' } },
    ];
    expect(profileProblems(bound, samples, { codecs: true })).toEqual([]);
    expect(tool(bound, ANTHROPIC_STRICT).jsonSchema).toMatchObject({
      properties: { args: { type: 'string', description: 'Write the value as JSON text.\nIts type is given by "fn".' }, on: { $ref: '#/$defs/Machine' } },
      $defs: { Machine: { enum: ['laptop', 'desktop'] }, FnName: { pattern: '^[a-z]\\S*$' } },
    });
    expect(tool(bound, XAI_STRICT).jsonSchema).toMatchObject({ properties: { args: { anyOf: expect.any(Array) } } });
  });

  it('decodes the model\'s call in one pass: name read back, JSON text parsed, args checked by the fn', () => {
    const answer = { fn: 'database__main__orders_by_status', args: '{"status":"paid","limit":20}', on: null };
    const res = tool(bound, OPENAI_STRICT).parse(answer);
    expect(res.ok && res.value).toEqual({ fn: 'database/main.orders_by_status', args: { status: 'paid', limit: 20 } });
    expect(res.stats.parsed).toBe(1);
    const wrong = tool(bound, OPENAI_STRICT).parse({ fn: 'database__main__orders_by_status', args: '{"status":"later"}', on: 'laptop' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues).toEqual([{ path: ['args', 'status'], codePath: ['args', 'status'], message: 'Expected one of: open, paid.' }]);
    const missing = tool(bound, ANTHROPIC_STRICT).parse({ fn: 'nope__x', args: '{}' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toBe('- at args: no fn of that name can run here');
    const machine = tool(bound, ANTHROPIC_STRICT).parse({ fn: 'fs__read', args: '{}', on: 'server' });
    expect(machine.ok).toBe(false);
  });

  it('fn-name fields inside the args are read back too (modes.ts:384 readArgs)', () => {
    const res = tool(bound, XAI_STRICT).parse({ fn: 'schedule__remove', args: { schedule: 'schedule__weekly_orders_summary' } });
    expect(res.ok && res.value).toEqual({ fn: 'schedule/remove', args: { schedule: 'schedule/weekly_orders_summary' } });
  });

  it.fails('GAP: a sibling-typed value is decoded in the CODE shape — a record inside the fn\'s args sent as pairs (as the strict model was told nothing else) is refused', () => {
    // the args JSON text is checked in the code shape (filters must be an object); the model was never shown the fn's
    // own schema in its dialect's shape, and on a pairs dialect it writes a record as pairs, which should be read too.
    const withRecord = { ...ctx, argsOf: () => a.object({ filters: a.record(a.string()) }) };
    const res = tool(R.RunCall.bind(withRecord), OPENAI_STRICT).parse({ fn: 'database__main__find', args: '{"filters":[{"key":"status","value":"paid"}]}', on: null });
    expect(res.ok && res.value).toEqual({ fn: 'database/main.find', args: { filters: { status: 'paid' } } });
  });

  it('encodes a call for instructions in the model\'s shape (RUN_TOOL_INSTRUCTIONS, {{encode}})', () => {
    const call = { fn: 'database/main.orders_by_status' as QualifiedName, args: { status: 'paid' } };
    expect(tool(bound, OPENAI_STRICT).encodeText(call)).toBe('{"fn":"database__main__orders_by_status","on":null,"args":"{\\"status\\":\\"paid\\"}"}');
    const t = compile('Example args: {{encode call}}');
    const req = ModelProfile.of(XAI_STRICT).request([{ kind: 'tool', name: 'run', schema: bound }]);
    expect(t({ call }, { helpers: req.get('run').helpers() })).toBe('Example args: {"fn":"database__main__orders_by_status","args":{"status":"paid"}}');
  });

  it('a static toolset in one request (StaticChatMode.fixedTools): every tool strict where the provider allows', () => {
    const items = [
      { kind: 'tool', name: 'inspect', schema: R.InspectArgs.bind(names) },
      { kind: 'tool', name: 'load', schema: R.LoadArgs.bind(names) },
      { kind: 'tool', name: 'unload', schema: R.UnloadArgs.bind(names) },
      { kind: 'tool', name: 'run', schema: bound },
    ] as const;
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request(items);
    expect(unexplained(claude)).toEqual([]);
    expect(claude.entries.map((e) => [e.name, e.strict, e.adjustments])).toEqual([
      ['inspect', true, []], ['load', true, []], ['unload', true, []], ['run', true, []],
    ]);
    const load = claude.get('load').parse({ names: ['fs__read'] });
    expect(load.ok && load.value).toEqual({ names: ['fs/read'] });
    // tools mode: one native tool per fn; past 20 strict tools Claude's lowest-priority ones go non-strict
    const many = Array.from({ length: 22 }, (_, i) => ({ kind: 'tool' as const, name: `shop__fn_${i}`, schema: R.FsReadArgs, strict: i < 20 ? 2 : 1 }));
    const req = ModelProfile.of(ANTHROPIC_STRICT).request(many);
    expect(req.strictTools).toBe(20);
    expect(req.get('shop__fn_21').strict).toBe(false);
    expect(req.get('shop__fn_21').adjustments[0]).toMatchObject({ kind: 'not-strict' });
  });
});

describe('a fleet fn\'s `on` (modes.ts:118 fnModeTool)', () => {
  const fleet = R.FleetFsRead.bind(['laptop', 'desktop']);

  it('renders on every profile with the machines as an enum, cached per list', () => {
    expect(R.FleetFsRead.bind(['laptop', 'desktop'])).toBe(fleet);
    expect(profileProblems(fleet, [{ path: 'notes.md', on: 'laptop' }, { path: 'a.md', lines: [1, 20] }])).toEqual([]);
    expect(tool(fleet, OPENAI_STRICT).jsonSchema).toMatchObject({
      properties: {
        on: { anyOf: [{ $ref: '#/$defs/Machine' }, { type: 'null' }], description: 'Which machine runs it: this system has several connected.\nWrite null to leave it out.' },
        lines: { anyOf: [{ type: 'object', properties: { 0: { type: 'integer' }, 1: { type: 'integer' } } }, { type: 'null' }] },
      },
      $defs: { Machine: { type: 'string', enum: ['laptop', 'desktop'] } },
    });
  });

  it('decodes: a tuple sent as {"0":…} (OpenAI strict), a machine it doesn\'t have refused (fleetArgs)', () => {
    const res = tool(fleet, OPENAI_STRICT).parse({ path: 'a.md', lines: { 0: 1, 1: 20 }, on: 'desktop' });
    expect(res.ok && res.value).toEqual({ path: 'a.md', lines: [1, 20], on: 'desktop' });
    expect(res.stats).toEqual({ objects: 0, arrays: 1, edits: 1, parsed: 0, repaired: 0 });
    const bad = tool(fleet, ANTHROPIC_STRICT).parse({ path: 'a.md', on: 'server' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues).toEqual([{ path: ['on'], codePath: ['on'], message: 'Expected one of: laptop, desktop.' }]);
  });
});

describe('database/run_query and the test tool', () => {
  const runQuery = R.RunQueryArgs.bind(names);

  it('render and round-trip on every profile; the real examples in each model\'s shape', () => {
    const examples = [
      { fn: 'database/main.orders_by_status' as QualifiedName, args: { status: 'paid' } },
      { fn: 'database/main.orders_by_status' as QualifiedName, args: { status: 'open', offset: 50, limit: 50, sort: [{ column: 'customer', dir: 'asc' }] } },
    ];
    expect(profileProblems(runQuery, examples, { codecs: true })).toEqual([]);
    expect(tool(runQuery, XAI_STRICT).jsonSchema['description']).toBe(
      'Examples: {"fn":"database__main__orders_by_status","args":{"status":"paid"}} ; {"fn":"database__main__orders_by_status","args":{"status":"open","offset":50,"limit":50,"sort":[{"column":"customer","dir":"asc"}]}}',
    );
    expect(tool(runQuery, OPENAI_STRICT).jsonSchema['description']).toContain('"args":[{"key":"status","value":"\\"paid\\""}]');
    expect(profileProblems(R.TestArgs, [{ args: { amount: 12.5, tags: ['a'] } }, { args: {} }])).toEqual([]);
  });

  it('decodes and repairs: a double-encoded args object on xAI', () => {
    const res = tool(runQuery, XAI_STRICT).parse({ fn: 'database__main__orders_by_status', args: '{"status":"paid"}' });
    expect(res.ok && res.value).toEqual({ fn: 'database/main.orders_by_status', args: { status: 'paid' } });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 2, parsed: 0, repaired: 1 });
    const anthropic = tool(runQuery, ANTHROPIC_STRICT).parse({ fn: 'database__main__orders_by_status', args: [{ key: 'status', value: '"paid"' }] });
    expect(anthropic.ok && anthropic.value).toEqual({ fn: 'database/main.orders_by_status', args: { status: 'paid' } });
    expect(anthropic.stats).toEqual({ objects: 1, arrays: 0, edits: 2, parsed: 1, repaired: 0 });
    const bad = tool(R.TestArgs, ANTHROPIC_STRICT).parse({ args: [{ key: 'amount', value: '12,5' }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toMatchObject({ path: ['args', 0, 'value'], codePath: ['args', 'amount'] });
  });
});
