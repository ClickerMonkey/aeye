/**
 * Phil: "Let's make sure if too many tools request strict or anything about a
 * request can't be supported we have proper degradation and not errors.
 * Sometimes the tools are not known ahead of time and error when we don't
 * have to is not good."
 *
 * Requests built from arbitrary tool lists — none, one, over the provider's
 * tool cap, all strict, mixed, huge, recursive, with features the dialect
 * lacks — always come back sendable, record what they degraded, and decode
 * the model's answers (a dispatcher call back to the original tool).
 */
import { describe, expect, it } from 'vitest';
import {
  a, ANTHROPIC_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, MINIMAL, ModelProfile, OLLAMA, OPENAI_STRICT, XAI_STRICT,
  profileFor, RequestLimitError, type Profile, type RequestItem,
} from '../index';
import { dialectProblems, validate } from './corpus/_check';

const huge = a.object({ fn: a.enum(Array.from({ length: 1200 }, (_, i) => `fn_${i}`)) });
const optionals = (n: number) => a.object(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, a.string().optional()])));
const deep = a.object({ a: a.object({ b: a.object({ c: a.object({ d: a.object({ e: a.object({ f: a.object({ g: a.object({ h: a.object({ i: a.object({ j: a.object({ k: a.string() }) }) }) }) }) }) }) }) }) }) });

/** A varied tool: one of several hard shapes, cycling. */
const KINDS = [
  { schema: a.object({ q: a.string(), limit: a.int().min(1).optional() }), sample: { q: 'x', limit: 3 } },
  { schema: a.object({ tags: a.record(a.number()), at: a.tuple([a.number(), a.string()]) }), sample: { tags: { a: 1 }, at: [1, 'x'] } },
  { schema: a.object({}), sample: undefined }, // slot 2 is TreeTool (a recursive bundle)
  { schema: a.object({ doc: a.json(), pick: a.union([a.string(), a.object({ id: a.int() })]) }), sample: { doc: { any: [1] }, pick: { id: 2 } } },
  { schema: huge, sample: { fn: 'fn_1199' } },
  { schema: optionals(30), sample: { f3: 'x' } },
  { schema: deep, sample: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: 'deep' } } } } } } } } } } } },
] as const;

const tools = (n: number, strict?: (i: number) => boolean | number | undefined): RequestItem[] =>
  Array.from({ length: n }, (_, i) => {
    const k = KINDS[i % KINDS.length]!;
    const s = strict?.(i);
    return { kind: 'tool' as const, name: `tool_${i}`, schema: (i % KINDS.length === 2 ? TreeTool : k.schema) as never, description: `Tool number ${i}.`, ...(s !== undefined ? { strict: s } : {}) };
  });
const TreeTool = a.define({ Node: a.object({ label: a.string(), kids: a.array(a.ref('Node')) }) }).result(a.object({ tree: a.ref('Node') }));
const sampleOf = (i: number): unknown => (i % KINDS.length === 2 ? { tree: { label: 'r', kids: [{ label: 'k', kids: [] }] } } : KINDS[i % KINDS.length]!.sample);

/** A provider with small caps, to exercise the dispatcher and strict slots on any dialect. */
const capped = (p: Profile, maxStrictTools = 2): Profile => Object.freeze({ ...p, id: `${p.id}+caps${maxStrictTools}`, request: { maxTools: 5, maxStrictTools, ...(p.request?.totals ? { totals: p.request.totals } : {}) } });

const TARGETS: Record<string, ModelProfile> = {
  'gpt (toolsStrict)': profileFor({ id: 'gpt-5.4', provider: 'openai', capabilities: ['toolsStrict', 'structured', 'json'] }),
  'claude (strict)': ModelProfile.of(ANTHROPIC_STRICT),
  'claude-3 (no structured)': profileFor({ id: 'claude-3-haiku', provider: 'anthropic', capabilities: ['tools'] }),
  gemini: ModelProfile.of(GOOGLE_STRICT),
  'gemini openapi': ModelProfile.of(GOOGLE_OPENAPI),
  grok: ModelProfile.of(XAI_STRICT),
  ollama: ModelProfile.of(OLLAMA),
  lenient: ModelProfile.of(LENIENT),
  'minimal, capped': ModelProfile.of(capped(MINIMAL)),
  'openai strict, capped': ModelProfile.of(capped(OPENAI_STRICT)),
};

