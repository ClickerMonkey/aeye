/**
 * Request-wide budgets: every schema of one request fitted together, each
 * entry recording what it was rendered with, and parse/encode going through
 * that same rendering.
 */
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, profileFor, RequestLimitError, strictPriority,
  type Profile, type RequestItem,
} from '../index';

const Q = a.object({ q: a.string() });
const tool = (name: string, schema: RequestItem['schema'] = Q, strict?: boolean | number): RequestItem =>
  ({ kind: 'tool', name, schema, ...(strict !== undefined ? { strict } : {}) });

/** An object with `n` optional string fields. */
const optionals = (n: number) => a.object(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, a.string().optional()])));
/** An object with `n` nullable string fields. */
const nullables = (n: number) => a.object(Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, a.string().nullable()])));

describe('Anthropic: limits across every strict schema of the request', () => {
  const claude = ModelProfile.of(ANTHROPIC_STRICT);

  it('20 strict tools; the 21st (lowest priority) goes non-strict', () => {
    const items = Array.from({ length: 21 }, (_, i) => tool(`t${i}`, Q, i === 20 ? 1 : 2));
    const req = claude.request(items);
    expect(req.strictTools).toBe(20);
    const last = req.get('t20');
    expect(last.strict).toBe(false);
    expect(last.profile.id).toBe('anthropic'); // Anthropic's tool input_schema root is an object already
    expect(last.adjustments).toEqual([{ kind: 'not-strict', reason: '"t20": no strict tool slots left (limit 20)' }]);
    expect(req.problems).toEqual([]);
  });

  it('24 optional parameters: over budget, absent optionals are written null instead (union types)', () => {
    const req = claude.request([tool('big', optionals(20), 2), tool('small', optionals(10), 1)]);
    expect(req.get('big').adjustments).toEqual([]);
    const small = req.get('small');
    expect(small.strict).toBe(true);
    expect(small.adjustments).toEqual([{ kind: 'optional-as-null' }]);
    expect(small.reasons).toEqual(['"small" with the request so far: 30 optional properties (limit 24)']);
    expect(small.profile.optional).toBe('null');
    expect(small.measure).toMatchObject({ optional: 0, unions: 10 });
    expect(req.used).toMatchObject({ optional: 20, unions: 10 });
    // Decoding follows the choice: null means absent for this tool only.
    const res = small.parse({ ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, null])), f3: 'x' });
    expect(res.ok && res.value).toEqual({ f3: 'x' });
    expect(req.get('big').parse({ f0: 'a' }).ok).toBe(true);
    // Encoding follows it too.
    expect(small.encode({ f1: 'y' })).toMatchObject({ f0: null, f1: 'y' });
    expect(req.get('big').encode({ f1: 'y' })).toEqual({ f1: 'y' });
  });

  it('16 union-typed parameters: past it, a tool goes non-strict (nothing makes unions cheaper)', () => {
    const req = claude.request([tool('a', nullables(10), 2), tool('b', nullables(10), 1)]);
    expect(req.get('a').strict).toBe(true);
    const b = req.get('b');
    expect(b.strict).toBe(false);
    expect(b.adjustments[0]).toMatchObject({ kind: 'not-strict' });
    expect((b.adjustments[0] as { reason: string }).reason).toContain('20 union-typed properties (limit 16)');
  });

  it('priority: strict:true first, then higher numbers, regardless of order given', () => {
    expect([true, 5, 1, 0, undefined, false].map(strictPriority)).toEqual([Infinity, 5, 1, 0, 0, -Infinity]);
    const req = claude.request([tool('low', nullables(10), 1), tool('high', nullables(10), 9)]);
    expect(req.get('high').strict).toBe(true);
    expect(req.get('low').strict).toBe(false);
    // Entries stay in the order given.
    expect(req.entries.map((e) => e.name)).toEqual(['low', 'high']);
  });

  it('strict:true is never degraded for the budget: the overflow is a problem, and assertFits throws', () => {
    const req = claude.request([tool('a', optionals(20), true), tool('b', optionals(20), true)]);
    expect(req.get('b').strict).toBe(true);
    expect(req.problems).toEqual(['"b" (strict: true) with the request so far: 40 optional properties (limit 24)']);
    expect(() => req.assertFits()).toThrow(RequestLimitError);
    // ...but a hard-strict schema that can't fit ANY request does degrade.
    const alone = claude.request([tool('huge', optionals(30), true)]).get('huge');
    expect(alone.strict).toBe(false);
    expect(alone.reasons).toEqual([
      '"huge" alone: 30 optional properties (limit 24)',
    ]);
    // One that fits alone is kept as is, even under strict: true.
    expect(claude.request([tool('ok', optionals(16), true)]).get('ok').adjustments).toEqual([]);
  });

  it('strict:false and strict:0 stay non-strict without spending the budget', () => {
    const req = claude.request([tool('off', Q, false), tool('zero', Q, 0)]);
    expect(req.entries.map((e) => [e.strict, e.adjustments[0]])).toEqual([
      [false, { kind: 'not-strict', reason: 'strict: false' }],
      [false, { kind: 'not-strict', reason: 'strict not requested' }],
    ]);
    expect(req.strictTools).toBe(0);
  });

  it('the output shares the budget; an output that cannot be strict goes as prompt text (Claude output is always compiled)', () => {
    const req = claude.request([tool('t', optionals(20), 2), { kind: 'output', schema: nullables(20) }]);
    const out = req.get('output');
    expect(out.delivery).toBe('prompt');
    expect(out.jsonSchema).toBeUndefined();
    expect(out.promptText).toContain('n0: string | null');
    expect(out.promptText).toContain('Return ONLY a single raw JSON object');
    // The answer is parsed in the code shape.
    expect(out.parse(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, null]))).ok).toBe(true);
  });
});

