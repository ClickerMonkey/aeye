/**
 * Runtime tests for harness-fns.ts: the harness's fn args (memory fns, zod-gin fixtures, instance configs, catalog
 * signatures, fn names) and the hub's structured answers, on every profile family.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_STRICT, fromGin, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, PEOPLE, schemaHelpers, XAI_STRICT,
  type AnySchema, type GinTypeDef, type Profile,
} from '../../index';
import { asTool, clone, profileProblems, validate } from './_check';
import * as H from './harness-fns';

const compile = (t: string) => Handlebars.compile(t, { noEscape: true });
const tool = <T>(bound: { render(p: Profile): T }, p: Profile): T => bound.render(asTool(p));
const props = (json: Record<string, unknown>): string[] => Object.keys(json['properties'] as object);

/** Tools mode: every fn by its model name. */
const toolsNames = H.modelFnNames({ type: 'tools' });
/** Static mode: `load` stands for hub/load, hub/fns_load and hub/ctx_load (hub modes.ts:50 STATIC_TOOL_FNS). */
const staticNames = H.modelFnNames({
  type: 'static',
  tools: {
    find: { fn: 'hub/fns_search' }, find_ctx: { fn: 'hub/ctx_search' }, inspect: { fn: 'hub/inspect' },
    load: { fn: 'hub/load', also: ['hub/fns_load', 'hub/ctx_load'] }, unload: { fn: 'hub/unload', also: ['hub/fns_drop', 'hub/ctx_drop'] },
  },
}, 2);

// ============================================================================
// Model names
// ============================================================================

describe('a fn\'s model name (core/src/model-names.ts)', () => {
  it('spells `/` and `.` as `__`, cuts past 64 with a hash, and reads back by the rule', () => {
    expect(H.modelFnName('fs/read')).toBe('fs__read');
    expect(H.modelFnName('database/main.expenses_create')).toBe('database__main__expenses_create');
    const long = 'database/main.a_very_long_table_name_for_expenses_by_category_and_month_create' as const;
    const cut = H.modelFnName(long);
    expect(cut).toHaveLength(64);
    expect(cut).toMatch(/_x[0-9a-f]{8}$/);
    expect(H.fnOfModelNameByRule('database__main__expenses_create')).toBe('database/main.expenses_create');
    expect(H.fnOfModelNameByRule(cut)).toBeUndefined();
    expect(H.fnOfModelNameByRule('find')).toBeUndefined();
  });

  it('FnName is a codec: the model reads and writes its tools\' spelling, the code holds the qualified name', () => {
    const Load = H.withFnNames({}).dynamic((n: H.ModelFnNamesLike) => ({ FnName: H.fnNameOf(n) }), { key: (n) => n })
      .result(a.object({ names: a.array(a.ref('FnName')).min(1) }));
    // hub/sdk hub.ts:899 `load` args `{ names: g.list(g.fnName(), { minLength: 1 }) }`, its example
    const example = { names: ['fs/read', 'fs/edit'] as H.QualifiedName[] };
    const tools = tool(Load.bind(toolsNames), OPENAI_STRICT);
    expect(tools.encode(example)).toEqual({ names: ['fs__read', 'fs__edit'] });
    expect(tools.jsonSchema).toMatchObject({ $defs: { FnName: { type: 'string', pattern: '^[a-z]\\S*$', description: 'A fn\'s name, as your tools spell it.' } } });
    // static mode: hub/fns_load is spoken as the tool that does its job
    const statics = tool(Load.bind(staticNames), OPENAI_STRICT);
    expect(statics.encode({ names: ['hub/fns_load', 'fs/read'] })).toEqual({ names: ['load', 'fs__read'] });
    const answer = { names: ['load', 'database__main__orders_by_status', 'fs/read'] };
    const res = statics.parse(answer);
    expect(res.ok && res.value).toEqual({ names: ['hub/load', 'database/main.orders_by_status', 'fs/read'] });
    expect(res.ok && res.value).toBe(answer); // decoded in place
    // two names read back; the qualified one is taken as it is (no edit)
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 2, parsed: 0, repaired: 0 });
    const bad = statics.parse({ names: ['fs/read', 'nope'] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues).toEqual([{ path: ['names', 1], codePath: ['names', 1], message: 'nope names no fn: write a fn\'s name as your tools spell it.' }]);
    }
    // the bound schema is kept per prompt (keyed by the names object)
    expect(Load.bind(toolsNames)).toBe(Load.bind(toolsNames));
    expect(Load.bind(staticNames)).not.toBe(Load.bind(toolsNames));
    expect(profileProblems(Load.bind(toolsNames), [example], { codecs: true })).toEqual([]);
  });

  it.fails('GAP: fromGin(g.fnName()) — a text of FN_NAME_PATTERN should become the FnName codec (ref), not a plain string', () => {
    // sdk hub.ts:877 `inspect` args, as its gin decl travels: `name` is `g.fnName()`
    const Inspect = fromGin(H.InspectArgsDef as GinTypeDef);
    expect([...Inspect.refNames()]).toContain('FnName');
  });
});