/** Everything a provider is given, and every answer decoded back. */
function check(target: ModelProfile, items: RequestItem[]): string[] {
  const out: string[] = [];
  const req = target.request(items);
  const limits = req.limits;
  if (limits.maxTools !== undefined && req.sent.length > limits.maxTools) out.push(`sent ${req.sent.length} tools (limit ${limits.maxTools})`);
  if (limits.maxStrictTools !== undefined && req.sent.filter((e) => e.strict).length > limits.maxStrictTools) out.push('too many strict tools sent');
  for (const e of req.sent) {
    const js = e.jsonSchema;
    if (!js) { out.push(`${e.name}: nothing to send`); continue; }
    if (e.strict) for (const p of dialectProblems(js, e.profile)) out.push(`${e.name}: ${p}`);
  }
  items.forEach((item, i) => {
    if (item.kind !== 'tool') return;
    const call = req.encodeCall(item.name, sampleOf(i));
    const sent = req.sent.find((e) => e.name === call.name);
    if (!sent) { out.push(`${item.name}: encoded to a tool that isn't sent (${call.name})`); return; }
    for (const p of validate(sent.jsonSchema!, call.args)) out.push(`${item.name} via ${call.name}: ${p}`);
    const back = req.decodeCall(call.name, JSON.parse(JSON.stringify(call.args)));
    if (!back.ok) out.push(`${item.name}: decode failed ${back.message}`);
    else if (back.tool !== item.name || JSON.stringify(back.value) !== JSON.stringify(sampleOf(i))) out.push(`${item.name}: decoded as ${back.tool} ${JSON.stringify(back.value)}`);
  });
  return out;
}

describe('a request is always sendable, whatever the tools', () => {
  for (const [label, target] of Object.entries(TARGETS)) {
    for (const n of [0, 1, 7, 129, 300]) {
      it(`${label}: ${n} tools, mixed strictness`, () => {
        expect(() => target.request(tools(n, (i) => (i % 3 === 0 ? true : i % 3 === 1 ? undefined : false)))).not.toThrow();
        expect(check(target, tools(n, (i) => (i % 3 === 0 ? true : i % 3 === 1 ? undefined : false)))).toEqual([]);
      });
    }
    it(`${label}: 40 tools, all strict: true, plus a huge structured output`, () => {
      const items: RequestItem[] = [...tools(40, () => true), { kind: 'output', schema: a.define({ Node: a.object({ label: a.string(), kids: a.array(a.ref('Node')) }) }).result(a.object({ report: optionals(40), tree: a.ref('Node') })), strict: true }];
      const req = target.request(items);
      expect(check(target, items.slice(0, 40))).toEqual([]);
      const o = req.output!;
      // the output is sendable too: structured, or prompt text the model is told to follow
      expect(o.delivery === 'prompt' ? o.promptText.length > 0 : !!o.jsonSchema).toBe(true);
    });
  }
});

