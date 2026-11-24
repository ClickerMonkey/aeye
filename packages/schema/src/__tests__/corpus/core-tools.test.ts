/**
 * Runtime proofs for core's Tool args / Prompt outputs (core-tools.ts): every
 * profile family, model-shaped answers, error paths, encoding into
 * instructions, examples, request budgets, the dynamic (ctx / input) forms,
 * and the custom-parse hooks as codecs.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, XAI_STRICT, profileFor, schemaHelpers,
} from '../../index';
import { compileTool, runToolCall } from '../../proposal/core-api';
import { asTool, clone, MODEL_PROFILES, profileProblems, validate } from './_check';
import * as C from './core-tools';
import { lines } from '../_lines';

const NO_COPIES = { objects: 0, arrays: 0, edits: 0, parsed: 0, repaired: 0 };
const compile = (t: string) => Handlebars.compile(t, { noEscape: true });
type J = any;

// ============================================================================
// Every schema, every profile
// ============================================================================

describe('every core Tool/Prompt schema renders on every profile and round-trips', () => {
  const cases: [string, Parameters<typeof profileProblems>[0], unknown[], boolean?][] = [
    ['README summarize output', C.SummaryOutput, [{ summary: 'Short.', keyPoints: ['a', 'b'] }, { summary: '', keyPoints: [] }], false],
    ['README getWeather', C.GetWeatherArgs, [{ location: 'Paris', units: 'celsius' }, { location: '48.85,2.35', units: 'fahrenheit' }]],
    ['README travelAdvisor output', C.TravelAdvice, [{ recommendations: ['Louvre'], packingList: ['umbrella'], weatherNotes: 'Rain.' }], false],
    ['README placeOrder', C.PlaceOrderArgs, [{ itemId: 'sku-1', quantity: 3 }]],
    ['README adaptive output', C.SolutionOutput, [{ solution: '42' }], false],
    ['README greeting output', C.GreetingOutput, [{ greeting: 'Hello, World!' }], false],
    ['README add', C.AddArgs, [{ a: 1, b: 2 }]],
    ['README records', C.TaggedArgs, [{ name: 'n', tags: { env: 'prod', team: 'red' } }, { name: 'n', tags: {} }]],
    ['tool.ts TEXT_TOOL_SCHEMA', C.TextToolArgs, [{ input: '123' }]],
    ['tool.ts doc', C.LocationArgs, [{ location: 'Oslo' }]],
    ['prompt.ts doc', C.SummaryOnly, [{ summary: 's' }], false],
    ['calculator', C.CalculatorArgs, [{ operation: 'add', a: 1, b: 2 }, { operation: 'subtract', a: 5, b: 3 }]],
    ['positive', C.PositiveArgs, [{ value: 0.5 }]],
    ['person positive', C.PersonPositive, [{ name: 'Alice', age: 25 }], false],
    ['program', C.ProgramArgs, [{ program: { kind: 'new', value: 42 } }]],
    ['program kind', C.ProgramKindArgs, [{ program: { kind: 'block' } }]],
    ['payload', C.PayloadArgs, [{ payload: { x: 7 } }]],
    ['payload text', C.PayloadText, [{ payload: 'xxxxxxxxxx' }]],
    ['email', C.EmailArgs, [{ email: 'ann@example.com' }]],
    ['weather unit', C.WeatherUnitArgs, [{ location: 'Paris' }, { location: 'Paris', unit: 'celsius' }]],
    ['nested optional', C.NestedOptionalArgs, [{ a: 1, inner: { d: 'x' } }, { a: 1, b: 'b', inner: { c: 2, d: 'x' } }]],
    ['optional path', C.OptionalPathArgs, [{}, { path: 'src/a.ts' }]],
    ['path', C.PathArgs, [{ path: 'src/a.ts' }]],
    ['required min 10', C.RequiredMin10, [{ required: 'long enough!' }]],
    ['value min 10', C.ValueMin10, [{ value: 'long enough!' }]],
    ...C.TRIVIAL.map(([name, schema, , sample]) => [`trivial ${name}`, schema, [sample]] as [string, Parameters<typeof profileProblems>[0], unknown[]]),
  ];
  for (const [name, schema, samples, isTool = true] of cases) {
    it(name, () => {
      expect(profileProblems(schema, samples, { tool: isTool })).toEqual([]);
    });
  }

  it('the dynamic forms, bound per ctx / input', () => {
    expect(profileProblems(C.ManageDataArgs.bind({ userRole: 'admin', isAuthenticated: true }), [{ action: 'delete' }, { action: 'read' }])).toEqual([]);
    expect(profileProblems(C.ManageDataArgs.bind({ userRole: 'user', isAuthenticated: true }), [{ action: 'read' }])).toEqual([]);
    expect(profileProblems(C.PersonByInput.bind({}, { includeAge: true }), [{ name: 'Alice', age: 30 }], { tool: false })).toEqual([]);
    expect(profileProblems(C.PersonByInput.bind({}, undefined), [{ name: 'Alice' }], { tool: false })).toEqual([]);
  });

  it('the custom-parse codecs (code values are not wire values)', () => {
    // A class instance can't go through _check's structuredClone (the prototype is lost, so "encode mutated
    // the value" is a false positive): BuiltArgs is checked per profile here instead.
    for (const p of MODEL_PROFILES) {
      const r = C.BuiltArgs.render(asTool(p));
      const wire = r.encode(new C.Built(21));
      expect(validate(r.jsonSchema, wire)).toEqual([]);
      const back = r.parseText(JSON.stringify(wire));
      expect(back.ok && back.value).toEqual(new C.Built(21));
    }
    expect(profileProblems(C.CsvNumbers, [[1, 2, 3]], { codecs: true, tool: false })).toEqual([]);
  });

  it('the trivial catalog names every core test site it covers', () => {
    expect(C.TRIVIAL.map(([n]) => n)).toHaveLength(new Set(C.TRIVIAL.map(([n]) => n)).size);
    for (const [, , sources] of C.TRIVIAL) expect(sources).toMatch(/\.test\.ts:\d+/);
  });
});

// ============================================================================
// Emitted JSON per dialect
// ============================================================================

describe('emitted JSON', () => {
  it('README records: "same schema, different wire shapes" (core README.md:518-520)', () => {
    const pairs = {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false },
      description: 'A map written as a list of {key, value} entries; each key at most once.',
    };
    // OpenAI strict: tags → array of {key, value}
    expect((C.TaggedArgs.render(asTool(OPENAI_STRICT)).jsonSchema as J).properties.tags).toEqual(pairs);
    // Anthropic strict: array of {key, value} too (open records unsupported)
    expect((C.TaggedArgs.render(asTool(ANTHROPIC_STRICT)).jsonSchema as J).properties.tags).toEqual(pairs);
    // Gemini (JSON Schema mode): standard additionalProperties
    expect((C.TaggedArgs.render(asTool(GOOGLE_STRICT)).jsonSchema as J).properties.tags).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    // xAI strict takes open records (core: XAI_STRICT "open records")
    expect((C.TaggedArgs.render(asTool(XAI_STRICT)).jsonSchema as J).properties.tags).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    // Gemini's OpenAPI subset has no additionalProperties: pairs
    expect((C.TaggedArgs.render(asTool(GOOGLE_OPENAPI)).jsonSchema as J).properties.tags.type).toBe('array');
  });

  it('getWeather: the default is said in words; OpenAI strict writes null to leave it out, Anthropic omits it', () => {
    expect(C.GetWeatherArgs.render(asTool(OPENAI_STRICT)).jsonSchema).toEqual({
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name or coordinates' },
        units: { anyOf: [{ type: 'string', enum: ['celsius', 'fahrenheit'] }, { type: 'null' }], description: 'Default when left out: "celsius".\nWrite null to leave it out.' },
      },
      required: ['location', 'units'],
      additionalProperties: false,
    });
    expect(C.GetWeatherArgs.render(asTool(ANTHROPIC_STRICT)).jsonSchema).toEqual({
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name or coordinates' },
        units: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Default when left out: "celsius".' },
      },
      required: ['location'],
      additionalProperties: false,
    });
  });

  it('tool.test.ts:617 compile(): described field + optional enum (Tool.compile → parameters)', () => {
    const t = compileTool({ name: 'weather', description: 'Get weather information', schema: C.WeatherUnitArgs, call: (i) => i.location }, {}, OPENAI_STRICT);
    expect(t.parameters).toEqual({
      type: 'object',
      properties: {
        location: { type: 'string', description: 'The city name' },
        unit: { anyOf: [{ type: 'string', enum: ['celsius', 'fahrenheit'] }, { type: 'null' }], description: 'Write null to leave it out.' },
      },
      required: ['location', 'unit'],
      additionalProperties: false,
    });
  });

  it('constraints: int/min stay keywords on OpenAI strict; Anthropic strict says them in words; email is a format both take', () => {
    expect((C.PlaceOrderArgs.render(asTool(OPENAI_STRICT)).jsonSchema as J).properties.quantity).toEqual({ type: 'integer', minimum: 1 });
    const claude = (C.PlaceOrderArgs.render(asTool(ANTHROPIC_STRICT)).jsonSchema as J).properties.quantity;
    expect(claude.minimum).toBeUndefined();
    expect(claude.type).toBe('integer');
    expect(claude.description).toBe('At least 1.');
    expect((C.EmailArgs.render(asTool(OPENAI_STRICT)).jsonSchema as J).properties.email).toEqual({ type: 'string', format: 'email' });
    expect((C.EmailArgs.render(asTool(ANTHROPIC_STRICT)).jsonSchema as J).properties.email).toEqual({ type: 'string', format: 'email' });
  });

  it('manageData: the role decides the enum the model sees', () => {
    const admin = C.ManageDataArgs.bind({ userRole: 'admin', isAuthenticated: true }).render(asTool(OPENAI_STRICT)).jsonSchema as J;
    const user = C.ManageDataArgs.bind({ userRole: 'user', isAuthenticated: true }).render(asTool(OPENAI_STRICT)).jsonSchema as J;
    expect(admin.$defs.Action).toEqual({ type: 'string', enum: ['read', 'write', 'delete'] });
    expect(user).toEqual({
      type: 'object',
      properties: { action: { $ref: '#/$defs/Action' } },
      required: ['action'],
      additionalProperties: false,
      $defs: { Action: { type: 'string', enum: ['read'] } },
    });
  });
});

// ============================================================================
// Decoding model-shaped answers
// ============================================================================

describe('decoding what models send', () => {
  it('tool.test.ts:960 — under OpenAI strict a null for a left-out optional leaves no key, even nested; in place', () => {
    const r = C.NestedOptionalArgs.render(asTool(OPENAI_STRICT));
    const wire = { a: 1, b: null, inner: { c: null, d: 'x' } };
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ a: 1, inner: { d: 'x' } });
    expect(res.ok && res.value).toBe(wire);
    expect('b' in wire).toBe(false);
    expect('c' in wire.inner).toBe(false);
    expect(res.stats).toEqual({ ...NO_COPIES, edits: 2 });
    // Copy-on-write leaves the answer untouched.
    const keep = { a: 1, b: null, inner: { c: null, d: 'x' } };
    const cow = r.parse(keep, { inPlace: false });
    expect(cow.ok && cow.value).toEqual({ a: 1, inner: { d: 'x' } });
    expect(keep.b).toBeNull();
  });

  it('getWeather: OpenAI strict null → the default; Anthropic / Gemini / xAI leave it out → the default', () => {
    const openai = C.GetWeatherArgs.render(asTool(OPENAI_STRICT)).parseText('{"location":"Paris","units":null}');
    expect(openai.ok && openai.value).toEqual({ location: 'Paris', units: 'celsius' });
    expect(openai.stats).toEqual({ ...NO_COPIES, edits: 1 });
    for (const p of [ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT]) {
      const wire = { location: 'Paris' };
      const res = C.GetWeatherArgs.render(asTool(p)).parse(wire);
      expect(res.ok && res.value).toEqual({ location: 'Paris', units: 'celsius' });
      expect(res.ok && res.value).toBe(wire);
    }
    const given = C.GetWeatherArgs.render(asTool(ANTHROPIC_STRICT)).parse({ location: 'Paris', units: 'fahrenheit' });
    expect(given.ok && given.value.units).toBe('fahrenheit');
    expect(given.stats).toEqual(NO_COPIES);
  });

  it('README records: pairs on OpenAI/Anthropic strict become a record (one object), open on Gemini/xAI (nothing copied)', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT]) {
      const res = C.TaggedArgs.render(asTool(p)).parse({ name: 'n', tags: [{ key: 'env', value: 'prod' }, { key: 'team', value: 'red' }] });
      expect(res.ok && res.value).toEqual({ name: 'n', tags: { env: 'prod', team: 'red' } });
      expect(res.stats).toEqual({ ...NO_COPIES, objects: 1, edits: 1 });
    }
    for (const p of [GOOGLE_STRICT, XAI_STRICT]) {
      const wire = { name: 'n', tags: { env: 'prod' } };
      const res = C.TaggedArgs.render(asTool(p)).parse(wire);
      expect(res.ok && res.value).toBe(wire);
      expect(res.stats).toEqual(NO_COPIES);
    }
  });

  it('tool.test.ts:115 — a double-encoded object arg is repaired (core: onRepair success)', () => {
    const res = C.ProgramArgs.render(asTool(OPENAI_STRICT)).parseText(JSON.stringify({ program: JSON.stringify({ kind: 'new', value: 42 }) }));
    expect(res.ok && res.value.program).toEqual({ kind: 'new', value: 42 });
    expect(res.stats).toEqual({ ...NO_COPIES, edits: 1, repaired: 1 });
  });

  it('tool.test.ts:140 — an already-valid object arg is not repaired', () => {
    const res = C.PayloadArgs.render(asTool(OPENAI_STRICT)).parseText(JSON.stringify({ payload: { x: 7 } }));
    expect(res.ok && res.value.payload.x).toBe(7);
    expect(res.stats).toEqual(NO_COPIES);
  });

  it('tool.test.ts:220 — the repair candidate also fails: the real error (at the inner field), repair counted', () => {
    const res = C.PayloadArgs.render(asTool(OPENAI_STRICT)).parseText(JSON.stringify({ payload: JSON.stringify({ x: 'not-a-number' }) }));
    expect(!res.ok && res.issues).toEqual([{ path: ['payload', 'x'], codePath: ['payload', 'x'], message: 'Expected a number, got string.' }]);
    expect(res.stats.repaired).toBe(1);
  });

  it('can turn repair off: the JSON string is then an error', () => {
    const res = C.ProgramArgs.render(asTool(OPENAI_STRICT)).parse({ program: '{"kind":"new","value":42}' }, { repair: false });
    expect(lines(res)).toBe('- at program: Expected an object, got string.');
  });

  it('prompt-core-features.test.ts:180 — a prompt output parsed in the code shape', () => {
    const r = a.object({ name: a.string(), age: a.number() }).render(OPENAI_STRICT);
    const res = r.parseText(JSON.stringify({ name: 'Alice', age: 30 }));
    expect(res.ok && res.value).toEqual({ name: 'Alice', age: 30 });
  });

  it('manageData bound for a user: "delete" is not in the enum', () => {
    const r = C.ManageDataArgs.bind({ userRole: 'user', isAuthenticated: true }).render(asTool(ANTHROPIC_STRICT));
    const res = r.parse({ action: 'delete' });
    expect(lines(res)).toBe('- at action: Expected one of: read.');
  });

  it('prompt-modes-reconfig.test.ts:450 — the output schema follows the input', () => {
    const noAge = C.PersonByInput.bind({}, { includeAge: false }).render(OPENAI_STRICT);
    expect(noAge.parseText('{"name":"Alice"}').ok).toBe(true);
    const withAge = C.PersonByInput.bind({}, { includeAge: true }).render(OPENAI_STRICT);
    const res = withAge.parseText('{"name":"Alice"}');
    expect(lines(res)).toBe('- at age: Required.');
  });
});

// ============================================================================
// Validation errors
// ============================================================================

describe('validation errors: wire path, code path, re-prompt message', () => {
  it('records: an error inside a pair is at the pair on the wire and at the key in code', () => {
    const res = C.TaggedArgs.render(asTool(OPENAI_STRICT)).parse({ name: 'n', tags: [{ key: 'food', value: 3 }] });
    expect(!res.ok && res.issues).toEqual([{ path: ['tags', 0, 'value'], codePath: ['tags', 'food'], message: 'Expected a string, got number.' }]);
    expect(lines(res)).toBe('- at tags[0].value: Expected a string, got number.');
  });

  it.each([
    ['tool.test.ts:63 calculator: unknown op', C.CalculatorArgs, { operation: 'mul', a: 1, b: 2 }, '- at operation: Expected one of: add, subtract.'],
    ['README placeOrder: quantity 0', C.PlaceOrderArgs, { itemId: 'a', quantity: 0 }, '- at quantity: Must be at least 1.'],
    ['README placeOrder: quantity 1.5', C.PlaceOrderArgs, { itemId: 'a', quantity: 1.5 }, '- at quantity: Expected a whole number.'],
    ['tool.test.ts:86 positive', C.PositiveArgs, { value: -5 }, '- at value: Must be greater than 0.'],
    ['tool.test.ts:251 email', C.EmailArgs, { email: 'nope' }, '- at email: Must be a valid email.'],
    ['prompt-retry:450 min(10)', C.RequiredMin10, { required: 'short' }, '- at required: Must be at least 10 characters.'],
    ['prompt-core-features:208 wrong type', a.object({ name: a.string(), age: a.number() }), { name: 'Alice', age: 'invalid' }, '- at age: Expected a number, got string.'],
  ])('%s', (_name, schema, wire, message) => {
    const res = (schema as unknown as typeof C.AddArgs).render(asTool(OPENAI_STRICT)).parse(wire);
    expect(lines(res)).toBe(message);
  });

  it('runToolCall: a bad answer becomes a re-prompt, a good one reaches call() decoded', async () => {
    const bad = await runToolCall(C.calculator, {}, OPENAI_STRICT, () => '{"operation":"mul","a":1,"b":2}');
    // The tool's error format (default 'full'): the model's JSON with a marker at `operation`.
    expect(bad).toEqual({
      ok: false,
      reprompt: [
        'Fix these arguments:',
        '1 problem in the arguments of calculator:',
        '',
        '{',
        '  "operation": "mul",',
        '               ^^^^^ operation: Expected one of: add, subtract.',
        '  "a": 1,',
        '  "b": 2',
        '}',
      ].join('\n'),
    });
    // A tool that asks for one line gets one line.
    const terse = await runToolCall({ ...C.calculator, errorFormat: 'summary' }, {}, OPENAI_STRICT, () => '{"operation":"mul","a":1,"b":2}');
    expect(terse).toEqual({ ok: false, reprompt: 'Fix these arguments:\nA problem in the arguments of calculator: at operation: Expected one of: add, subtract.' });
    const good = await runToolCall(C.getWeather, {}, OPENAI_STRICT, () => '{"location":"Paris","units":null}');
    expect(good).toEqual({ ok: true, output: { temperature: 20, condition: 'sunny', units: 'celsius', location: 'Paris' } });
  });
});

// ============================================================================
// Encoding into instructions
// ============================================================================

describe('encoding', () => {
  const sample = { location: 'Paris', units: 'celsius' as const };

  it('encode / encodeText / encodeAt / encoder follow the model shape', () => {
    const openai = C.GetWeatherArgs.render(asTool(OPENAI_STRICT));
    expect(openai.encode(sample)).toEqual(sample);
    const tagged = C.TaggedArgs.render(asTool(OPENAI_STRICT));
    expect(tagged.encodeText({ name: 'n', tags: { env: 'prod' } })).toBe('{"name":"n","tags":[{"key":"env","value":"prod"}]}');
    expect(tagged.encodeAt({ env: 'prod' }, 'tags')).toEqual([{ key: 'env', value: 'prod' }]);
    const nested = C.NestedOptionalArgs.render(asTool(OPENAI_STRICT));
    expect(nested.encode({ a: 1, inner: { d: 'x' } })).toEqual({ a: 1, b: null, inner: { c: null, d: 'x' } });
    const req = ModelProfile.of(XAI_STRICT).request([{ kind: 'tool', name: 'tagged', schema: C.TaggedArgs }]);
    const enc = req.get('tagged').encoder;
    expect(enc({ name: 'n', tags: { env: 'prod' } })).toBe('{"name":"n","tags":{"env":"prod"}}');
    expect(enc.wire({ name: 'n', tags: {} })).toEqual({ name: 'n', tags: {} });
  });

  it('a tool\'s instructions show its args in the model\'s shape (real Handlebars, as Tool.compileInstructions)', () => {
    const t = compile('Use this tool to get weather data for {{location}}. Call it like: {{encode example}}');
    const vars = { location: 'Paris', example: { location: 'Paris', units: 'celsius' } };
    const openai = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'getWeather', schema: C.GetWeatherArgs }]).get('getWeather');
    expect(t(vars, { helpers: openai.helpers() })).toBe('Use this tool to get weather data for Paris. Call it like: {"location":"Paris","units":"celsius"}');
    const tagged = compile('Tags look like {{encode tags path="tags"}}.');
    expect(tagged({ tags: { env: 'prod' } }, { helpers: schemaHelpers(C.TaggedArgs.render(asTool(ANTHROPIC_STRICT))) })).toBe('Tags look like [{"key":"env","value":"prod"}].');
    expect(tagged({ tags: { env: 'prod' } }, { helpers: schemaHelpers(C.TaggedArgs.render(asTool(GOOGLE_STRICT))) })).toBe('Tags look like {"env":"prod"}.');
  });

  it('a prompt shows its output in the model\'s shape and the schema as text', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request([
      { kind: 'tool', name: 'getWeather', schema: C.GetWeatherArgs },
      { kind: 'output', schema: C.TravelAdvice },
    ]);
    const t = compile('Answer like {{encode sample}}. Weather: {{encode w tool="getWeather"}}');
    expect(t({ sample: { recommendations: ['Louvre'], packingList: [], weatherNotes: 'Rain.' }, w: sample }, { helpers: req.helpers('output') }))
      .toBe('Answer like {"recommendations":["Louvre"],"packingList":[],"weatherNotes":"Rain."}. Weather: {"location":"Paris","units":"celsius"}');
    expect(compile('{{schema}}')({}, { helpers: schemaHelpers(C.SummaryOutput.render(LENIENT)) })).toBe('{ summary: string; keyPoints: string[] }');
  });

  it('the codecs encode the code value back to the wire', () => {
    expect(C.BuiltArgs.render(asTool(OPENAI_STRICT)).encode(new C.Built(4))).toEqual({ value: 4 });
    expect(C.CsvNumbers.render(OPENAI_STRICT).encode([1, 2, 3])).toEqual({ csv: '1,2,3' });
  });
});

// ============================================================================
// Examples
// ============================================================================

describe('examples', () => {
  const Ex = C.GetWeatherArgs.example({ location: 'Paris', units: 'celsius' });
  it('strict profiles get the example as description text, in their shape; lenient ones the examples keyword', () => {
    expect((Ex.render(asTool(OPENAI_STRICT)).jsonSchema as J).description).toBe('Example: {"location":"Paris","units":"celsius"}');
    expect((Ex.render(asTool(LENIENT)).jsonSchema as J).examples).toEqual([{ location: 'Paris', units: 'celsius' }]);
    const tagged = C.TaggedArgs.example({ name: 'n', tags: { env: 'prod' } });
    expect((tagged.render(asTool(OPENAI_STRICT)).jsonSchema as J).description).toBe('Example: {"name":"n","tags":[{"key":"env","value":"prod"}]}');
    expect((tagged.render(asTool(ANTHROPIC_STRICT)).jsonSchema as J).description).toBe('Example: {"name":"n","tags":[{"key":"env","value":"prod"}]}');
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, XAI_STRICT]) {
      const r = tagged.render(asTool(p));
      expect(validate(r.jsonSchema, r.encode({ name: 'n', tags: { env: 'prod' } }))).toEqual([]);
    }
  });
});

// ============================================================================
// Requests
// ============================================================================

describe('requests', () => {
  it('README.md:487 strict priorities: true first, then 100, then the default 1; false never strict', () => {
    const items = [
      { kind: 'tool', name: 'must', schema: C.AddArgs },
      { kind: 'tool', name: 'critical', schema: C.AddArgs, strict: true },
      { kind: 'tool', name: 'meh', schema: C.AddArgs, strict: false },
      { kind: 'tool', name: 'top', schema: C.AddArgs, strict: 100 },
    ] as const;
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request(items);
    expect(claude.entries.map((e) => [e.name, e.strict])).toEqual([['must', true], ['critical', true], ['meh', false], ['top', true]]);
    expect(claude.get('meh').adjustments).toEqual([{ kind: 'not-strict', reason: 'strict: false' }]);
    expect(claude.strictTools).toBe(3);
  });

  it('every README tool + prompt output in one Claude request: all strict, parse/encode through the entry', () => {
    const claude = profileFor({ id: 'claude-sonnet-4-5', provider: 'anthropic', capabilities: ['toolsStrict', 'structured', 'json'] });
    const req = claude.request([
      { kind: 'tool', name: 'getWeather', schema: C.GetWeatherArgs },
      { kind: 'tool', name: 'manageData', schema: C.ManageDataArgs.bind({ userRole: 'admin', isAuthenticated: true }) },
      { kind: 'tool', name: 'placeOrder', schema: C.PlaceOrderArgs },
      { kind: 'tool', name: 'add', schema: C.AddArgs },
      { kind: 'tool', name: 'tagged', schema: C.TaggedArgs },
      { kind: 'output', schema: C.TravelAdvice },
    ]);
    expect(req.entries.every((e) => e.strict)).toBe(true);
    expect(req.entries.flatMap((e) => e.adjustments)).toEqual([]);
    expect(req.degradations).toEqual([]);
    const w = req.get('getWeather').parseText('{"location":"Paris"}');
    expect(w.ok && w.value).toEqual({ location: 'Paris', units: 'celsius' });
    expect(req.get('tagged').encode({ name: 'n', tags: { a: 'b' } })).toEqual({ name: 'n', tags: [{ key: 'a', value: 'b' }] });
    expect(req.get('output').delivery).toBe('structured');
  });

  it('the trivial tools of one core agent test all fit OpenAI (128 tools) and Anthropic (20 strict)', () => {
    const items = C.TRIVIAL.map(([name, schema]) => ({ kind: 'tool' as const, name, schema }));
    const gpt = ModelProfile.of(OPENAI_STRICT).request(items);
    expect(gpt.strictTools).toBe(items.length);
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request(items);
    expect(claude.strictTools).toBe(20);
    expect(claude.entries.filter((e) => !e.strict).map((e) => e.adjustments[0]?.kind)).toEqual(Array(items.length - 20).fill('not-strict'));
  });
});

// ============================================================================
// Dynamic forms: binding, caching, applicability
// ============================================================================

describe('dynamic forms', () => {
  const admin = { userRole: 'admin' as const, isAuthenticated: true };
  it('binds are cached by the key (the role); different roles differ', () => {
    expect(C.ManageDataArgs.bind(admin)).toBe(C.ManageDataArgs.bind({ ...admin, isAuthenticated: false }));
    expect(C.ManageDataArgs.bind({ userRole: 'user', isAuthenticated: true })).not.toBe(C.ManageDataArgs.bind(admin));
    expect(C.PersonByInput.bind({}, { includeAge: true })).toBe(C.PersonByInput.bind({}, { includeAge: true }));
  });

  it('"tool unavailable" is applicable(ctx), not a schema function returning undefined', async () => {
    expect(await C.manageData.applicable!({ userRole: 'user', isAuthenticated: false })).toBe(false);
    expect(await C.manageData.applicable!(admin)).toBe(true);
    expect(await C.hidden.applicable!({})).toBe(false);
  });

  it('compileTool binds from ctx and renders for the profile', () => {
    const t = compileTool(C.manageData, { userRole: 'user', isAuthenticated: true }, ANTHROPIC_STRICT);
    const res = t.parse('{"action":"read"}');
    expect(res.ok && res.value).toEqual({ action: 'read' });
  });
});

// ============================================================================
// Custom parse hooks → codecs
// ============================================================================

describe('custom parse hooks as codecs', () => {
  it('tool.test.ts:408 — decodes to a class instance', () => {
    const res = C.BuiltArgs.render(asTool(OPENAI_STRICT)).parseText('{"value":21}');
    expect(res.ok && res.value).toBeInstanceOf(C.Built);
    expect(res.ok && res.value.doubled()).toBe(42);
  });

  it('tool.test.ts:483 — decodes to an array; a bad value is the codec\'s own message', () => {
    const r = C.CsvNumbers.render(OPENAI_STRICT);
    expect(r.parseText('{"csv":"1,2,3"}')).toMatchObject({ ok: true, value: [1, 2, 3] });
    expect(lines(r.parseText('{"csv":"1,x"}'))).toBe('- at (root): "1,x" is not a comma-separated list of numbers.');
  });

  it('prompt-output-custom-parse.test.ts:49 — a returned rich Error is the re-prompt message', () => {
    const res = C.RichErrorOutput.render(OPENAI_STRICT).parseText('{"value":1}');
    expect(lines(res)).toBe('- at (root): nice compiler-style error ^^^ here');
  });

  it('DELIBERATE: prompt-output-custom-parse.test.ts:21 — core\'s parse REPLACED the schema check ({n:"5"} accepted); a codec checks the wire first', () => {
    const r = a.codec(a.object({ value: a.number() }), { decode: (w): { value: number } => w, encode: (v: { value: number }) => v }).render(OPENAI_STRICT);
    expect(r.parseText('{"n":"5"}').ok).toBe(false);
  });
});

// ============================================================================
// Gaps
// ============================================================================

describe('gaps', () => {
  // core:tool.test.ts:86 `z.number().positive()` → `exclusiveMinimum: 0` (was GAP: exclusive bounds; now `.positive()`).
  it('was GAP: exclusive bounds — positive() emits exclusiveMinimum where the dialect has it, words where not', () => {
    expect((C.PositiveArgs.render(LENIENT).jsonSchema as J).properties.value).toEqual({ type: 'number', exclusiveMinimum: 0 });
    expect((C.PositiveArgs.render(asTool(OPENAI_STRICT)).jsonSchema as J).properties.value).toEqual({ type: 'number', exclusiveMinimum: 0 });
    expect((C.PositiveArgs.render(asTool(ANTHROPIC_STRICT)).jsonSchema as J).properties.value).toEqual({ type: 'number', description: 'Greater than 0.' });
  });

  // core:prompt-miscellaneous-simple.test.ts:367 `schema: z.string().min(5)`: core sends no response format and
  // takes the model's raw text as the value (then validates min(5)). @aeye/schema wraps a string output root
  // as `{ input }` and only parses JSON.
  it.fails('GAP: text output — a string output schema takes the raw reply text', () => {
    const out = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: C.TextMin5 }]).get('output');
    const res = out.parseText('Valid string response');
    expect(res.ok && res.value).toBe('Valid string response');
  });

  // core:tool.test.ts:194 — a double-encoded arg whose inner JSON is broken: core reports a targeted message
  // ("program ... JSON-encoded string ... as a JSON object directly"). Here the failed repair is silent and the
  // model is told only "Expected an object, got string.", which doesn't say what went wrong.
  it.fails('GAP: repair-failed message — a broken JSON-text container should say it was JSON text that failed to parse', () => {
    const res = C.ProgramKindArgs.render(asTool(OPENAI_STRICT)).parse({ program: '{"kind": "block", "lines": []]}' });
    expect(!res.ok && res.message).toMatch(/JSON/);
  });

  // core:prompt-applicability-compatibility.test.ts:20 `schema: () => false` → `prompt.applicable()` is false.
  // PromptInputV2 (proposal/core-api.ts) has no `applicable`, so the port is a type error (see core-tools.ts).
  it.fails('GAP: prompt-applicable — a prompt can say it is not applicable', () => {
    const p = C.notApplicablePrompt as unknown as { applicable?: () => boolean };
    // The object carries it only because the port forced it past the types; the proposal API doesn't read it.
    expect(Object.keys(C.notApplicablePrompt)).not.toContain('applicable');
    expect(p.applicable?.()).toBe(false);
  });

  it('sanity: clone keeps tests independent', () => {
    expect(clone({ a: 1 })).toEqual({ a: 1 });
  });
});
