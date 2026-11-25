/**
 * Tool arguments on @aeye/schema, end to end through a Prompt and a fake
 * provider that plans every request for a real model's profile
 * (`prepareRequest`) and answers the way that model writes.
 *
 * Schemas are from the schema package's corpus (packages/schema/src/
 * __tests__/corpus/core-tools.ts — core's own README/doc/test schemas, ported
 * to `a`), so core is tested on the shapes it documents.
 */
import { a } from '@aeye/schema';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { planRequest } from '../schema';
import type { Context } from '../types';
import { MODELS, plannedExecutor } from './mocks/planned';

// corpus: core:README.md:512 — "same schema, different wire shapes".
const TaggedArgs = a.object({ name: a.string(), tags: a.record(a.string()) });
// corpus: core:tool.test.ts:960 — nested optionals.
const NestedOptionalArgs = a.object({
  a: a.number(),
  b: a.string().optional(),
  inner: a.object({ c: a.number().optional(), d: a.string() }),
});
// corpus: core:README.md:298 — the args vary with the caller's role (was `schema: (ctx) => ...`).
type Role = 'admin' | 'user';
type Action = 'read' | 'write' | 'delete';
let actionBinds = 0;
const ManageDataArgs = a
  .declare<{ Action: Action }>()
  .dynamic(
    (ctx: Context<{ userRole: Role }, {}>) => {
      actionBinds++;
      return { Action: ctx.userRole === 'admin' ? a.enum(['read', 'write', 'delete']) : a.enum(['read']) };
    },
    { key: (ctx) => ctx.userRole },
  )
  .result(a.object({ action: a.ref('Action') }));
// corpus: core:tool.test.ts:408 — a custom `parse` returning a class, now `a.codec`.
class Built {
  constructor(readonly value: number) {}
  doubled(): number { return this.value * 2; }
}
const BuiltArgs = a.codec(a.object({ value: a.number() }), {
  decode: (wire) => new Built(wire.value),
  encode: (built) => ({ value: built.value }),
});

/** Runs a prompt with these tools against a planned model; returns the tool messages, events and what was sent. */
async function run<T extends Tool<any, any, any, any, any, any>[]>(
  tools: T,
  model: Parameters<typeof plannedExecutor>[0],
  turns: Parameters<typeof plannedExecutor>[1],
  ctx: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  const { execute, sent } = plannedExecutor(model, turns);
  const prompt = new Prompt({ name: 'p', description: 'p', content: 'Use the tools.', tools, toolRetries: 3, ...extra } as any);
  const events: any[] = [];
  let error: unknown;
  try {
    for await (const event of prompt.get('stream', {}, { ...ctx, execute } as any)) events.push(event);
  } catch (e) {
    error = e;
  }
  const toolMessages = events.filter(e => e.type === 'message' && e.message.role === 'tool').map(e => e.message.content as string);
  return { events, sent, toolMessages, error };
}

