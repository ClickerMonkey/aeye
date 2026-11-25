/**
 * Deferred values: text written before the request is planned (a relay, text assembled ahead of the provider) holds
 * the code-shape value and the schema it is written with; once planned, each is written through the plan. Also: a
 * schema's own `.example()`s are written per profile.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_STRICT, deferEncode, deferredRequest, deferSchema, fillDeferred, GOOGLE_OPENAPI, GOOGLE_STRICT, hasDeferred, LENIENT, ModelProfile, OPENAI_NON_STRICT, OPENAI_STRICT,
  plainDeferred, registerSchemaHelpers, schemaData,
} from '../index';

const Budget = a.object({ owner: a.string(), limits: a.record(a.number()), note: a.string().optional() });
const Search = a.object({ query: a.string() });
const example = { owner: 'ann', limits: { food: 200 } };

const planFor = (profile: typeof OPENAI_STRICT, strict: boolean | number = 1) =>
  ModelProfile.of(profile).request([{ kind: 'tool', name: 'budget', schema: Budget, strict }, { kind: 'tool', name: 'search', schema: Search }]);

describe('deferred values', () => {
  it('are filled through the plan: pairs and null on OpenAI strict, open on Gemini, the code shape without a plan', () => {
    const text = `Call it like ${deferEncode({ tool: 'budget', value: example })}.`;
    expect(hasDeferred(text)).toBe(true);
    expect(fillDeferred(text, planFor(OPENAI_STRICT))).toBe('Call it like {"owner":"ann","limits":[{"key":"food","value":200}],"note":null}.');
    expect(fillDeferred(text, planFor(ANTHROPIC_STRICT))).toBe('Call it like {"owner":"ann","limits":[{"key":"food","value":200}]}.');
    expect(fillDeferred(text, planFor(GOOGLE_STRICT))).toBe('Call it like {"owner":"ann","limits":{"food":200}}.');
    expect(fillDeferred(text, planFor(OPENAI_STRICT, false))).toBe('Call it like {"owner":"ann","limits":{"food":200}}.');
    expect(plainDeferred(text)).toBe('Call it like {"owner":"ann","limits":{"food":200}}.');
    expect(fillDeferred('no values here', planFor(OPENAI_STRICT))).toBe('no values here');
  });

  it('every filled value decodes through the schema it was written for', () => {
    for (const profile of [OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, GOOGLE_OPENAPI, OPENAI_NON_STRICT, LENIENT]) {
      const plan = planFor(profile);
      const filled = fillDeferred(deferEncode({ tool: 'budget', value: example }), plan);
      const decoded = plan.get('budget').parseText(filled);
      expect(decoded.ok, `${profile.id}: ${filled}`).toBe(true);
      if (decoded.ok) expect(decoded.value).toEqual(example);
    }
  });

  it('a part, pretty, the output, the schema as TypeScript, and a value with the closing bracket in it', () => {
    const plan = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'budget', schema: Budget }, { kind: 'output', schema: Budget }]);
    expect(fillDeferred(deferEncode({ tool: 'budget', value: { a: 1 }, path: 'limits' }), plan)).toBe('[{"key":"a","value":1}]');
    expect(fillDeferred(deferEncode({ output: true, value: { owner: 'x⟧y', limits: {} }, pretty: true }), plan))
      .toBe('{\n  "owner": "x⟧y",\n  "limits": [],\n  "note": null\n}');
    expect(fillDeferred(deferSchema({ tool: 'budget' }), plan)).toBe(plan.get('budget').rendered.typescript());
  });

  it('a tool the plan lacks: through the schema it carries, planned alone for the model; else the code shape', () => {
    const plan = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'search', schema: Search }]);
    const carried = deferEncode({ tool: 'budget', value: example, schema: Budget.render(LENIENT).jsonSchema });
    expect(fillDeferred(carried, plan)).toBe('{"owner":"ann","limits":[{"key":"food","value":200}],"note":null}');
    expect(fillDeferred(deferEncode({ tool: 'budget', value: example, schema: Budget.render(LENIENT).jsonSchema, strict: false }), plan)).toBe('{"owner":"ann","limits":{"food":200}}');
    expect(fillDeferred(deferEncode({ tool: 'budget', value: example }), plan)).toBe('{"owner":"ann","limits":{"food":200}}');
  });

  it('a value its schema can\'t write is shown as it is', () => {
    expect(fillDeferred(deferEncode({ tool: 'budget', value: { owner: 'ann', limits: [1, 2] } }), planFor(OPENAI_STRICT))).toBe('{"owner":"ann","limits":[1,2]}');
  });

  it('a part picked from the whole as written, and a fallback where the plan can\'t write it', () => {
    const Call = a.object({ name: a.string(), args: a.record(a.number()) });
    const plan = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'tool', name: 'call', schema: Call }]);
    const picked = deferEncode({ tool: 'call', value: { name: 'x', args: { a: 1 } }, pick: 'args', fallback: '{"a":1}' });
    expect(fillDeferred(picked, plan)).toBe('[{"key":"a","value":1}]');
    expect(plainDeferred(picked)).toBe('{"a":1}');
    expect(fillDeferred(deferEncode({ tool: 'call', value: { name: 'x', args: { a: 1 } }, pick: 'args' }), undefined)).toBe('{"a":1}');
    expect(fillDeferred(deferEncode({ tool: 'none', value: 1, fallback: 'one' }), plan)).toBe('one');
  });

  it('a relay renders its templates for a deferred request; the planner fills them for its model', () => {
    const lenient = ModelProfile.of(LENIENT).request([{ kind: 'tool', name: 'budget', schema: Budget }]);
    const hb = Handlebars.create();
    registerSchemaHelpers(hb);
    const template = hb.compile('Like {{encode example}} or {{encode q tool="search"}}; shape {{schema}}', { noEscape: true });
    const deferred = deferredRequest(lenient, (name) => (name === 'search' ? Search.bind() : undefined));
    const sent = template({ example, q: { query: 'x' } }, { data: schemaData(deferred, 'budget') });
    expect(hasDeferred(sent)).toBe(true);
    const plan = planFor(OPENAI_STRICT);
    expect(fillDeferred(sent, plan)).toBe(`Like {"owner":"ann","limits":[{"key":"food","value":200}],"note":null} or {"query":"x"}; shape ${plan.get('budget').rendered.typescript()}`);
    // an encoder in a function-form instruction defers too
    expect(fillDeferred(deferred.get('budget').encoder(example), plan)).toBe('{"owner":"ann","limits":[{"key":"food","value":200}],"note":null}');
  });
});

describe('a schema\'s own examples', () => {
  const Tagged = a.object({
    who: a.codec(a.string(), { decode: (s: string) => s.replace('__', '/'), encode: (s: string) => s.replace('/', '__') }),
    limits: a.record(a.number()),
    note: a.string().optional(),
  }).example({ who: 'fs/read', limits: { food: 1 } });

  it('are written per profile: pairs, null for absent and codecs on strict; the code shape on lenient', () => {
    const strict = Tagged.render(OPENAI_STRICT).jsonSchema;
    expect(strict.description).toBe('Example: {"who":"fs__read","limits":[{"key":"food","value":1}],"note":null}');
    const lenient = Tagged.render(LENIENT).jsonSchema;
    expect(lenient.examples).toEqual([{ who: 'fs__read', limits: { food: 1 } }]);
  });
});
