/**
 * @aeye/core's request budgets and size limits (packages/core/src/schema/
 * budget.ts, analyze.ts, expressible.ts; __tests__/schema-budget.test.ts,
 * schema-size-limits.test.ts, can-express.test.ts, schema-rebuilt-lazy.test.ts)
 * reproduced with @aeye/schema's `ModelProfile.request`: what each schema
 * counts (`measure`), strict slots, optional/union totals, per-schema size
 * limits, output delivery, and parse/encode through the entry.
 *
 * Core's `SchemaBudget.allocateTool/allocateOutput` returned a descriptor;
 * here each request entry records `strict`, `profile`, `adjustments` and
 * `reasons`. Deliberate differences are marked DELIBERATE; gaps are
 * `it.fails('GAP: ...')`.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_NON_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OPENAI_NON_STRICT, OPENAI_STRICT, overLimits,
  profileFor, strictPriority, type Profile, type RequestItem, type SchemaLimits,
} from '../../index';
import { profileProblems, unexplained } from './_check';
import * as S from './core-schema';

const claude = ModelProfile.of(ANTHROPIC_STRICT);
const gpt = ModelProfile.of(OPENAI_STRICT);
const tools = (n: number, schema: RequestItem['schema'], strict?: boolean | number): RequestItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'tool', name: `t${i}`, schema, ...(strict !== undefined ? { strict } : {}) }));
const compile = (t: string) => Handlebars.compile(t, { noEscape: true });

describe('what a schema counts (core:schema-budget.test.ts:24-70, schema-size-limits.test.ts:113-178)', () => {
  it('optional parameters in nested objects; under null-for-absent they become unions', () => {
    expect(S.Person.render(LENIENT).measure).toMatchObject({ optional: 2, unions: 0 });
    expect(S.Person.render(OPENAI_STRICT).measure).toMatchObject({ optional: 0, unions: 2 });
  });
  it('unions including nullables', () => {
    expect(S.PayloadMaybe.render(LENIENT).measure.unions).toBe(2);
  });
  it('every enum separately, with its value count and characters', () => {
    expect(S.TwoEnums.render(LENIENT).measure.enums).toEqual([{ values: 2, chars: 4 }, { values: 1, chars: 3 }]);
  });
  it('DELIBERATE: a single literal is an enum of one (core: a `const`, outside the enum budget); its characters count either way', () => {
    const m = S.FixedTag.render(LENIENT).measure;
    expect(m.enums).toEqual([{ values: 1, chars: 5 }]);
    expect(m.stringChars).toBe('tag'.length + 'fixed'.length);
  });
  it('properties summed over every level; depth of the deepest container; wrappers are transparent', () => {
    expect(S.ABCDE.render(LENIENT).measure).toMatchObject({ properties: 5, depth: 3 });
    expect(S.WrappedB.render(LENIENT).measure.depth).toBe(S.BareB.render(LENIENT).measure.depth);
    expect(S.RowsX.render(LENIENT).measure.depth).toBe(3);
    expect(S.Pick.render(LENIENT).measure.stringChars).toBe('pick'.length + 'alpha'.length + 'beta'.length);
  });
  it('records and tuples count as what goes on the wire (pairs: key + value)', () => {
    expect(S.TagsPair.render(LENIENT).measure.properties).toBe(2);
    expect(S.TagsPair.render(OPENAI_STRICT).measure.properties).toBe(2 + 2 + 2); // tags, pair + {key,value} + {"0","1"}
  });
  it('terminates on recursion and still counts', () => {
    expect(S.ValueNode.render(LENIENT).measure.properties).toBeGreaterThan(0);
    expect(S.ValueNode.render(ANTHROPIC_STRICT).measure.properties).toBeGreaterThan(0);
  });
  it('the measure is memoized per rendering', () => {
    const r = S.Simple.render(LENIENT);
    expect(r.measure).toBe(r.measure);
  });
});

describe('strictPriority (core:schema-budget.test.ts:73-83)', () => {
  it('maps the tri-state to a priority', () => {
    expect([true, false, 5, 1, 0, -2, undefined].map(strictPriority)).toEqual([Infinity, -Infinity, 5, 1, 0, 0, 0]);
  });
});

describe('basic allocation (core:schema-budget.test.ts:99-133)', () => {
  it('strict: false → the family\'s non-strict profile (never the family-blind LENIENT)', () => {
    const e = gpt.request([{ kind: 'tool', name: 'f', schema: S.Simple, strict: false }]).get('f');
    expect(e.strict).toBe(false);
    expect(e.profile).toBe(OPENAI_NON_STRICT);
    expect(e.adjustments).toEqual([{ kind: 'not-strict', reason: 'strict: false' }]);
  });
  it('strict: true and numbers → the strict profile itself (not a clone), uncapped on OpenAI', () => {
    const req = gpt.request([{ kind: 'tool', name: 'a', schema: S.Simple, strict: true }, { kind: 'tool', name: 'b', schema: S.Simple, strict: 5 }, { kind: 'tool', name: 'c', schema: S.Simple, strict: 1 }]);
    for (const e of req.entries) { expect(e.strict).toBe(true); expect(e.profile).toBe(OPENAI_STRICT); }
    expect(req.get('a').profile.id).toBe('openai-strict');
  });
  it('strict 0 → non-strict; DELIBERATE: unset is the documented default 1 (prefer strict), not 0', () => {
    const req = gpt.request([{ kind: 'tool', name: 'zero', schema: S.Simple, strict: 0 }, { kind: 'tool', name: 'unset', schema: S.Simple }]);
    expect(req.get('zero')).toMatchObject({ strict: false, adjustments: [{ kind: 'not-strict', reason: 'strict not requested' }] });
    expect(req.get('unset').strict).toBe(true);
  });
  it('a LENIENT model never sends strict', () => {
    const e = ModelProfile.of(LENIENT).request([{ kind: 'tool', name: 't', schema: S.Simple, strict: true }]).get('t');
    expect(e.strict).toBe(false);
    expect(e.profile.id).toBe('lenient[root=object]');
  });
});

describe('Anthropic per-request limits (core:schema-budget.test.ts:135-199)', () => {
  it('20 strict tools for numeric priorities, then the family\'s non-strict profile', () => {
    const req = claude.request(tools(25, S.Simple, 5));
    expect(req.strictTools).toBe(20);
    const loose = req.entries.filter((e) => !e.strict);
    expect(loose).toHaveLength(5);
    expect(loose[0]!.profile).toBe(ANTHROPIC_NON_STRICT);
    expect(loose[0]!.adjustments).toEqual([{ kind: 'not-strict', reason: '"t20": no strict tool slots left (limit 20)' }]);
  });

  it('DELIBERATE: strict: true is the strongest preference — past 20 slots it degrades with a reason (core said nothing); erroring is opt-in', () => {
    const req = claude.request(tools(25, S.Simple, true));
    expect(req.strictTools).toBe(20);
    const loose = req.entries.filter((e) => !e.strict);
    expect(loose).toHaveLength(5);
    expect(loose[0]!.adjustments[0]).toMatchObject({ kind: 'not-strict' });
    expect(req.degradations).toHaveLength(5);
    expect(unexplained(req)).toEqual([]);
    expect(() => req.assertNoDegradation()).toThrow();
  });

  it('one optional each: bounded by the 20 tool slots first', () => {
    const req = claude.request(tools(30, S.OneOptional, 5));
    expect(req.strictTools).toBe(20);
    expect(req.used.optional).toBe(20);
  });

  it('one union each: 16 union-typed parameters', () => {
    const req = claude.request(tools(20, S.OneUnion, 5));
    expect(req.strictTools).toBe(16);
    expect(req.used.unions).toBe(16);
    expect(req.get('t16').adjustments[0]).toMatchObject({ kind: 'not-strict' });
  });

  it('DELIBERATE: recursive and "any" schemas stay STRICT on Anthropic, as JSON text (core degraded both to non-strict)', () => {
    const req = claude.request([
      { kind: 'tool', name: 'node', schema: S.ValueNode, strict: true },
      { kind: 'tool', name: 'data', schema: S.DataUnknown, strict: true },
      { kind: 'tool', name: 'str', schema: S.DataString, strict: true },
    ]);
    for (const e of req.entries) { expect(e.strict).toBe(true); expect(e.profile).toBe(ANTHROPIC_STRICT); expect(e.adjustments).toEqual([]); }
    expect(req.get('data').parse({ data: '{"k":1}' })).toMatchObject({ ok: true, value: { data: { k: 1 } }, stats: { parsed: 1 } });
    expect(req.get('node').parse({ value: 'r', children: ['{"value":"c"}'] })).toMatchObject({ ok: true, value: { value: 'r', children: [{ value: 'c' }] } });
  });

  it('a schema whose optionals ALONE exceed the budget degrades, even under strict: true', () => {
    const e = claude.request([{ kind: 'tool', name: 'wide', schema: S.optionals(25), strict: true }]).get('wide');
    expect(e.strict).toBe(false);
    expect(e.profile).toBe(ANTHROPIC_NON_STRICT);
    expect(e.reasons).toEqual(['"wide" alone: 25 optional properties (limit 24)']);
  });
});

describe('shared between tools and the output (core:schema-budget.test.ts:201-236)', () => {
  const req = claude.request([
    { kind: 'tool', name: 'w1', schema: S.Wide13, strict: 5 },
    { kind: 'tool', name: 'w2', schema: S.Wide13, strict: 5 },
    { kind: 'output', schema: S.SmallX, strict: 5 },
  ]);

  it('the first wide tool fits as is', () => {
    expect(req.get('w1')).toMatchObject({ strict: true, adjustments: [], reasons: [] });
    expect(req.get('w1').profile).toBe(ANTHROPIC_STRICT);
  });

  it('DELIBERATE: the second spends union budget instead (absent optionals written null) and STAYS strict (core: non-strict)', () => {
    const w2 = req.get('w2');
    expect(w2.strict).toBe(true);
    expect(w2.profile.id).toBe('anthropic-strict[optional=null]');
    expect(w2.adjustments).toEqual([{ kind: 'optional-as-null' }]);
    expect(w2.reasons).toEqual(['"w2" with the request so far: 26 optional properties (limit 24)']);
    expect(req.used).toMatchObject({ optional: 13, unions: 13 });
    // Parse and encode follow the choice, per entry.
    expect(w2.parse({ a: 'x', b: null, c: 'y', d: null, e: null, f: null, g: null, h: null, i: null, j: null, k: null, l: null, m: null, n: null }))
      .toMatchObject({ ok: true, value: { a: 'x', c: 'y' }, stats: { edits: 12 } });
    expect(w2.encode({ a: 'x' })).toMatchObject({ a: 'x', b: null, n: null });
    expect(req.get('w1').encode({ a: 'x' })).toEqual({ a: 'x' });
    // The helpers show each tool's own shape.
    const t = compile('{{encode v}}');
    expect(t({ v: { a: 'x', b: 'y' } }, { helpers: req.helpers('w1') })).toBe('{"a":"x","b":"y"}');
    expect(t({ v: { a: 'x', b: 'y' } }, { helpers: w2.helpers() })).toBe('{"a":"x","b":"y","c":null,"d":null,"e":null,"f":null,"g":null,"h":null,"i":null,"j":null,"k":null,"l":null,"m":null,"n":null}');
  });

  it('the output competes for the same totals and still fits', () => {
    expect(req.get('output')).toMatchObject({ strict: true, delivery: 'structured' });
    expect(req.get('output').profile).toBe(ANTHROPIC_STRICT);
  });

  it('(was GAP) an optional-NULLABLE field under the optional-as-null variant is anyOf around a type array (two unions where one is needed)', () => {
    const r = claude.request([
      { kind: 'tool', name: 'w1', schema: S.Wide13, strict: 5 },
      { kind: 'tool', name: 'mix', schema: a.object({ ...S.Wide13.shape, z: a.string().nullable().optional() }), strict: 5 },
    ]).get('mix');
    expect((r.jsonSchema!.properties as Record<string, unknown>).z).toEqual({ type: ['string', 'null'], description: 'Write null to leave it out.' });
  });
});

describe('separate tool and output profiles (core:schema-budget.test.ts:251-276)', () => {
  it('tools non-strict when only the output is strict', () => {
    const req = new ModelProfile(OPENAI_NON_STRICT, OPENAI_STRICT).request([{ kind: 'tool', name: 't', schema: S.OptionalA }, { kind: 'output', schema: S.OptionalA }]);
    expect(req.get('t')).toMatchObject({ strict: false });
    expect(req.get('t').profile).toBe(OPENAI_NON_STRICT);
    expect(req.get('output').profile).toBe(OPENAI_STRICT);
    expect(req.get('output').parse({ a: null })).toMatchObject({ ok: true, value: {} });
    expect(req.get('t').parse({})).toMatchObject({ ok: true, value: {} });
  });
  it('output non-strict when only tools are strict', () => {
    const req = new ModelProfile(ANTHROPIC_STRICT, ANTHROPIC_NON_STRICT).request([{ kind: 'tool', name: 't', schema: S.OptionalA }, { kind: 'output', schema: S.OptionalA }]);
    expect(req.get('t').profile).toBe(ANTHROPIC_STRICT);
    expect(req.get('output').strict).toBe(false);
  });
  it('profileFor builds both from capabilities (gpt-audio: strict output, no strict tools)', () => {
    const m = profileFor({ id: 'gpt-audio', provider: 'openai', capabilities: ['structured', 'json'] });
    expect(m.tool).toBe(OPENAI_NON_STRICT);
    expect(m.output).toBe(OPENAI_STRICT);
  });
});

describe('per-schema size limits (core:schema-size-limits.test.ts)', () => {
  it('OpenAI strict declares the post-July-2025 numbers, only OpenAI strict declares any', () => {
    expect(OPENAI_STRICT.limits).toEqual({ maxProperties: 5000, maxDepth: 10, maxStringChars: 120_000, maxEnumValues: 1000, largeEnumValues: 250, maxLargeEnumChars: 15_000 });
    for (const p of [OPENAI_NON_STRICT, LENIENT, ANTHROPIC_STRICT, GOOGLE_STRICT]) expect(p.limits).toBeUndefined();
  });

  it('nothing to say when the dialect publishes no limits, however big the schema', () => {
    const huge = a.object({ pick: a.enum(S.names(5000)) });
    expect(overLimits(huge.render(LENIENT).measure, LENIENT.limits, '#')).toEqual([]);
    expect(claude.request([{ kind: 'tool', name: 'big', schema: a.object({ pick: a.enum(S.names(1200, 4)) }), strict: true }]).get('big').adjustments).toEqual([]);
  });

  it('an ordinary schema passes', () => {
    expect(gpt.request([{ kind: 'tool', name: 'ok', schema: a.object({ a: a.string(), b: a.enum(['x', 'y']) }), strict: true }]).get('ok').adjustments).toEqual([]);
  });

  it('DELIBERATE: 1200 enum values summed over six enums → enums widened, still strict (core: degraded to non-strict)', () => {
    const six = a.object(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, a.enum(S.names(200, 4).map((n) => `${i}${n}`) as [string, ...string[]])])));
    const e = gpt.request([{ kind: 'tool', name: 'six', schema: six, strict: true }]).get('six');
    expect(e.strict).toBe(true);
    expect(e.reasons).toEqual(['"six": 1200 enum values (limit 1000)']);
    expect(e.adjustments).toEqual([{ kind: 'enums-widened', maxEnumValues: 100 }]);
    // Still enforced on decode.
    const answer = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, `${i}nnnn`]));
    expect(e.parse({ ...answer, f0: 'nope' }).ok).toBe(false);
  });

  it('the large-enum character rule needs BOTH halves on the SAME enum', () => {
    const big = gpt.request([{ kind: 'tool', name: 'big', schema: a.object({ pick: a.enum(S.names(260, 100)) }), strict: true }]).get('big');
    expect(big.reasons).toEqual(['"big": an enum of 260 values has 26000 characters (limit 15000 above 250 values)']);
    expect(big.adjustments).toEqual([{ kind: 'enums-widened', maxEnumValues: 250 }]);
    const m = (s: { render(p: Profile): { measure: Parameters<typeof overLimits>[0] } }) => overLimits(s.render(OPENAI_STRICT).measure, OPENAI_STRICT.limits, '#');
    expect(m(a.object({ pick: a.enum(S.names(200, 100)) }))).toEqual([]);
    expect(m(a.object({ many: a.enum(S.names(260, 4)), long: a.enum(S.names(4, 20_000)) }))).toEqual([]);
  });

  it('depth, property count and characters against tiny limits (core:schema-size-limits.test.ts:216-232)', () => {
    const TINY: SchemaLimits = { maxProperties: 4, maxDepth: 2, maxStringChars: 100, maxEnumValues: 10, largeEnumValues: 3, maxLargeEnumChars: 40 };
    const over = (s: { render(p: Profile): { measure: Parameters<typeof overLimits>[0] } }) => overLimits(s.render(LENIENT).measure, TINY, '#');
    expect(over(a.object({ a: a.object({ b: a.object({ c: a.string() }) }) }))).toEqual(['#: 3 levels of nesting (limit 2)']);
    expect(over(a.object(Object.fromEntries(S.names(5, 2).map((n) => [n, a.string()]))))).toEqual(['#: 5 object properties (limit 4)']);
    expect(over(a.object({ a: a.enum(S.names(3, 60)) }))).toEqual(['#: 181 characters of names and enum values (limit 100)']);
    expect(over(a.object({ deep: a.object({ deeper: a.object({ pick: a.enum(S.names(20, 30)) }) }) })).length).toBeGreaterThan(2);
  });

  it('per schema, not per request: the rest stays as it was; 1000 values is still legal', () => {
    const req = gpt.request([
      { kind: 'tool', name: 'over', schema: a.object({ pick: a.enum(S.names(1200, 4)) }), strict: true },
      { kind: 'tool', name: 'fine', schema: S.Simple, strict: true },
      { kind: 'tool', name: 'k', schema: a.object({ pick: a.enum(S.names(1000, 4)) }), strict: true },
    ]);
    expect(req.get('fine')).toMatchObject({ strict: true, adjustments: [] });
    expect(req.get('k')).toMatchObject({ strict: true, adjustments: [] });
    expect(req.get('over').adjustments[0]).toMatchObject({ kind: 'enums-widened' });
  });
});

describe('structured output that can\'t be expressed (core:can-express.test.ts)', () => {
  it('Claude output: 24 optionals fit, 25 go as prompt text', () => {
    expect(claude.request([{ kind: 'output', schema: S.optionals(24) }]).get('output')).toMatchObject({ delivery: 'structured', strict: true });
    const e = claude.request([{ kind: 'output', schema: S.optionals(25) }]).get('output');
    expect(e.delivery).toBe('prompt');
    expect(e.jsonSchema).toBeUndefined();
    expect(e.adjustments).toEqual([{ kind: 'prompt-text', reason: '"output" alone: 25 optional properties (limit 24)' }]);
    expect(e.promptText).toContain('f24?: string');
    expect(e.parse({ f3: 'x' })).toMatchObject({ ok: true, value: { f3: 'x' } });
  });

  it('families with a non-strict output are left alone', () => {
    expect(gpt.request([{ kind: 'output', schema: S.optionals(30) }]).get('output')).toMatchObject({ delivery: 'structured', strict: true });
  });

  it('DELIBERATE: a recursive Claude output is sent structured and strict (core: prompt text, canExpress false)', () => {
    const e = claude.request([{ kind: 'output', schema: S.ValueNode }]).get('output');
    expect(e).toMatchObject({ delivery: 'structured', strict: true });
  });

  it('DELIBERATE: unions on a dialect with no combinators are tagged, not refused (core: canExpress false)', () => {
    expect((S.IdValue.render(MINIMAL).jsonSchema.properties as Record<string, { description?: string }>).value!.description).toBe('Fill exactly one of these fields and set the others to null.');
    expect(S.IdValue.render(MINIMAL).parse({ id: 'a', value: { option1: null, option2: 2 } })).toMatchObject({ ok: true, value: { id: 'a', value: 2 } });
    // A non-root recursive ref with no $defs (core: canExpress false) is JSON text under MINIMAL.
    expect(JSON.stringify(S.InnerNext.render(MINIMAL).jsonSchema)).toContain('type Inner = { label: string; next: Inner }');
    expect(profileProblems(S.IdValue, [{ id: 'a', value: 'x' }, { id: 'b', value: 2 }])).toEqual([]);
    expect(profileProblems(S.KindAorB, [{ kind: 'a', a: 'x' }, { kind: 'b', b: 1 }])).toEqual([]);
    expect(profileProblems(S.NullOpt, [{ a: null }, { a: 's', b: 1 }])).toEqual([]);
    expect(profileProblems(S.Plain, [{ name: 'n', age: 1, tags: [], meta: { active: true } }])).toEqual([]);
  });

  it.fails('GAP: Claude output with strict: false is sent as non-strict structured output, which Claude does not have', () => {
    // core:can-express.test.ts:177 — allocateOutput(…, false) under ANTHROPIC_STRICT kept the strict dialect
    // (structuredOutputAlwaysStrict). Here the entry is `structured` + not strict, i.e. a schema Claude still
    // compiles strictly — it should be strict, or go as prompt text.
    const e = claude.request([{ kind: 'output', schema: S.optionals(1), strict: false }]).get('output');
    expect(e.delivery === 'prompt' || e.strict).toBe(true);
  });
});

describe('a recursive schema rebuilt from a live registry (core:schema-rebuilt-lazy.test.ts)', () => {
  it('the dynamic step runs once per registry version; every walk terminates', () => {
    const calls = { n: 0 };
    const reg = { version: 1, calls };
    const b = S.RebuiltNode.bind(reg);
    expect(S.RebuiltNode.bind({ version: 1, calls })).toBe(b);
    expect(calls.n).toBe(1);
    S.RebuiltNode.bind({ version: 2, calls });
    expect(calls.n).toBe(2);
    for (const p of [LENIENT, OPENAI_STRICT, GOOGLE_STRICT, ANTHROPIC_STRICT]) {
      const text = JSON.stringify(b.render(p).jsonSchema);
      expect(text.length).toBeLessThan(200_000);
      expect(b.render(p).measure.properties).toBeGreaterThan(0);
    }
  });

  it('a Gemini request keeps it strict (guarded recursion through optional/emptiable positions)', () => {
    const e = ModelProfile.of(GOOGLE_STRICT).request([{ kind: 'tool', name: 'n', schema: S.RebuiltNode.bind({ version: 1, calls: { n: 0 } }) }]).get('n');
    expect(e).toMatchObject({ strict: true, adjustments: [] });
    expect(e.profile).toBe(GOOGLE_STRICT);
  });

  it('decodes a tree on OpenAI strict', () => {
    const b = S.RebuiltNode.bind({ version: 3, calls: { n: 0 } });
    const res = b.render(OPENAI_STRICT).parse({ label: 'L', tree: { name: 'a', child: null, children: [{ name: 'b', child: { name: 'c', child: null, children: [] }, children: [] }] } });
    expect(res.ok && res.value).toEqual({ label: 'L', tree: { name: 'a', children: [{ name: 'b', child: { name: 'c', children: [] }, children: [] }] } });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 2, parsed: 0, repaired: 0 });
    expect(profileProblems(b, [{ label: 'L', tree: { name: 'a', children: [{ name: 'b', child: { name: 'c', children: [] }, children: [] }] } }])).toEqual([]);
  });
});