describe('tool arguments: one static schema, every provider profile', () => {
  const seen: unknown[] = [];
  const tag = new Tool({
    name: 'tag',
    description: 'Tags a thing',
    schema: TaggedArgs,
    strict: true,
    call: (input) => { seen.push(input); return 'ok'; },
  });

  const cases: [string, keyof typeof MODELS, (params: any) => void, boolean][] = [
    ['OpenAI strict: records as pairs', 'gpt', (p) => expect(p.properties.tags.type).toBe('array'), true],
    ['OpenAI non-strict: open object', 'gptLoose', (p) => expect(p.properties.tags.additionalProperties).toEqual({ type: 'string' }), false],
    ['Anthropic strict: records as pairs', 'claude', (p) => expect(p.properties.tags.type).toBe('array'), true],
    ['Gemini strict: open object', 'gemini', (p) => expect(p.properties.tags.type).toBe('object'), true],
    ['xAI (tools always strict): open object', 'grok', (p) => expect(p.properties.tags.type).toBe('object'), true],
    ['Ollama: open object, never strict', 'ollama', (p) => expect(p.properties.tags.type).toBe('object'), false],
    ['OpenRouter → Anthropic: the upstream dialect', 'routedClaude', (p) => expect(p.properties.tags.type).toBe('array'), true],
  ];

  it.each(cases)('%s; the call gets the code shape', async (_label, model, checkWire, strict) => {
    seen.length = 0;
    const args = { name: 'n', tags: { color: 'red', size: 'L' } };
    const { sent, toolMessages } = await run([tag], MODELS[model], [{ calls: [{ tool: 'tag', args }] }, { content: 'done' }]);
    const wire = sent[0]!.tools[0]!;
    expect(wire.strict).toBe(strict);
    checkWire(wire.parameters);
    expect(toolMessages).toEqual(['ok']);
    expect(seen).toEqual([args]);
  });

  it('without a planning provider the prompt decodes in the code shape (lenient)', async () => {
    seen.length = 0;
    const { toolMessages } = await run([tag], undefined, [{ raw: [{ name: 'tag', arguments: '{"name":"n","tags":{"a":"b"}}' }] }, { content: 'done' }]);
    expect(toolMessages).toEqual(['ok']);
    expect(seen).toEqual([{ name: 'n', tags: { a: 'b' } }]);
  });

  it('OpenAI strict: a null for a left-out optional is decoded to an absent key, even nested', async () => {
    const tool = new Tool({ name: 'sig', description: 'd', schema: NestedOptionalArgs, call: (input) => input });
    const plan = planRequest({ tools: [(await tool.definition({}))!] }, MODELS.gpt);
    const decoded = await tool.parse({}, JSON.stringify({ a: 1, b: null, inner: { c: null, d: 'x' } }), plan);
    expect(decoded).toEqual({ a: 1, inner: { d: 'x' } });
    expect('b' in decoded).toBe(false);
    expect('c' in decoded.inner).toBe(false);
  });

  it('a codec turns the args into a class instance for `call`', async () => {
    const results: number[] = [];
    const built = new Tool({ name: 'built', description: 'd', schema: BuiltArgs, call: (input) => { results.push(input.doubled()); return 'ok'; } });
    const { toolMessages } = await run([built], MODELS.gpt, [{ calls: [{ tool: 'built', args: new Built(21) }] }, { content: 'done' }]);
    expect(toolMessages).toEqual(['ok']);
    expect(results).toEqual([42]);
  });
});

describe('tool arguments with a dynamic part bound from ctx', () => {
  const manageData = new Tool({
    name: 'manageData',
    description: 'Manage data records',
    instructions: 'Use this tool to read or write data.',
    schema: ManageDataArgs,
    applicable: (ctx: Context<{ userRole: Role; isAuthenticated?: boolean }, {}>) => ctx.isAuthenticated !== false,
    call: (input, _refs, ctx) => `${ctx.userRole}:${input.action}`,
  });

  it('the schema the model sees depends on ctx, and is bound once per key', async () => {
    actionBinds = 0;
    const admin = await run([manageData], MODELS.gpt, [{ calls: [{ tool: 'manageData', args: { action: 'write' } }] }, { content: 'done' }], { userRole: 'admin' });
    expect(admin.toolMessages).toEqual(['admin:write']);
    const sentEnum = (admin.sent[0]!.tools[0]!.parameters as any);
    expect(JSON.stringify(sentEnum)).toContain('"write"');
    const user = await run([manageData], MODELS.gpt, [{ calls: [{ tool: 'manageData', args: { action: 'read' } }] }, { content: 'done' }], { userRole: 'user' });
    expect(user.toolMessages).toEqual(['user:read']);
    expect(JSON.stringify(user.sent[0]!.tools[0]!.parameters)).not.toContain('"write"');
    // Two roles, many binds (each prompt iteration binds again): the dynamic step ran once per role.
    await run([manageData], MODELS.gpt, [{ content: 'done' }], { userRole: 'admin' });
    expect(actionBinds).toBe(2);
  });

  it('a call outside the bound schema is told to the model in its own shape', async () => {
    const { toolMessages, events } = await run([manageData], MODELS.gpt, [
      { raw: [{ name: 'manageData', arguments: '{"action":"write"}' }] },
      { content: 'done' },
    ], { userRole: 'user' });
    expect(toolMessages[0]).toMatch(/^Error parsing tool arguments: 1 problem in the arguments of manageData/);
    expect(toolMessages[0]).toContain('"action": "write"');
    expect(toolMessages[0]).toContain('^^^');
    expect(toolMessages[0]).toMatch(/action: .*read/);
    expect(events.find(e => e.type === 'toolError').failure.kind).toBe('model');
  });

  it('`applicable` hides the tool (was: the schema function returning undefined)', async () => {
    const { sent } = await run([manageData], MODELS.gpt, [{ content: 'done' }], { userRole: 'admin', isAuthenticated: false });
    expect(sent[0]!.tools).toEqual([]);
    expect(sent[0]!.request.tools ?? []).toEqual([]);
  });
});