// ============================================================================
// The memory fns: people-only `inject`, `clear`'s narrower model form
// ============================================================================

describe('UpdateMemoryArgs / RememberArgs (core/src/context-graph.ts:175,187)', () => {
  const update = H.UpdateMemoryArgs.bind(toolsNames);
  const remember = H.RememberArgs.bind(toolsNames);
  /** zod-gin.test.ts:91 and a fuller edit. */
  const samples: Array<a.infer<typeof H.UpdateMemoryArgs>> = [
    { name: 'hub/memory.a', clear: ['tags', 'command'] },
    {
      name: 'hub/memory.trip', text: 'Flights are booked.', weight: 1.5, tags: ['travel'], fns: ['fs/read', 'database/main.trips_create'],
      about: [{ kind: 'fn', name: 'database/main.trips_create' }, { kind: 'resource', uri: 'file:///trips.md', section: 'Flights' as H.SectionKey }],
      visible: 'both', parent: 'hub/memory.travel',
    },
  ];

  it('renders and round-trips on every profile', () => {
    expect(profileProblems(update, samples, { codecs: true })).toEqual([]);
    expect(profileProblems(remember, [{ text: 'Phil likes tea.', scope: 'user', tags: ['drinks'] }], { codecs: true })).toEqual([]);
  });

  it('a model is never shown `inject`; a person (the web endpoint\'s body) is', () => {
    expect(props(tool(update, OPENAI_STRICT).jsonSchema)).not.toContain('inject');
    expect(props(tool(update, ANTHROPIC_STRICT).jsonSchema)).not.toContain('inject');
    expect(props(tool(remember, GOOGLE_STRICT).jsonSchema)).not.toContain('inject');
    expect(props(update.render(PEOPLE).jsonSchema)).toContain('inject');
    // OpenAI strict: every optional is written null; the fn-name and link types are $defs
    const strict = tool(update, OPENAI_STRICT).jsonSchema;
    expect(strict).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9-]*/.+$' }, weight: { anyOf: [{ type: 'number', minimum: 0, maximum: 2 }, { type: 'null' }] } },
      $defs: { FnName: { type: 'string' }, LinkTarget: { anyOf: expect.any(Array) } },
    });
    expect((strict['required'] as string[]).sort()).toEqual(props(strict).sort());
    // Anthropic strict: optionals left out of `required`; numbers' ranges said in words
    const claude = tool(update, ANTHROPIC_STRICT).jsonSchema;
    expect(claude['required']).toEqual(['name']);
    expect(claude).toMatchObject({ properties: { weight: { type: 'number', description: expect.stringContaining('At least 0. At most 2.') } } });
  });

  it('a model sending `inject` anyway is refused at that field; a person\'s form keeps it', () => {
    const res = tool(update, OPENAI_STRICT).parse({ ...clone(tool(update, OPENAI_STRICT).encode(samples[0]!) as object), inject: { into: ['*'] } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues).toEqual([{ path: ['inject'], codePath: ['inject'], message: 'Not allowed.' }]);
    const web = update.render(PEOPLE).parse({ name: 'hub/memory.a', inject: { into: ['hub/chat*'], order: 40 } });
    expect(web.ok && web.value).toEqual({ name: 'hub/memory.a', inject: { into: ['hub/chat*'], order: 40, requires: [] } });
    const twoStars = update.render(PEOPLE).parse({ name: 'hub/memory.a', inject: { into: ['hub/**'] } });
    expect(twoStars.ok).toBe(false);
    if (!twoStars.ok) expect(twoStars.issues[0]).toMatchObject({ path: ['inject', 'into', 0], message: 'write one *' });
  });

  it('(was GAP) forModels on an optional wrapper (`z.array(…).optional()` as zod-gin marks it) — the model\'s `clear` should leave out `inject`', () => {
    const strict = tool(update, OPENAI_STRICT);
    expect(JSON.stringify(strict.jsonSchema['properties'])).not.toContain('"inject"');
    expect(strict.parse({ ...(strict.encode(samples[0]!) as object), clear: ['inject'] }).ok).toBe(false);
  });

  it('forModels directly on a field narrows what the model sees and sends (zod-gin.test.ts:97)', () => {
    const r = tool(H.Pick, OPENAI_STRICT);
    expect(r.jsonSchema).toMatchObject({ properties: { pick: { type: 'string', enum: ['a'] } } });
    const res = r.parse({ pick: 'b' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues).toEqual([{ path: ['pick'], codePath: ['pick'], message: 'Expected one of: a.' }]);
    expect(H.Pick.render(PEOPLE).parse({ pick: 'b' }).ok).toBe(true);
  });

  it('decodes real model answers: OpenAI strict (nulls), Anthropic strict, Gemini, xAI', () => {
    const openai = {
      text: null, title: null, about: [{ kind: 'fn', name: 'database__main__trips_create' }], weight: 1.5, summary: null, tags: null,
      fns: ['fs__read'], suggestFns: null, command: null, visible: null, suggest: null, parent: null, name: 'hub/memory.trip', clear: null,
    };
    const res = tool(update, OPENAI_STRICT).parse(openai);
    expect(res.ok && res.value).toEqual({ about: [{ kind: 'fn', name: 'database/main.trips_create' }], weight: 1.5, fns: ['fs/read'], name: 'hub/memory.trip' });
    expect(res.ok && res.value).toBe(openai);
    // 10 nulls deleted + 2 fn names read back, in place
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 12, parsed: 0, repaired: 0 });
    for (const p of [ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT]) {
      const answer = { name: 'hub/memory.a', clear: ['tags', 'command'], fns: ['fs__read'] };
      const r = tool(update, p).parse(answer);
      expect(r.ok && r.value, p.id).toEqual({ name: 'hub/memory.a', clear: ['tags', 'command'], fns: ['fs/read'] });
      expect(r.stats, p.id).toEqual({ objects: 0, arrays: 0, edits: 1, parsed: 0, repaired: 0 });
    }
  });

  it('reports wrong answers where the model wrote them', () => {
    const res = tool(update, ANTHROPIC_STRICT).parse({ name: 'memory', weight: 3, about: [{ kind: 'fn', name: 'nope' }, { kind: 'galaxy' }], command: 'Go Now' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((i) => i.path)).toEqual([['about', 0, 'name'], ['about', 1, 'kind'], ['weight'], ['command'], ['name']]);
      expect(res.issues.every((i) => JSON.stringify(i.path) === JSON.stringify(i.codePath))).toBe(true);
      expect(res.message).toContain('- at weight: Must be at most 2.');
      expect(res.message).toContain('- at about[0].name: nope names no fn');
      expect(res.message).toContain('- at name: Must match /^[a-z][a-z0-9-]*/.+$/.');
    }
  });

  it('encodes values for instructions in each model\'s shape (encode, encoder, {{encode}})', () => {
    const value = samples[1]!;
    expect(tool(update, XAI_STRICT).encode(value)).toMatchObject({ fns: ['fs__read', 'database__main__trips_create'], about: [{ kind: 'fn', name: 'database__main__trips_create' }, { kind: 'resource' }] });
    expect(tool(update, OPENAI_STRICT).encodeAt(['fs/read'], 'fns')).toEqual(['fs__read']);
    expect(tool(update, OPENAI_STRICT).encoder({ name: 'hub/memory.a' })).toContain('"clear":null');
    const t = compile('Example: {{encode example}}');
    expect(t({ example: samples[0] }, { helpers: schemaHelpers(tool(update, ANTHROPIC_STRICT)) })).toBe('Example: {"name":"hub/memory.a","clear":["tags","command"]}');
    expect(t({ example: samples[0] }, { helpers: schemaHelpers(tool(update, OPENAI_STRICT)) })).toContain('"weight":null');
  });

  it('request budget: remember and memory_update together on Anthropic strict pass the 24-optional limit', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([
      { kind: 'tool', name: 'hub__remember', schema: remember, strict: 2 },
      { kind: 'tool', name: 'hub__memory_update', schema: update },
    ]);
    expect(req.get('hub__remember').strict).toBe(true);
    expect(req.get('hub__remember').adjustments).toEqual([]);
    const second = req.get('hub__memory_update');
    expect(second.strict).toBe(true);
    expect(second.adjustments).toEqual([{ kind: 'optional-as-null' }]);
    expect(second.reasons[0]).toContain('optional properties (limit 24)');
    // parse and encode follow the entry's own rendering: nulls now mean absent for this tool only
    const answer = { ...(second.encode(samples[0]!) as object) };
    expect(answer).toMatchObject({ name: 'hub/memory.a', text: null });
    const back = second.parse(answer);
    expect(back.ok && back.value).toEqual(samples[0]);
    expect(t2(second.helpers())).toContain('"weight":null');
  });
});
const t2 = (helpers: ReturnType<typeof schemaHelpers>) => compile('{{encode v}}')({ v: { name: 'hub/memory.a' } }, { helpers });

