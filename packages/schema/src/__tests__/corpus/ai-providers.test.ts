/**
 * The @aeye/ai / provider-package schemas (ai-providers.ts): every profile, the dialect
 * decisions their tests pin (Gemini forced tool calls, recursive tools on Bedrock Claude,
 * shared named types, unions/intersections per family), answers, errors, encoding.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, XAI_STRICT, profileFor, schemaHelpers } from '../../index';
import { asTool, profileProblems, unexplained } from './_check';
import * as P from './ai-providers';

type J = any;

describe('every schema on every profile', () => {
  it.each([
    ['union value', P.UnionValue, [{ id: 'a', value: 'x' }, { id: 'b', value: 2 }], true],
    ['allOf value', P.AllOfValue, [{ id: 'a', value: { a: 'x', b: 1 } }], true],
    ['plain', P.Plain, [{ id: '1', name: 'n' }], false],
    ['x', P.XArgs, [{ x: 'y' }], true],
    ['who', P.WhoArgs, [{ who: 'world' }], true],
    ['n', P.NArgs, [{ n: 1 }], true],
    ['value output', P.ValueOutput, [{ value: 42 }], false],
    ['location', P.LocationArgs, [{ location: 'Paris' }], true],
    ['city', P.CityArgs, [{ city: 'Paris' }], true],
    ['weather', P.WeatherArgs, [{ location: 'Paris', unit: 'celsius' }], true],
    ['result output', P.ResultOutput, [{ result: 'ok' }], false],
    ['q', P.QArgs, [{ q: 'cats' }], true],
    ['query output', P.QueryOutput, [{ query: 'q' }], false],
    ['walkTree', P.WalkTree, [{ value: 'root', children: [{ value: 'leaf' }, { value: 'mid', children: [{ value: 'x' }] }] }, { value: 'alone' }], true],
    ['attribute', P.Attribute, [{ author: { name: 'Ann', age: 40 }, reviewer: { name: 'Bob', age: 35 } }], true],
    ['title tags', P.TitleTags, [{ title: 'T' }, { title: 'T', tags: ['a'] }], false],
  ] as const)('%s', (_n, schema, samples, isTool) => {
    expect(profileProblems(schema as Parameters<typeof profileProblems>[0], samples, { tool: isTool })).toEqual([]);
  });

  it('api_signature (rest of any JSON) — xAI checked by hand: _check flags xAI objects with properties + a schema-valued rest', () => {
    const samples = [{ signature: { name: 'f' } }, { signature: { name: 'f', args: [{ name: 'x', type: 'num' }], returns: null } }];
    const profiles = [LENIENT, OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT];
    expect(profileProblems(P.ApiSignatureArgs, samples, { profiles })).toEqual([]);
    const xai = P.ApiSignatureArgs.render(asTool(XAI_STRICT));
    for (const s of samples) expect(xai.parseText(JSON.stringify(xai.encode(s)))).toMatchObject({ ok: true, value: s });
  });
});

describe('openrouter.test.ts:180 — Gemini with a forced tool call rejects a recursive $defs/Any', () => {
  const gemini3 = profileFor({ id: 'google/gemini-3-flash-preview', provider: 'openrouter', strictFormat: 'google', capabilities: ['toolsStrict', 'structured'] });
  it('the extra keys are an open object ({}), no $defs, and the tool stays strict', () => {
    const e = gemini3.request([{ kind: 'tool', name: 'api_signature', schema: P.ApiSignatureArgs, strict: 1 }]).get('api_signature');
    expect(e.profile.family).toBe('google');
    expect(e.strict).toBe(true);
    expect(e.jsonSchema).toEqual({
      type: 'object',
      properties: { signature: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: {}, description: 'The signature of the API function being declared.' } },
      required: ['signature'],
    });
    expect(JSON.stringify(e.jsonSchema)).not.toContain('$defs');
  });

  it('OpenAI / Anthropic strict: the extra keys go in "extra" pairs with JSON-text values; decoded back into the object', () => {
    const r = P.ApiSignatureArgs.render(asTool(OPENAI_STRICT));
    const sig = (r.jsonSchema as J).properties.signature;
    expect(sig.properties.extra.items.properties.value).toEqual({ type: 'string', description: 'Write the value as JSON text.' });
    const res = r.parse({ signature: { name: 'f', extra: [{ key: 'args', value: '[{"name":"x"}]' }, { key: 'returns', value: 'null' }] } });
    expect(res.ok && res.value).toEqual({ signature: { name: 'f', args: [{ name: 'x' }], returns: null } });
    expect(res.stats.parsed).toBe(2);
    expect(r.encode({ signature: { name: 'f', args: [1] } })).toEqual({ signature: { name: 'f', extra: [{ key: 'args', value: '[1]' }] } });
    // A double-encoded signature is repaired.
    const rep = r.parse({ signature: '{"name":"f","args":[1]}' });
    expect(rep.ok && rep.value).toEqual({ signature: { name: 'f', args: [1] } });
    expect(rep.stats.repaired).toBe(1);
  });
});

describe('aws.test.ts:402 — a recursive tool on Bedrock Claude', () => {
  it('DELIBERATE: core sent it non-strict (keeps $ref); @aeye/schema keeps it strict with the back-edge as JSON text', () => {
    const e = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'walkTree', schema: P.WalkTree, strict: true }]).get('walkTree');
    expect([e.strict, e.adjustments]).toEqual([true, []]);
    const js = e.jsonSchema as J;
    expect(js.properties.children.items.type).toBe('string');
    expect(js.description).toContain('type Node = { value: string; children?: Node[] }');
    const res = e.parse({ value: 'root', children: ['{"value":"leaf","children":[{"value":"x"}]}'] });
    expect(res.ok && res.value).toEqual({ value: 'root', children: [{ value: 'leaf', children: [{ value: 'x' }] }] });
    expect(res.stats.parsed).toBe(1);
    const bad = e.parse({ value: 'root', children: ['{"value":1}'] });
    expect(!bad.ok && bad.issues[0]).toMatchObject({ path: ['children', 0, '(json)', 'value'], codePath: ['children', 0, 'value'] });
  });

  it('no toolsStrict: the family\'s non-strict profile, which keeps the recursive $ref', () => {
    const claude = profileFor({ id: 'anthropic.claude-sonnet-4-5', provider: 'aws', capabilities: ['tools'] });
    const e = claude.request([{ kind: 'tool', name: 'walkTree', schema: P.WalkTree, strict: true }]).get('walkTree');
    expect(e.strict).toBe(false);
    expect(JSON.stringify(e.jsonSchema)).toContain('"$ref":"#/$defs/Node"');
  });

  it('aws.test.ts:463 — a shared non-recursive Person stays a $defs entry referenced twice under Anthropic strict', () => {
    const js = P.Attribute.render(asTool(ANTHROPIC_STRICT)).jsonSchema as J;
    expect(js.$defs.Person).toEqual({ type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } }, required: ['name', 'age'], additionalProperties: false });
    expect(js.properties).toEqual({ author: { $ref: '#/$defs/Person' }, reviewer: { $ref: '#/$defs/Person' } });
  });
});

describe('ai schema-fallback.test.ts — unions and intersections per family', () => {
  it('a union is anyOf on every strict family; an intersection is merged into one object (core: allOf, which Gemini lacks)', () => {
    for (const p of [OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, XAI_STRICT]) {
      expect((P.UnionValue.render(asTool(p)).jsonSchema as J).properties.value.anyOf).toHaveLength(2);
      expect(JSON.stringify(P.AllOfValue.render(asTool(p)).jsonSchema)).not.toContain('allOf');
    }
    expect((P.AllOfValue.render(asTool(GOOGLE_STRICT)).jsonSchema as J).properties.value).toEqual({
      type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'],
    });
  });

  it('a value of the wrong member type is reported at value', () => {
    const res = P.UnionValue.render(asTool(OPENAI_STRICT)).parse({ id: 'a', value: true });
    expect(!res.ok && res.issues[0]!.path).toEqual(['value']);
    const and = P.AllOfValue.render(asTool(OPENAI_STRICT)).parse({ id: 'a', value: { a: 'x' } });
    expect(!and.ok && and.message).toBe('- at value.b: Required.');
  });
});

describe('aws converse.test.ts:233 — structured output with an optional array', () => {
  it('Claude strict output omits it; OpenAI strict writes null; both decode to absent', () => {
    expect((P.TitleTags.render(ANTHROPIC_STRICT).jsonSchema as J).required).toEqual(['title']);
    const res = P.TitleTags.render(OPENAI_STRICT).parseText('{"title":"T","tags":null}');
    expect(res.ok && res.value).toEqual({ title: 'T' });
    expect(res.stats.edits).toBe(1);
  });
});

describe('openai.test.ts:713 — weather tool in a request, encoded into instructions', () => {
  it('strict on GPT; the instructions show an example in the wire shape', () => {
    const req = profileFor({ id: 'gpt-5.4', provider: 'openai', capabilities: ['toolsStrict', 'structured', 'json'] }).request([
      { kind: 'tool', name: 'get_weather', schema: P.WeatherArgs },
      { kind: 'tool', name: 'lookup', schema: P.QArgs },
      { kind: 'output', schema: P.ResultOutput },
    ]);
    expect(req.entries.every((e) => e.strict)).toBe(true);
    expect(unexplained(req)).toEqual([]);
    const t = Handlebars.compile('Example: {{encode e tool="get_weather"}}', { noEscape: true });
    expect(t({ e: { location: 'Paris', unit: 'celsius' } }, { helpers: req.helpers('output') })).toBe('Example: {"location":"Paris","unit":"celsius"}');
    expect(req.get('get_weather').parse({ location: 'Paris', unit: 'kelvin' })).toMatchObject({ ok: false, message: '- at unit: Expected one of: celsius, fahrenheit.' });
    expect(Handlebars.compile('{{schema}}', { noEscape: true })({}, { helpers: schemaHelpers(P.WeatherArgs.render(LENIENT)) }))
      .toBe('{ location: string; unit: "celsius" | "fahrenheit" }');
  });
});