describe('OpenAI: per-schema limits, adjusted rather than abandoned', () => {
  const gpt = profileFor({ id: 'gpt-5.4', provider: 'openai', capabilities: ['toolsStrict', 'structured', 'json'] });

  it('over 1,000 enum values: the big enums are widened (still enforced), the tool stays strict', () => {
    const names = Array.from({ length: 1200 }, (_, i) => `fn_${i}`) as [string, ...string[]];
    const req = gpt.request([tool('pick', a.object({ fn: a.enum(names), mode: a.enum(['a', 'b']) }))]);
    const e = req.get('pick');
    expect(e.strict).toBe(true);
    expect(e.adjustments).toEqual([{ kind: 'enums-widened', maxEnumValues: 250 }]);
    expect(e.reasons).toEqual(['"pick": 1202 enum values (limit 1000)']);
    const props = e.jsonSchema!.properties as any;
    expect(props.fn.enum).toBeUndefined();
    expect(props.mode.enum).toEqual(['a', 'b']);
    expect(e.parse({ fn: 'fn_1199', mode: 'a' }).ok).toBe(true);
    expect(e.parse({ fn: 'fn_9999', mode: 'a' }).ok).toBe(false);
  });

  it('a >250-value enum over 15,000 characters is widened too', () => {
    const long = Array.from({ length: 300 }, (_, i) => `a_rather_long_and_descriptive_identifier_for_the_function_number_${i}`) as [string, ...string[]];
    const e = gpt.request([tool('pick', a.object({ fn: a.enum(long) }))]).get('pick');
    expect(e.reasons[0]).toMatch(/an enum of 300 values has \d+ characters \(limit 15000 above 250 values\)/);
    expect(e.adjustments).toEqual([{ kind: 'enums-widened', maxEnumValues: 250 }]);
  });

  it('128 tools per request: more is a problem no degrading can fix', () => {
    const req = gpt.request(Array.from({ length: 129 }, (_, i) => tool(`t${i}`)));
    expect(req.problems).toEqual(['129 tools (limit 128)']);
  });

  it('a non-object tool root is wrapped as {input}, recorded, and unwrapped on parse', () => {
    const e = gpt.request([tool('tags', a.array(a.string()))]).get('tags');
    expect(e.adjustments).toEqual([{ kind: 'root-wrapped' }]);
    expect(e.parse({ input: ['a'] })).toMatchObject({ ok: true, value: ['a'] });
  });
});

