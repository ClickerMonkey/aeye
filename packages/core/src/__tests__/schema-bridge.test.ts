/**
 * The TEMPORARY zod bridge (TODO(step 2): delete with core's zod dependency,
 * once @aeye/gin and @aeye/query produce `a` schemas). gin's and query's zod
 * schemas — and the tools/prompts built on them (ginny, query's
 * buildQueryTool, the harness) — keep working: a zod schema, or a function
 * returning one, is planned and decoded like an `a` schema, then parsed by
 * zod itself (refinements, defaults, transforms).
 */
import { z } from 'zod';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { fromZod, LENIENT, planRequest } from '../schema';
import { MODELS, plannedExecutor, type PlannedTurn } from './mocks/planned';

async function runTool(tool: Tool<any, any, any, any, any, any, any>, model: Parameters<typeof plannedExecutor>[0], turns: PlannedTurn[], ctx: Record<string, unknown> = {}) {
  const { execute, sent } = plannedExecutor(model, turns);
  const prompt = new Prompt({ name: 'p', description: 'p', content: 'Use it.', tools: [tool] } as any);
  const events: any[] = [];
  for await (const event of prompt.get('stream', {}, { ...ctx, execute } as any)) events.push(event);
  return { sent, events, toolMessages: events.filter(e => e.type === 'message' && e.message.role === 'tool').map(e => e.message.content as string) };
}

describe('zod tool schemas through the bridge', () => {
  const seen: unknown[] = [];
  const tagged = new Tool({
    name: 'tag',
    description: 't',
    schema: z.object({ name: z.string(), tags: z.record(z.string(), z.number()), unit: z.enum(['c', 'f']).default('c') }),
    call: (input) => { seen.push(input); return 'ok'; },
  });

  it('is rendered for the model (OpenAI strict: pairs) and decoded to the zod output (default applied)', async () => {
    seen.length = 0;
    const { sent, toolMessages } = await runTool(tagged, MODELS.gpt, [
      { raw: [{ name: 'tag', arguments: JSON.stringify({ name: 'n', tags: [{ key: 'a', value: 1 }], unit: null }) }] },
      { content: 'done' },
    ]);
    expect(sent[0]!.tools[0]!.strict).toBe(true);
    expect((sent[0]!.tools[0]!.parameters as any).properties.tags.type).toBe('array');
    expect(toolMessages).toEqual(['ok']);
    expect(seen).toEqual([{ name: 'n', tags: { a: 1 }, unit: 'c' }]);
  });

  it('zod refinements still run, and their failure is told in the error format', async () => {
    const even = new Tool({
      name: 'even',
      description: 'e',
      schema: z.object({ n: z.number().refine((n) => n % 2 === 0, 'Must be even') }),
      call: () => 'ok',
    });
    const { toolMessages } = await runTool(even, MODELS.gpt, [{ raw: [{ name: 'even', arguments: '{"n":3}' }] }, { content: 'done' }]);
    expect(toolMessages[0]).toContain('Must be even');
    expect(toolMessages[0]).toContain('the arguments of even');
  });

  it('a zod transform applies to the decoded value', async () => {
    const upper = new Tool({ name: 'up', description: 'u', schema: z.object({ s: z.string().transform((s) => s.toUpperCase()) }), call: (input) => input.s });
    const { toolMessages } = await runTool(upper, MODELS.gemini, [{ raw: [{ name: 'up', arguments: '{"s":"hi"}' }] }, { content: 'done' }]);
    expect(toolMessages).toEqual(['HI']);
  });

  it('the old function form: ctx-dependent zod, undefined meaning not applicable', async () => {
    const byRole = new Tool({
      name: 'act',
      description: 'a',
      schema: (ctx: { role?: string }) => (ctx.role ? z.object({ action: z.enum(ctx.role === 'admin' ? ['read', 'write'] : ['read']) }) : undefined),
      call: (input) => input.action,
    });
    expect(await byRole.applicable({})).toBe(false);
    expect(await byRole.applicable({ role: 'user' })).toBe(true);
    const { sent, toolMessages } = await runTool(byRole, MODELS.gpt, [{ raw: [{ name: 'act', arguments: '{"action":"write"}' }] }, { content: 'done' }], { role: 'user' });
    expect(JSON.stringify(sent[0]!.tools[0]!.parameters)).not.toContain('write');
    expect(toolMessages[0]).toMatch(/^Error parsing tool arguments: /);
  });

  it('zod recursion (z.lazy) becomes a named type', async () => {
    type Node = { label: string; kids: Node[] };
    const NodeZ: z.ZodType<Node> = z.lazy(() => z.object({ label: z.string(), kids: z.array(NodeZ) }));
    const tree = new Tool({ name: 'tree', description: 't', schema: z.object({ root: NodeZ }), call: (input) => input.root.kids.length });
    const { toolMessages } = await runTool(tree, MODELS.gpt, [{ raw: [{ name: 'tree', arguments: JSON.stringify({ root: { label: 'r', kids: [{ label: 'k', kids: [] }] } }) }] }, { content: 'done' }]);
    expect(toolMessages).toEqual(['1']);
  });

  it('a custom parse hook (query buildQueryTool style) gets the decoded value, or the raw one when it does not fit', async () => {
    const got: unknown[] = [];
    const custom = new Tool({
      name: 'q',
      description: 'q',
      schema: z.object({ query: z.object({ kind: z.literal('select') }) }),
      parse: (raw: any) => { got.push(raw); return raw.query?.kind === 'select' ? raw : new Error('owned parser: unknown kind'); },
      call: () => 'ran',
    });
    const plan = planRequest({ tools: [(await custom.definition({}))!] }, MODELS.gpt);
    await expect(custom.parse({}, '{"query":{"kind":"select"}}', plan)).resolves.toEqual({ query: { kind: 'select' } });
    await expect(custom.parse({}, '{"query":{"kind":"slect"}}', plan)).rejects.toThrow('owned parser: unknown kind');
    expect(got).toEqual([{ query: { kind: 'select' } }, { query: { kind: 'slect' } }]);
  });

  it('fromZod hands a zod schema to code taking `a`', () => {
    const bindable = fromZod(z.object({ id: z.number() }));
    expect(bindable.bind().render(LENIENT).jsonSchema).toMatchObject({ type: 'object', properties: { id: { type: 'number' } } });
    const plan = planRequest({ tools: [{ name: 'x', parameters: bindable.bind(), strict: 1 }] }, MODELS.gpt);
    expect(plan.get('x').parse({ id: 3 })).toMatchObject({ ok: true, value: { id: 3 } });
  });
});