describe('errorFormat reaches the model at every level', () => {
  const bad = '{"name": 5, "tags": {"a": 1}}';
  const make = (errorFormat?: 'summary' | 'list' | 'markers' | 'full') => new Tool({
    name: 'tag',
    description: 'Tags',
    schema: TaggedArgs,
    ...(errorFormat ? { errorFormat } : {}),
    call: () => 'ok',
  });
  const firstMessage = async (tool: Tool<any, any, any, any, any, any>, ctx: Record<string, unknown> = {}) =>
    (await run([tool], MODELS.gpt, [{ raw: [{ name: 'tag', arguments: bad }] }, { content: 'done' }], ctx)).toolMessages[0]!;

  it("default 'full': the model's JSON with markers and the expected type", async () => {
    const text = await firstMessage(make());
    expect(text).toContain('2 problems in the arguments of tag');
    expect(text).toContain('^');
    expect(text).toContain('name: Expected a string, got number.');
  });

  it("the request level (ctx.errorFormat) applies to every tool", async () => {
    const text = await firstMessage(make(), { errorFormat: 'summary' });
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toMatch(/1 more/);
  });

  it("the tool's own errorFormat wins over ctx", async () => {
    const text = await firstMessage(make('list'), { errorFormat: 'summary' });
    expect(text).toContain('- ');
    expect(text).not.toContain('^');
    expect(text.split('\n').length).toBeGreaterThan(1);
  });

  it('a single parse can override both', async () => {
    const tool = make('full');
    const plan = planRequest({ tools: [(await tool.definition({}))!] }, MODELS.gpt);
    await expect(tool.parse({}, bad, plan, undefined, { errorFormat: { detail: 'summary', maxChars: 80 } })).rejects.toThrow(/^.{1,80}$/);
  });

  it('maxChars is a hard cap on what the model is told', async () => {
    const huge = new Tool({ name: 'tag', description: 'Tags', schema: a.object({ rows: a.array(a.object({ id: a.int() })) }), errorFormat: { maxChars: 300 }, call: () => 'ok' });
    const rows = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: `x${i}` })) });
    const { toolMessages } = await run([huge], MODELS.gpt, [{ raw: [{ name: 'tag', arguments: rows }] }, { content: 'done' }]);
    expect(toolMessages[0]!.length).toBeLessThanOrEqual('Error parsing tool arguments: '.length + 300);
  });
});