describe('a custom profile with depth and property limits', () => {
  const Tree = a.object({ a: a.object({ b: a.object({ c: a.object({ d: a.string(), e: a.string() }) }) }) });
  const { maxDepth: _drop, ...openai } = OPENAI_STRICT;
  const tight: Profile = Object.freeze({ ...openai, id: 'tight', limits: { maxDepth: 3, maxProperties: 4 } });

  it('deep nesting is written as JSON text until the schema fits', () => {
    const e = ModelProfile.of(tight).request([{ kind: 'output', schema: Tree }]).get('output');
    expect(e.strict).toBe(true);
    expect(e.reasons).toEqual(['"output": 5 object properties (limit 4)', '"output": 4 levels of nesting (limit 3)']);
    expect(e.adjustments).toEqual([{ kind: 'depth-limited', maxDepth: 3 }]);
    expect(e.measure).toMatchObject({ depth: 3, properties: 3 });
    const c = (e.jsonSchema as any).properties.a.properties.b.properties.c;
    expect(c.type).toBe('string');
    expect(c.description).toContain('Nested too deep');
    // The JSON text is in the code shape and decodes into place.
    expect(e.parse({ a: { b: { c: '{"d":"x","e":"y"}' } } })).toMatchObject({ ok: true, value: { a: { b: { c: { d: 'x', e: 'y' } } } } });
  });
});

describe('delivery and families', () => {
  it('no structured output → the output schema goes as prompt text; tools still get JSON Schema', () => {
    const old = profileFor({ id: 'claude-3-haiku', provider: 'anthropic', capabilities: ['tools'] });
    const req = old.request([tool('t'), { kind: 'output', name: 'answer', schema: Q }]);
    expect(req.get('answer').delivery).toBe('prompt');
    expect(req.get('answer').adjustments).toEqual([{ kind: 'prompt-text', reason: 'the model has no structured output' }]);
    expect(req.get('t').jsonSchema).toBeDefined();
  });

  it('delivery: prompt is honoured; delivery: structured keeps an unfitting output structured (non-strict)', () => {
    const g = ModelProfile.of(GOOGLE_STRICT);
    expect(g.request([{ kind: 'output', schema: Q, delivery: 'prompt' }]).get('output').delivery).toBe('prompt');
    const claude = ModelProfile.of(ANTHROPIC_STRICT);
    const e = claude.request([{ kind: 'output', schema: optionals(30).extend({ x: nullables(20) }), delivery: 'structured' }]).get('output');
    expect([e.delivery, e.strict]).toEqual(['structured', false]);
  });

  it('the same schema renders as each entry chose: pairs for strict Claude, open for the lenient tool', () => {
    const Limits = a.object({ limits: a.record(a.number()) });
    const req = ModelProfile.of(ANTHROPIC_STRICT).request([tool('strict', Limits, 2), tool('loose', Limits, false)]);
    expect((req.get('strict').jsonSchema!.properties as any).limits.type).toBe('array');
    expect((req.get('loose').jsonSchema!.properties as any).limits.type).toBe('object');
    expect(req.get('strict').parse({ limits: [{ key: 'a', value: 1 }] })).toMatchObject({ ok: true, value: { limits: { a: 1 } } });
    expect(req.get('loose').parse({ limits: { a: 1 } })).toMatchObject({ ok: true, value: { limits: { a: 1 } } });
    expect(req.get('strict').encodeText({ limits: { a: 1 } })).toBe('{"limits":[{"key":"a","value":1}]}');
  });

  it('a lenient model: nothing strict, nothing adjusted', () => {
    const req = ModelProfile.of(LENIENT).request([tool('t'), { kind: 'output', schema: Q }]);
    expect(req.entries.map((e) => [e.strict, e.adjustments.length])).toEqual([[false, 0], [false, 0]]);
  });

  it('bound dynamic bundles and static schemas both go in; unknown names and duplicates are reported', () => {
    const Dyn = a.define({ Row: a.object({ f: a.ref('Field') }) }).dynamic((fields: [string, ...string[]]) => ({ Field: a.enum(fields) })).result('Row');
    const req = ModelProfile.of(OPENAI_STRICT).request([tool('rows', Dyn.bind(['x', 'y'])), tool('rows', Q)]);
    expect(req.problems).toEqual(['two schemas are named "rows"']);
    expect(() => req.get('nope' as never)).toThrow('no schema named "nope"');
  });
});
