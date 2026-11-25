/**
 * Requests degrade, never error (Phil, packages/schema/DESIGN.md): every
 * schema of a request is fitted together for the model it goes to, and a
 * Prompt run through a planning provider still works when the request is
 * more than the provider takes. Tool lists from the schema corpus's
 * request-degrade cases (packages/schema/src/__tests__/request-degrade.test.ts).
 */
import { a } from '@aeye/schema';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { planRequest, prepareRequest } from '../schema';
import type { Request, ToolDefinition } from '../types';
import { MODELS, plannedExecutor, type PlannedTurn, type Sent } from './mocks/planned';

/** `n` tools `t0..t{n-1}`, each recording its calls; every 3rd has a record arg, every 5th a recursive one. */
function makeTools(n: number, strict: (i: number) => boolean | number = () => 1) {
  const calls: { tool: string; input: unknown }[] = [];
  const Tree = a.define({ Node: a.object({ label: a.string(), kids: a.array(a.ref('Node')) }) }).result(a.object({ tree: a.ref('Node'), n: a.int() }));
  const tools = Array.from({ length: n }, (_, i) => new Tool({
    name: `t${i}`,
    description: `Tool number ${i}`,
    schema: (i % 5 === 4 ? Tree
      : i % 3 === 2 ? a.object({ n: a.int(), tags: a.record(a.string()) })
      : a.object({ n: a.int(), note: a.string().optional() })) as typeof Tree,
    strict: strict(i),
    call: (input: any) => { calls.push({ tool: `t${i}`, input }); return `t${i}:${input.n}`; },
  }));
  return { tools, calls };
}

async function run(tools: Tool<any, any, any, any, any, any, any>[], model: Parameters<typeof plannedExecutor>[0], turns: ReadonlyArray<PlannedTurn | ((sent: Sent) => PlannedTurn)>) {
  const { execute, sent } = plannedExecutor(model, turns);
  const prompt = new Prompt({ name: 'p', description: 'p', content: 'Use the tools.', tools, toolRetries: 3 } as any);
  const events: any[] = [];
  let error: unknown;
  try {
    for await (const event of prompt.get('stream', {}, { execute } as any)) events.push(event);
  } catch (e) {
    error = e;
  }
  const toolMessages = events.filter(e => e.type === 'message' && e.message.role === 'tool').map(e => e.message.content as string);
  return { events, sent, toolMessages, error };
}

describe('more tools than the provider takes: the dispatcher', () => {
  it('129 tools on OpenAI: 127 sent directly plus run_tool; a dispatched call runs the original tool', async () => {
    const { tools, calls } = makeTools(129, (i) => (i < 100 ? 2 : 1));
    // t128 has the lowest priority and is last, so it goes behind the dispatcher.
    const { sent, toolMessages, events, error } = await run(tools, MODELS.gpt, [
      { calls: [{ tool: 't128', args: { n: 7, tags: { k: 'v' } } }, { tool: 't0', args: { n: 1 } }] },
      { content: 'done' },
    ]);
    expect(error).toBeUndefined();
    const names = sent[0]!.tools.map(t => t.name);
    expect(names).toHaveLength(128);
    expect(names).toContain('run_tool');
    expect(names).not.toContain('t128');
    const plan = sent[0]!.request.plan!;
    expect(plan.get('t128')).toMatchObject({ delivery: 'dispatched', via: 'run_tool' });
    expect(plan.degradations.join('\n')).toMatch(/129 tools \(limit 128\)/);
    // The model's call names run_tool; the prompt runs t128 with its own decoded args.
    expect(events.find(e => e.type === 'message' && e.message.role === 'assistant')!.message.toolCalls[0].name).toBe('run_tool');
    expect(toolMessages).toEqual(['t128:7', 't0:1']);
    expect(calls).toEqual([{ tool: 't128', input: { n: 7, tags: { k: 'v' } } }, { tool: 't0', input: { n: 1 } }]);
    expect(events.filter(e => e.type === 'toolOutput').map(e => e.tool.name)).toEqual(['t128', 't0']);
  });

  it('300 tools: every dispatched call (records, recursion) comes back as its tool', async () => {
    const { tools, calls } = makeTools(300);
    const picks = [130, 142, 299, 4];
    const args = (i: number) => (i % 5 === 4 ? { tree: { label: 'r', kids: [{ label: 'k', kids: [] }] }, n: i } : i % 3 === 2 ? { n: i, tags: { a: 'b' } } : { n: i });
    const { toolMessages, sent } = await run(tools, MODELS.gpt, [{ calls: picks.map(i => ({ tool: `t${i}`, args: args(i) })) }, { content: 'done' }]);
    expect(sent[0]!.tools).toHaveLength(128);
    expect(toolMessages).toEqual(picks.map(i => `t${i}:${i}`));
    expect(calls.map(c => c.input)).toEqual(picks.map(args));
  });

  it("a dispatcher call naming no tool says what it meant", async () => {
    const { tools } = makeTools(129);
    const { toolMessages } = await run(tools, MODELS.gpt, [
      { raw: [{ name: 'run_tool', arguments: JSON.stringify({ tool: 't1288', args: { n: 1, tags: [] } }) }] },
      { content: 'done' },
    ]);
    expect(toolMessages[0]).toMatch(/did you mean `t128`/);
  });

  it('a dispatched tool with bad args is told in its own terms', async () => {
    const { tools } = makeTools(129);
    const { toolMessages } = await run(tools, MODELS.gpt, [
      { raw: [{ name: 'run_tool', arguments: JSON.stringify({ tool: 't128', args: { n: 'seven', tags: [] } }) }] },
      { content: 'done' },
    ]);
    expect(toolMessages[0]).toContain('the arguments of t128 (called through run_tool)');
    expect(toolMessages[0]).toContain('args.n: Expected a number, got string.');
  });
});

