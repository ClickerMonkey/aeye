/**
 * `{{encode value}}` in instructions and prompts: values shown exactly as
 * the model reads and writes them, for its profile, in this request — with
 * real Handlebars, compiled the way @aeye/core compiles them.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { a, ANTHROPIC_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, registerSchemaHelpers, schemaData, schemaHelpers, XAI_STRICT } from '../index';

const Budget = a.object({ owner: a.string(), limits: a.record(a.number()), note: a.string().optional() });
const Search = a.object({ query: a.string(), filters: a.record(a.string()).optional() });
const Report = a.object({ title: a.string(), scores: a.record(a.number()), at: a.tuple([a.number(), a.number()]) });

/** As core's Tool.compileInstructions / Prompt.compileContent. */
const compile = (t: string) => Handlebars.compile(t, { noEscape: true });

const example = { owner: 'ann', limits: { food: 200 } };

describe('per-render helpers', () => {
  it('a tool\'s instructions show its own args in the model\'s shape', () => {
    const t = compile('Call it like: {{encode example}}');
    const strict = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'budget', schema: Budget }]).get('budget');
    expect(t({ example }, { helpers: strict.helpers() })).toBe('Call it like: {"owner":"ann","limits":[{"key":"food","value":200}],"note":null}');
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'tool', name: 'budget', schema: Budget }]).get('budget');
    expect(t({ example }, { helpers: claude.helpers() })).toBe('Call it like: {"owner":"ann","limits":[{"key":"food","value":200}]}');
    const grok = ModelProfile.of(XAI_STRICT).request([{ kind: 'tool', name: 'budget', schema: Budget }]).get('budget');
    expect(t({ example }, { helpers: grok.helpers() })).toBe('Call it like: {"owner":"ann","limits":{"food":200}}');
  });

  it('pretty and path options', () => {
    const r = Budget.render(OPENAI_STRICT);
    const t = compile('{{encode limits path="limits"}}|{{encode limits path="limits" pretty=true}}');
    expect(t({ limits: { a: 1 } }, { helpers: schemaHelpers(r) })).toBe('[{"key":"a","value":1}]|[\n  {\n    "key": "a",\n    "value": 1\n  }\n]');
  });

  it('a prompt picks any schema of its request: the output by default, a tool by name', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request([
      { kind: 'tool', name: 'search', schema: Search },
      { kind: 'output', schema: Report },
    ]);
    const t = compile('Answer like {{encode sample}}. Search with {{encode q tool="search"}}. Again: {{encode sample output=true}}');
    const out = t(
      { sample: { title: 'T', scores: { a: 1 }, at: [1, 2] }, q: { query: 'x', filters: { kind: 'note' } } },
      { helpers: req.helpers('output') },
    );
    expect(out).toBe(
      'Answer like {"title":"T","scores":[{"key":"a","value":1}],"at":{"0":1,"1":2}}. '
      + 'Search with {"query":"x","filters":[{"key":"kind","value":"note"}]}. '
      + 'Again: {"title":"T","scores":[{"key":"a","value":1}],"at":{"0":1,"1":2}}',
    );
  });

  it('a request of one schema needs no default; {{schema}} prints the shape', () => {
    const req = ModelProfile.of(LENIENT).request([{ kind: 'output', schema: Report }]);
    expect(compile('{{schema}}')({}, { helpers: req.helpers() })).toBe('{ title: string; scores: { [key: string]: number }; at: [number, number] }');
    expect(compile('{{encode v}}')({ v: { title: 't', scores: {}, at: [0, 0] } }, { helpers: req.helpers() })).toBe('{"title":"t","scores":{},"at":[0,0]}');
  });

  it('JSON is never HTML-escaped, even without noEscape', () => {
    const t = Handlebars.compile('{{encode v}}');
    expect(t({ v: { owner: 'a"<b>', limits: {} } }, { helpers: schemaHelpers(Budget.render(LENIENT)) })).toBe('{"owner":"a\\"<b>","limits":{}}');
  });

  it('works inside #each (helpers see each item)', () => {
    const t = compile('{{#each items}}{{encode this path="limits"}};{{/each}}');
    expect(t({ items: [{ x: 1 }, { y: 2 }] }, { helpers: schemaHelpers(Budget.render(OPENAI_STRICT)) })).toBe('[{"key":"x","value":1}];[{"key":"y","value":2}];');
  });

  it('mistakes are clear errors', () => {
    const req = ModelProfile.of(LENIENT).request([{ kind: 'tool', name: 'a', schema: Search }, { kind: 'tool', name: 'b', schema: Search }]);
    expect(() => compile('{{encode v}}')({ v: {} }, { helpers: req.helpers() })).toThrow('say which schema');
    expect(() => compile('{{encode v tool="zzz"}}')({ v: {} }, { helpers: req.helpers() })).toThrow('no schema named "zzz"');
    expect(() => compile('{{encode}}')({}, { helpers: schemaHelpers(Search.render(LENIENT)) })).toThrow('needs a value');
    expect(() => compile('{{encode v tool="a"}}')({ v: {} }, { helpers: schemaHelpers(Search.render(LENIENT)) })).toThrow('need a whole request');
  });
});

describe('registered once, target per render', () => {
  const hb = Handlebars.create();
  registerSchemaHelpers(hb);

  it('reads the target from the render data', () => {
    const t = hb.compile('{{encode example}} / {{#each list}}{{encode this tool="search"}}{{/each}}', { noEscape: true });
    const req = ModelProfile.of(OPENAI_STRICT).request([
      { kind: 'tool', name: 'budget', schema: Budget },
      { kind: 'tool', name: 'search', schema: Search },
    ]);
    const out = t({ example, list: [{ query: 'q' }] }, { data: schemaData(req, 'budget') });
    expect(out).toBe('{"owner":"ann","limits":[{"key":"food","value":200}],"note":null} / {"query":"q","filters":null}');
  });

  it('a render without schema data says how to give it', () => {
    expect(() => hb.compile('{{encode x}}')({ x: 1 })).toThrow('schemaData');
  });

  it('custom helper names', () => {
    const hb2 = Handlebars.create();
    registerSchemaHelpers(hb2, { encode: 'wire', schema: 'shape' });
    const r = Budget.render(LENIENT);
    expect(hb2.compile('{{wire v}} {{shape}}', { noEscape: true })({ v: example }, { data: schemaData(r) }))
      .toBe('{"owner":"ann","limits":{"food":200}} { owner: string; limits: { [key: string]: number }; note?: string }');
  });
});