describe('zod prompt outputs through the bridge', () => {
  it('a static zod output is planned and decoded', async () => {
    const p = new Prompt({ name: 'p', description: 'p', content: 'x', schema: z.object({ ok: z.boolean(), n: z.number().optional() }) });
    const { execute, sent } = plannedExecutor(MODELS.gpt, [{ content: '{"ok":true,"n":null}' }]);
    expect(await p.get('result', {}, { execute } as any)).toEqual({ ok: true });
    expect(sent[0]!.output!.strict).toBe(true);
  });

  it('the old (input, ctx) function form; false means not applicable', async () => {
    const p = new Prompt({
      name: 'p',
      description: 'p',
      content: 'x',
      schema: (input: { withAge?: boolean } | undefined, ctx: { off?: boolean }) => (ctx.off ? false : input?.withAge ? z.object({ age: z.number() }) : z.object({ name: z.string() })) as false | z.ZodType<{ age?: number; name?: string }>,
    });
    expect(await p.applicable({ off: true } as any)).toBe(false);
    const { execute } = plannedExecutor(MODELS.gemini, [{ content: '{"age":3}' }]);
    expect(await p.get('result', { withAge: true }, { execute } as any)).toEqual({ age: 3 });
  });

  it('z.string() answers in text', async () => {
    const p = new Prompt({ name: 'p', description: 'p', content: 'x', schema: z.string() });
    const { execute, sent } = plannedExecutor(MODELS.gpt, [{ content: 'just text' }]);
    expect(await p.get('result', {}, { execute } as any)).toBe('just text');
    expect(sent[0]!.request.responseFormat).toBe('text');
  });
});