describe('strict slots and request totals run out: degrade, never error', () => {
  it('25 strict: true tools on Claude: 20 go strict, the rest non-strict and still validated', async () => {
    const { tools, calls } = makeTools(25, () => true);
    const { sent, toolMessages, error } = await run(tools, MODELS.claude, [
      { calls: [{ tool: 't23', args: { n: 3, tags: { a: 'b' } } }] },
      { raw: [{ name: 't22', arguments: '{"n":"x"}' }] },
      { content: 'done' },
    ]);
    expect(error).toBeUndefined();
    const strict = sent[0]!.tools.filter(t => t.strict);
    expect(strict.length).toBeLessThanOrEqual(20);
    expect(sent[0]!.tools).toHaveLength(25);
    const plan = sent[0]!.request.plan!;
    expect(plan.degradations.some(d => /not strict/.test(d))).toBe(true);
    const loose = plan.tools.filter(e => !e.strict);
    expect(loose.length).toBeGreaterThanOrEqual(5);
    expect(loose[0]!.adjustments.some(x => x.kind === 'not-strict')).toBe(true);
    expect(toolMessages[0]).toBe('t23:3');
    expect(toolMessages[1]).toMatch(/n: Expected a number, got string/);
    expect(calls).toHaveLength(1);
  });

  it("Claude's 24 optional parameters per request: optionals go as null, the call still decodes to absent keys", async () => {
    const opt = (i: number) => new Tool({
      name: `o${i}`,
      description: 'o',
      schema: a.object(Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`f${k}`, a.string().optional()]))),
      strict: true,
      call: (input) => JSON.stringify(input),
    });
    const tools = Array.from({ length: 6 }, (_, i) => opt(i));
    const { sent, toolMessages } = await run(tools, MODELS.claude, [{ calls: [{ tool: 'o5', args: { f0: 'a' } }] }, { content: 'done' }]);
    const plan = sent[0]!.request.plan!;
    expect(plan.used.optional).toBeLessThanOrEqual(24);
    expect(plan.tools.some(e => e.adjustments.some(x => x.kind === 'optional-as-null' || x.kind === 'not-strict'))).toBe(true);
    expect(toolMessages).toEqual(['{"f0":"a"}']);
  });

  it('a request never throws, even when every schema is extreme', () => {
    const Deep = a.define({ N: a.object({ v: a.enum(Array.from({ length: 2000 }, (_, i) => `v${i}`)), next: a.ref('N').optional() }) }).result('N');
    const tools = Array.from({ length: 40 }, (_, i) => ({ name: `d${i}`, parameters: Deep.bind(), strict: true as const }));
    const request: Request = { messages: [], tools, responseFormat: { type: Deep.bind(), strict: true } };
    for (const model of Object.values(MODELS)) {
      expect(() => planRequest(request, model)).not.toThrow();
    }
  });
});

describe('prepareRequest', () => {
  it('pins the plan on the definitions and the format, and returns a copy carrying it', async () => {
    const tools: ToolDefinition[] = [{ name: 'x', parameters: a.object({ n: a.int() }).bind(), strict: 1 }];
    const responseFormat = { type: a.object({ ok: a.boolean() }).bind(), strict: 1 };
    const request: Request = { messages: [{ role: 'system', content: 'sys' }], tools, responseFormat };
    const sent = await prepareRequest(request, MODELS.gpt);
    expect(sent).not.toBe(request);
    expect(sent.plan).toBe(tools[0]!.plan as unknown);
    expect((responseFormat as any).plan).toBe(sent.plan);
    expect(request.plan).toBeUndefined();
    expect(sent.plan!.get('x').strict).toBe(true);
  });

  it("speaks: a family the provider can't send gets lenient schemas", async () => {
    const tools = [{ name: 'x', parameters: a.object({ tags: a.record(a.string()) }).bind(), strict: 1 }];
    const sent = await prepareRequest({ messages: [], tools }, MODELS.routedClaude, { speaks: new Set(['openai']) });
    expect(sent.plan!.get('x').profile.family).toBe('lenient');
    expect(sent.plan!.get('x').strict).toBe(false);
  });
});