// ============================================================================
// zod-gin.test.ts fixtures
// ============================================================================

describe('ginOf\'s Shape, toolArgsOf (sdk/src/zod-gin.test.ts)', () => {
  const value: a.infer<typeof H.Shape> = {
    name: 'a', email: 'a@b.co', count: 2, ratio: 0.5, mode: 'fast', one: 'only', tags: ['x'], scope: { scope: 'user', user: 'u' }, extra: { k: 1 }, note: null,
    data: { any: [1, 'two'] }, when: 'now',
  };

  it('renders and round-trips on every profile', () => {
    expect(profileProblems(H.Shape, [value, { ...value, on: true, mode: 'slow', scope: { scope: 'hub' }, extra: {}, note: 'n', data: null }])).toEqual([]);
    const strict = tool(H.Shape, OPENAI_STRICT).jsonSchema;
    expect(strict).toMatchObject({
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 40, description: 'What it is called.' },
        count: { type: 'integer', minimum: 0 },
        extra: { type: 'array', items: { properties: { key: { type: 'string' }, value: { type: 'number' } } } },
        data: { type: 'string', description: 'Write the value as JSON text.' },
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    });
    expect(tool(H.Shape, ANTHROPIC_STRICT).jsonSchema).toMatchObject({ properties: { name: { type: 'string', description: 'What it is called.\nAt least 1 characters. At most 40 characters.' } } });
  });

  it('accepts what the schema accepts and refuses what it refuses (zod-gin.test.ts:27)', () => {
    const r = H.Shape.render(LENIENT);
    expect(r.parse(clone(value)).ok).toBe(true);
    for (const bad of [{ count: 1.5 }, { count: -1 }, { ratio: 2 }, { name: '' }, { mode: 'medium' }, { one: 'other' }, { scope: { scope: 'galaxy' } }, { tags: [1] }]) {
      expect(r.parse({ ...clone(value), ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('decodes an OpenAI strict answer: record pairs, JSON text, nulls', () => {
    const answer = {
      name: 'a', email: 'a@b.co', count: 2, ratio: 0.5, on: null, mode: 'fast', one: 'only', tags: ['x'], scope: { scope: 'hub' },
      extra: [{ key: 'k', value: 1 }, { key: 'j', value: 2 }], note: null, data: '{"any":[1,"two"]}', when: 'now',
    };
    const res = tool(H.Shape, OPENAI_STRICT).parse(answer);
    expect(res.ok && res.value).toEqual({ ...value, mode: 'fast', scope: { scope: 'hub' }, extra: { k: 1, j: 2 } });
    expect(res.stats).toEqual({ objects: 1, arrays: 0, edits: 3, parsed: 1, repaired: 0 });
    const wrong = tool(H.Shape, OPENAI_STRICT).parse({ ...answer, extra: [{ key: 'k', value: 'x' }] });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues).toEqual([{ path: ['extra', 0, 'value'], codePath: ['extra', 'k'], message: 'Expected a number, got string.' }]);
  });

  it('a non-object root is the field `input` (zod-gin.ts:107), unwrapped on decode', () => {
    const r = tool(a.array(a.string()), OPENAI_STRICT);
    expect(r.jsonSchema).toMatchObject({ type: 'object', properties: { input: { type: 'array' } }, required: ['input'] });
    const wire = { input: ['x'] };
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual(['x']);
    expect(res.ok && res.value).toBe(wire.input);
    expect(r.parse(['x']).ok).toBe(false);
  });

  it('a union of objects: decoded by the schema itself, members checked (zod-gin.test.ts:48)', () => {
    expect(profileProblems(H.Either, [{ kind: 'b', b: 2 }, { kind: 'a', a: 'x' }])).toEqual([]);
    const r = tool(H.Either, ANTHROPIC_STRICT);
    expect(r.parse({ input: { kind: 'b', b: 2 } }).ok).toBe(true);
    expect(r.parse({ input: { kind: 'a', b: 2 } }).ok).toBe(false);
    // what toolArgsOf offers instead (FlatArgs): every field optional
    expect(tool(H.EitherFlat, OPENAI_STRICT).parse({ kind: 'b', a: null, b: 2, note: null }).ok).toBe(true);
  });

  it.fails('GAP: union-of-objects tool root — the model should pass plain args (toolArgsOf flattens), not { input: … }', () => {
    const r = tool(H.Either, OPENAI_STRICT);
    expect(r.jsonSchema['properties']).not.toHaveProperty('input');
    const res = r.parse({ kind: 'b', b: 2 });
    expect(res.ok && res.value).toEqual({ kind: 'b', b: 2 });
  });

  it('people-only fields are left out of a model\'s args and refused, kept for people (zod-gin.test.ts:65)', () => {
    expect(props(tool(H.Body, OPENAI_STRICT).jsonSchema)).toEqual(['text', 'note']);
    expect(props(H.Body.render(PEOPLE).jsonSchema)).toEqual(['text', 'note', 'secret']);
    const res = tool(H.Body, XAI_STRICT).parse({ text: 'x', secret: 's' });
    expect(res.ok).toBe(false);
    const web = H.Body.render(PEOPLE).parse({ text: 'x', secret: 's' });
    expect(web.ok && web.value).toEqual({ text: 'x', secret: 's' });
    // encoding for a model drops people-only fields
    expect(tool(H.Body, ANTHROPIC_STRICT).encode({ text: 'x', secret: 's' })).toEqual({ text: 'x' });
  });

  it('records: open keys are a record (pairs on strict dialects), enum keys an object of optional fields', () => {
    expect(profileProblems(H.RecordOfLists, [{ a: [1, 2], b: [] }])).toEqual([]);
    expect(profileProblems(H.Weights, [{}, { words: { weight: 2 } }])).toEqual([]);
    const w = tool(H.Weights, OPENAI_STRICT);
    // a record at a tool's root is wrapped as input; enum keys stay an enum in the pairs
    expect(w.jsonSchema).toMatchObject({ properties: { input: { type: 'array', items: { properties: { key: { enum: ['embedding', 'words'] }, value: { description: 'A part of the score.' } } } } } });
    const lenient = H.Weights.render(LENIENT);
    const bad = lenient.parse({ words: { weight: -1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]).toMatchObject({ path: ['words', 'weight'], message: 'Must be at least 0.' });
    expect(H.Weights.render(PEOPLE).jsonSchema).toMatchObject({ propertyNames: { enum: ['embedding', 'words'] } });
  });

  it('(was GAP) fromGin(record<V>) — the harness\'s gin `record` (gin-record.ts) should be a record, not a ref named "record"', () => {
    const R = fromGin(H.RecordGinDef as GinTypeDef);
    expect([...R.refNames()]).toEqual([]);
    expect(a.module().result(R as AnySchema).bind().render(LENIENT).parse({ a: [1, 2], b: [] }).ok).toBe(true);
  });
});

// ============================================================================
// Instance configs: a person's admin form, and what a model may be shown
// ============================================================================

describe('the build 9 instance configs (core/src/mcp-servers.ts, zod-gin.test.ts:146)', () => {
  /** mcp-servers.ts:57-67 the defaults zod fills in (the code value always has them). */
  const DEFAULTS = { auth: { kind: 'none' }, trusted: false, approval: 'writes', prompts: true, resources: true, maxTools: 200, timeout: 120_000 } as const;
  const cases = [
    { label: 'Files', transport: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { API_KEY: 'k' } }, ...DEFAULTS },
    { label: 'Linear', transport: { type: 'http', url: 'https://mcp.linear.app/mcp' }, ...DEFAULTS, auth: { kind: 'oauth', per: 'person', scopes: ['read'] }, approval: 'always' },
  ] as const satisfies ReadonlyArray<a.infer<typeof H.McpServerConfig>>;

  it('renders and round-trips on every profile', () => {
    expect(profileProblems(H.McpServerConfig, cases.map(clone))).toEqual([]);
  });

  it('refuses the bad cases, at the field', () => {
    const r = H.McpServerConfig.render(PEOPLE);
    const pipe = r.parse({ label: 'Files', transport: { type: 'pipe' } });
    expect(pipe.ok).toBe(false);
    if (!pipe.ok) expect(pipe.issues[0]?.path).toEqual(['transport', 'type']);
    const everyone = r.parse({ label: 'Linear', transport: { type: 'sse', url: 'https://x.test/sse' }, auth: { kind: 'oauth', per: 'everyone' } });
    expect(everyone.ok).toBe(false);
    if (!everyone.ok) expect(everyone.issues).toEqual([{ path: ['auth', 'per'], codePath: ['auth', 'per'], message: 'Expected one of: shared, person.' }]);
  });

  it('OpenAI strict writes `env` as pairs and absent optionals as null', () => {
    const wire = tool(H.McpServerConfig, OPENAI_STRICT).encode(cases[0]);
    expect(wire).toMatchObject({ label: 'Files', description: null, transport: { type: 'stdio', env: [{ key: 'API_KEY', value: 'k' }], cwd: null } });
    for (const x of validate(tool(H.McpServerConfig, OPENAI_STRICT).jsonSchema, wire)) throw new Error(x);
  });
});

// ============================================================================
// The hub's fn signatures (catalog.ts:252)
// ============================================================================

describe('catalog signature(): gin decls with the stored named types (hub/src/catalog/fixtures.ts)', () => {
  const v1: H.StoredTypes = { version: 1, named: () => new Map([['shop/Product', H.ProductDef as GinTypeDef]]) };
  const v2: H.StoredTypes = { version: 2, named: () => new Map([['shop/Product', { name: 'obj', props: { sku: { type: { name: 'text', options: { minLength: 3 } } }, price: { type: { name: 'num', options: { min: 0 } } } } }]]) };

  it('a fn with plain args: a static signature that refuses unknown args', () => {
    expect(profileProblems(H.ShopGetArgs, [{ sku: 'A-1' }])).toEqual([]);
    const res = tool(H.ShopGetArgs, ANTHROPIC_STRICT).parse({ sku: 'A-1', extra: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]?.path).toEqual(['extra']);
  });

  it('orders/place: the named type comes from the stored types, cached per version', () => {
    const bound = H.OrdersPlaceArgs.bind(v1);
    expect(H.OrdersPlaceArgs.bind(v1)).toBe(bound);
    expect(H.OrdersPlaceArgs.bind(v2)).not.toBe(bound);
    const sample = { product: { sku: 'A-1', price: 9.5 }, count: 2 };
    expect(profileProblems(bound, [sample])).toEqual([]);
    expect(tool(bound, OPENAI_STRICT).jsonSchema).toMatchObject({ $defs: { 'shop/Product': { type: 'object', properties: { price: { type: 'number', minimum: 0 } } } } });
    // a type change is a new signature (catalog.ts:753 clears #signatures)
    const res = tool(H.OrdersPlaceArgs.bind(v2), LENIENT).parse({ product: { sku: 'A', price: 1 }, count: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues).toEqual([{ path: ['product', 'sku'], codePath: ['product', 'sku'], message: 'Must be at least 3 characters.' }]);
    // signatureOf: the same, built per fn at run time
    const runtime = H.signatureOf(H.OrdersPlaceArgsDef).bind(v1);
    expect(tool(runtime, LENIENT).parse(sample).ok).toBe(true);
  });

  it('(was GAP) a $defs name with `/` (a qualified type name) must be escaped in $ref as a JSON pointer (`shop~1Product`)', () => {
    const json = tool(H.OrdersPlaceArgs.bind(v1), OPENAI_STRICT).jsonSchema;
    expect(json).toMatchObject({ properties: { product: { $ref: '#/$defs/shop~1Product' } } });
  });
});

// ============================================================================
// The hub's structured answers (hub/src/models/structured.ts)
// ============================================================================

describe('structuredAnswer outputs', () => {
  const VerdictEx = H.Verdict.example({ allow: false, reason: 'It deletes files the person did not name.' });

  it('render and round-trip on every profile', () => {
    expect(profileProblems(H.DecisionAnswer, [{ picks: [{ name: 'fn:fs/read', reason: 'Reads the file asked for.' }] }, { picks: [], declined: [{ name: 'context:fs/guide' }] }], { tool: false })).toEqual([]);
    expect(profileProblems(H.SystemDecisionAnswer, [{ picked: [{ id: 'q1', why: 'Same query.' }] }, { picked: [], note: 'None fits.' }], { tool: false })).toEqual([]);
    expect(profileProblems(VerdictEx, [{ allow: true, reason: 'A read.' }], { tool: false })).toEqual([]);
    expect(profileProblems(H.FilterAnswer, [{ keep: [{ name: 'fs/read' }], dropped: [{ name: 'fs/edit', reason: 'Writes.' }] }], { tool: false })).toEqual([]);
  });

  it('examples show in each model\'s shape', () => {
    expect(VerdictEx.render(OPENAI_STRICT).jsonSchema['description']).toBe('Example: {"allow":false,"reason":"It deletes files the person did not name."}');
    const ex = H.DecisionAnswer.example({ picks: [{ name: 'fn:fs/read' }] });
    expect(ex.render(OPENAI_STRICT).jsonSchema['description']).toBe('Example: {"picks":[{"name":"fn:fs/read","reason":null}],"declined":null}');
    expect(ex.render(ANTHROPIC_STRICT).jsonSchema['description']).toBe('Example: {"picks":[{"name":"fn:fs/read"}]}');
  });

  it('as a request\'s output: strict where the model takes it, decoded through the entry', () => {
    const openai = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: H.FilterAnswer }]).get('output');
    expect(openai.strict).toBe(true);
    const answer = JSON.stringify({ keep: [{ name: 'fs/read', reason: null }], dropped: null });
    const res = openai.parseText(answer);
    expect(res.ok && res.value).toEqual({ keep: [{ name: 'fs/read' }] });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 2, parsed: 0, repaired: 0 });
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'output', schema: H.SystemDecisionAnswer }]).get('output');
    expect(claude.strict).toBe(true);
    expect(claude.parseText('{"picked":[]}').ok).toBe(true);
    const wrong = claude.parseText('{"picked":[{"why":"x"}]}');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.issues).toEqual([{ path: ['picked', 0, 'id'], codePath: ['picked', 0, 'id'], message: 'Required.' }]);
  });
});