describe("instructions show values as the model writes them", () => {
  const example = { name: 'shirt', tags: { color: 'red' } };
  const tag = new Tool({
    name: 'tag',
    description: 'Tags',
    instructions: 'Call it like {{encode example}}. Shape: {{schema}}',
    input: () => ({ example }),
    schema: TaggedArgs,
    call: () => 'ok',
  });

  it('{{encode}} in a tool instruction: pairs for OpenAI strict, an object for Gemini', async () => {
    const gpt = await run([tag], MODELS.gpt, [{ content: 'done' }]);
    expect(gpt.sent[0]!.system).toContain('Call it like {"name":"shirt","tags":[{"key":"color","value":"red"}]}');
    const gemini = await run([tag], MODELS.gemini, [{ content: 'done' }]);
    expect(gemini.sent[0]!.system).toContain('Call it like {"name":"shirt","tags":{"color":"red"}}');
  });

  it('{{schema}} writes the arguments as TypeScript', async () => {
    const { sent } = await run([tag], MODELS.gemini, [{ content: 'done' }]);
    expect(sent[0]!.system).toMatch(/Shape: \{ name: string; tags: /);
  });

  it('the function form gets a value-only encoder', async () => {
    let calls = 0;
    const fnTool = new Tool({
      name: 'tag',
      description: 'Tags',
      instructionsFn: (_ctx, encode) => { calls++; return `Example: ${encode(example)}`; },
      schema: TaggedArgs,
      call: () => 'ok',
    });
    const { sent } = await run([fnTool], MODELS.gpt, [{ content: 'done' }]);
    expect(sent[0]!.system).toContain('Example: {"name":"shirt","tags":[{"key":"color","value":"red"}]}');
    // Rendered in the code shape first, then again for the model once planned.
    expect(calls).toBe(2);
    const encoder = await fnTool.encoder({}, sent[0]!.request.plan);
    expect(encoder.wire(example)).toEqual({ name: 'shirt', tags: [{ key: 'color', value: 'red' }] });
    expect((await fnTool.encoder({}))(example)).toBe(JSON.stringify(example));
  });

  it('instructions that show no schema values render once', async () => {
    let calls = 0;
    const plain = new Tool({ name: 'tag', description: 'Tags', instructionsFn: () => { calls++; return 'Tag things.'; }, schema: TaggedArgs, call: () => 'ok' });
    await run([plain], MODELS.gpt, [{ content: 'done' }]);
    expect(calls).toBe(1);
  });

  it('a template variable named like a helper still wins', async () => {
    const vars = new Tool({ name: 'tag', description: 'Tags', instructions: 'Schema: {{schema}}', input: () => ({ schema: 'mine' }), schema: TaggedArgs, call: () => 'ok' });
    const { sent } = await run([vars], MODELS.gpt, [{ content: 'done' }]);
    expect(sent[0]!.system).toContain('Schema: mine');
  });
});

describe('repairs and size caps', () => {
  it('top-level fields sent as JSON strings are repaired and reported', async () => {
    const program = new Tool({ name: 'program', description: 'd', schema: a.object({ program: a.object({ kind: a.string(), value: a.number() }) }), call: (input) => input.program.value });
    const { events, toolMessages } = await run([program], MODELS.claude, [
      { raw: [{ name: 'program', arguments: JSON.stringify({ program: JSON.stringify({ kind: 'k', value: 7 }) }) }] },
      { content: 'done' },
    ]);
    expect(toolMessages).toEqual(['7']);
    expect(events.find(e => e.type === 'toolArgRepairAttempt')).toMatchObject({ fields: ['program'], success: true });
  });

  it('a repair attempt names its call', async () => {
    const program = new Tool({ name: 'program', description: 'd', schema: a.object({ program: a.object({ kind: a.string() }) }), call: () => 'ok' });
    const { events } = await run([program], MODELS.claude, [
      { raw: [{ name: 'program', arguments: JSON.stringify({ program: JSON.stringify({ kind: 'k' }) }) }] },
      { content: 'done' },
    ]);
    expect(events.find(e => e.type === 'toolArgRepairAttempt')).toMatchObject({ toolCallId: 'raw_0_0' });
  });

  it('a call a relaying provider found invalid is answered with its message, never decoded or run', async () => {
    let ran = 0;
    const program = new Tool({ name: 'program', description: 'd', schema: a.object({ kind: a.string() }), call: () => { ran++; return 'ok'; } });
    const { toolMessages } = await run([program], MODELS.claude, [
      { raw: [{ name: 'program', arguments: '{"kind":"k"}', invalid: 'kind: not that one.' }] },
      { content: 'done' },
    ]);
    expect(ran).toBe(0);
    expect(toolMessages[0]).toBe('Error parsing tool arguments: kind: not that one.');
  });

  it('a field whose JSON text is broken says so', async () => {
    const program = new Tool({ name: 'program', description: 'd', schema: a.object({ program: a.object({ kind: a.string() }) }), call: () => 'ok' });
    const { events, toolMessages } = await run([program], MODELS.claude, [
      { raw: [{ name: 'program', arguments: JSON.stringify({ program: '{"kind": "block", "lines": []]}' }) }] },
      { content: 'done' },
    ]);
    expect(toolMessages[0]).toContain("JSON text that doesn't parse");
    expect(events.find(e => e.type === 'toolArgRepairAttempt')).toMatchObject({ fields: ['program'], success: false });
  });
});