describe('the dispatcher', () => {
  const gpt = TARGETS['gpt (toolsStrict)']!;

  it('300 tools on OpenAI: the 127 highest-priority are sent as tools, the rest behind run_tool, decoded back to the real tool', () => {
    const items = tools(300, (i) => (i >= 250 ? 5 : undefined));
    const req = gpt.request(items);
    expect(req.sent.length).toBe(128);
    // priority decides who stays a tool: the strict: 5 ones (250..299) all do
    for (let i = 250; i < 300; i++) expect(req.get(`tool_${i}` as never).delivery).toBe('structured');
    const d = req.dispatcher!;
    expect(d.name).toBe('run_tool');
    expect(req.degradations[0]).toBe('300 tools (limit 128): 173 go through "run_tool"');
    expect(req.get('tool_200' as never).adjustments.at(-1)).toMatchObject({ kind: 'dispatched', via: 'run_tool' });
    // the model calls the dispatcher; the caller sees the original tool and typed args
    const res = req.decodeCall('run_tool', { tool: 'tool_204', args: { tags: [{ key: 'a', value: 1 }], at: { 0: 1, 1: 'x' } } });
    expect(res).toEqual({ ok: true, tool: 'tool_204', value: { tags: { a: 1 }, at: [1, 'x'] }, via: 'run_tool' });
    // a wrong tool name or wrong args: reported where the model wrote them
    const bad = req.decodeCall('run_tool', { tool: 'tool_204', args: { tags: [{ key: 'a', value: 'x' }], at: { 0: 1, 1: 'x' } } });
    expect(!bad.ok && [bad.tool, bad.issues.map((i) => [i.path, i.codePath])]).toEqual(['tool_204', [[['args', 'tags', 0, 'value'], ['args', 'tags', 'a']]]]);
    const ghost = req.decodeCall('run_tool', { tool: 'nope', args: {} });
    expect(!ghost.ok && ghost.issues[0]!.path).toEqual(['tool']);
    // a direct tool decodes as itself
    expect(req.decodeCall('tool_252', { q: 'x', limit: null })).toEqual({ ok: true, tool: 'tool_252', value: { q: 'x' } });
  });

  it('the dispatcher lists the overflow tools with their descriptions; on a dialect without unions it is one field per tool', () => {
    const req = ModelProfile.of(capped(MINIMAL, 10)).request(tools(8));
    expect(req.dispatcher!.strict).toBe(true);
    const js = req.dispatcher!.jsonSchema as any;
    expect(js.properties.tool.description).toContain('- tool_7: Tool number 7.');
    expect(Object.keys(js.properties.args.properties)).toEqual(['tool_4', 'tool_5', 'tool_6', 'tool_7']);
    const call = req.encodeCall('tool_5', sampleOf(5));
    expect(call.name).toBe('run_tool');
    expect(req.decodeCall(call.name, call.args)).toMatchObject({ ok: true, tool: 'tool_5' });
  });

  it('a dispatcher name taken by a tool is made unique; duplicate tool names are renamed, both reachable', () => {
    const items: RequestItem[] = [...tools(6), { kind: 'tool', name: 'run_tool', schema: a.object({ x: a.string() }) }, { kind: 'tool', name: 'tool_0', schema: a.object({ y: a.int() }) }];
    const req = ModelProfile.of(capped(OPENAI_STRICT)).request(items);
    expect(req.dispatcher!.name).toBe('run_tool_2');
    expect(req.degradations).toContain('"tool_0" is named twice; the second is "tool_0_2"');
    const call = req.encodeCall('tool_0_2', { y: 1 });
    expect(req.decodeCall(call.name, call.args)).toMatchObject({ ok: true, tool: 'tool_0', value: { y: 1 } });
  });

  it('named types that clash between dispatched tools: the clashing tool takes JSON args, checked against its own schema', () => {
    const A = a.define({ Item: a.object({ n: a.int() }) }).result(a.object({ item: a.ref('Item') }));
    const B = a.define({ Item: a.object({ s: a.string() }) }).result(a.object({ item: a.ref('Item') }));
    const items: RequestItem[] = [...tools(4), { kind: 'tool', name: 'a', schema: A, strict: false }, { kind: 'tool', name: 'b', schema: B, strict: false }];
    const req = ModelProfile.of(capped(OPENAI_STRICT)).request(items);
    expect(req.decodeCall('run_tool', { tool: 'a', args: { item: { n: 1 } } })).toMatchObject({ ok: true, tool: 'a', value: { item: { n: 1 } } });
    expect(req.decodeCall('run_tool', { tool: 'b', args: '{"item":{"s":"x"}}' })).toMatchObject({ ok: true, tool: 'b', value: { item: { s: 'x' } } });
    expect(req.decodeCall('run_tool', { tool: 'b', args: '{"item":{"n":1}}' }).ok).toBe(false);
  });
});

describe('degradations are information; errors only on request', () => {
  it('nothing degraded: empty; something degraded: listed, assertNoDegradation / failOnDegrade throw', () => {
    const claude = ModelProfile.of(ANTHROPIC_STRICT);
    expect(claude.request(tools(2)).degradations).toEqual([]);
    const req = claude.request(tools(25, () => true));
    expect(req.degradations.length).toBeGreaterThan(0);
    expect(() => req.assertNoDegradation()).toThrow(RequestLimitError);
    expect(() => claude.request(tools(25, () => true), { failOnDegrade: true })).toThrow(RequestLimitError);
    expect(() => claude.request(tools(25, () => true))).not.toThrow();
  });

  it('strict tools past Anthropic\'s 20 slots go non-strict (lowest priority first), still validated on decode', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request(Array.from({ length: 25 }, (_, i) => ({ kind: 'tool' as const, name: `t${i}`, schema: a.object({ q: a.string() }), strict: i < 5 ? true : 3 })));
    expect(req.strictTools).toBe(20);
    expect(req.sent.filter((e) => !e.strict).map((e) => e.name)).toEqual(['t20', 't21', 't22', 't23', 't24']);
    expect(req.get('t24').parse({ q: 5 }).ok).toBe(false);
  });

  it('an output on a model with no structured output, or one too big for the budget, goes as prompt text', () => {
    const old = TARGETS['claude-3 (no structured)']!;
    const o = old.request([{ kind: 'output', schema: deep }]).output!;
    expect([o.delivery, o.jsonSchema]).toEqual(['prompt', undefined]);
    expect(o.parse(KINDS[6].sample).ok).toBe(true);
  });
});