// ============================================================================
// zod constructs the ports had to approximate
// ============================================================================

describe('constructs `a` lacked or approximates', () => {
  it('.default(x) (now supported): InjectDecl `{ into }` decodes to the zod output with `order: 100, requires: []` filled in', () => {
    const res = H.InjectDecl.render(PEOPLE).parse({ into: ['hub/chat*'] });
    expect(res.ok && res.value).toEqual({ into: ['hub/chat*'], order: 100, requires: [] });
  });

  it('(was GAP) .positive() (exclusive minimum) — schedule `maxSpend: Usd.positive()` should say `exclusiveMinimum: 0`, not a minimum of the smallest double', () => {
    const MaxSpend = a.object({ maxSpend: a.number().positive().optional() });
    expect(MaxSpend.render(PEOPLE).jsonSchema).toMatchObject({ properties: { maxSpend: { exclusiveMinimum: 0 } } });
  });

  it('template literals: QualifiedName is an identity codec over its pattern (the code type is `${string}/${string}`)', () => {
    const r = a.object({ name: H.QualifiedName }).render(OPENAI_STRICT);
    expect(r.jsonSchema).toMatchObject({ properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9-]*/.+$' } } });
    const res = r.parse({ name: 'fs/read' });
    expect(res.ok && res.value).toEqual({ name: 'fs/read' });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 });
    expect(r.parse({ name: 'read' }).ok).toBe(false);
  });
});
