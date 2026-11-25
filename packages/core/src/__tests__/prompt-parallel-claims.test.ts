/**
 * Prompt parallel claims (`ToolInput.parallelClaims`)
 *
 * Under `toolExecution: 'parallel'` and `'immediate'`, a call whose claims
 * conflict with an EARLIER call in the same batch waits until that call has
 * finished, then runs; calls that share nothing still run together. Verifies:
 *
 * - same claim ⇒ one after the other, in model order
 * - different claims ⇒ concurrent
 * - static claims, and dynamic claims from parsed args + the call's ctx
 * - `'*'` runs alone
 * - immediate mode (calls start while the model is still streaming)
 * - a waiting call never starts a sibling, and never starts itself once its
 *   batch is skipped (another call was invalid) or the signal aborted
 * - a throwing claims function fails that call alone
 * - `toolStart` for a waiting call is emitted when it actually starts
 * - every tool_call still gets its role:'tool' reply
 */

import { a } from '@aeye/schema';
import { Fn } from '../common';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool } from '../tool';
import { ToolClaims } from '../claims';
import { Chunk, Context, Message, Response, Streamer, ToolCall } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

type Ev = PromptEvent<any, [AnyTool]>;
type Ctx = Context<{ workspace?: string }, {}>;
type Mode = 'parallel' | 'immediate';
type Claims = Fn<ToolClaims | undefined, [{ path?: string }, Ctx]>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const call = (id: string, name: string, args: object = {}): ToolCall => ({ id, name, arguments: JSON.stringify(args) });

/**
 * A tool that logs `start:<callId>` and `end:<callId>` around a short sleep,
 * so tests can see which calls overlapped.
 */
function traced(name: string, log: string[], parallelClaims?: Claims, options: { delay?: number; onCall?: (ctx: Ctx) => void } = {}) {
  return new Tool<{ workspace?: string }, {}, string, { path?: string }, Promise<string>>({
    name,
    description: name,
    instructions: name,
    schema: a.object({ path: a.string().optional() }),
    parallelClaims,
    call: async (_input, _refs, ctx) => {
      log.push(`start:${ctx.toolCallId}`);
      options.onCall?.(ctx);
      await sleep(options.delay ?? 20);
      log.push(`end:${ctx.toolCallId}`);
      return `${ctx.toolCallId}-done`;
    },
  });
}

const fileClaims: Claims = (input) => input.path ? [`file:${input.path}`] : undefined;

/** Whether `b` started only after `a` ended. */
const after = (log: string[], a: string, b: string) => log.indexOf(`end:${a}`) >= 0 && log.indexOf(`end:${a}`) < log.indexOf(`start:${b}`);
/** Whether `a` and `b` were running at the same time. */
const overlapped = (log: string[], a: string, b: string) =>
  log.indexOf(`start:${b}`) < log.indexOf(`end:${a}`) && log.indexOf(`start:${a}`) < log.indexOf(`end:${b}`);

interface RunResult {
  events: Ev[];
  replies: Record<string, string>;
  assistantCalls: string[];
}

async function collect(prompt: Prompt<any, any, any, any, any, any>, ctx: Ctx, onEvent?: (event: Ev) => void): Promise<RunResult> {
  const events: Ev[] = [];
  for await (const event of prompt.get('stream', {}, ctx)) {
    events.push(event as Ev);
    onEvent?.(event as Ev);
  }
  const messages: Message[] = events
    .filter((e): e is Extract<Ev, { type: 'message' }> => e.type === 'message')
    .map((e) => e.message);
  const replies = Object.fromEntries(messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId!, String(m.content)]));
  const assistantCalls = messages.flatMap((m) => m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : []);
  return { events, replies, assistantCalls };
}

async function runCalls(
  tools: [AnyTool, ...AnyTool[]],
  toolCalls: ToolCall[],
  mode: Mode,
  extra: Partial<Ctx> = {},
  onEvent?: (event: Ev) => void,
): Promise<RunResult> {
  const prompt = new Prompt({ name: 'claims', description: 'Claims', content: 'Go', tools, toolExecution: mode });
  const execute = createMockExecutor({
    responses: [
      { content: '', finishReason: 'tool_calls', toolCalls },
      { content: 'Done', finishReason: 'stop' },
    ],
  });
  return collect(prompt, { execute, messages: [], ...extra }, onEvent);
}

/** Every tool_call on an assistant message has a role:'tool' reply. */
function expectPaired(result: RunResult) {
  expect(Object.keys(result.replies).sort()).toEqual([...result.assistantCalls].sort());
}

describe.each<Mode>(['parallel', 'immediate'])('parallelClaims under %s', (mode) => {
  it('runs calls with the same claim one after another, in model order', async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims);
    const result = await runCalls([edit], [call('e1', 'edit', { path: 'a' }), call('e2', 'edit', { path: 'a' }), call('e3', 'edit', { path: 'a' })], mode);
    expect(log).toEqual(['start:e1', 'end:e1', 'start:e2', 'end:e2', 'start:e3', 'end:e3']);
    expect(result.replies).toEqual({ e1: 'e1-done', e2: 'e2-done', e3: 'e3-done' });
    expectPaired(result);
  });

  it('runs calls with different claims at the same time', async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims);
    const result = await runCalls([edit], [call('e1', 'edit', { path: 'a' }), call('e2', 'edit', { path: 'b' })], mode);
    expect(overlapped(log, 'e1', 'e2')).toBe(true);
    expect(result.replies).toEqual({ e1: 'e1-done', e2: 'e2-done' });
  });

  it('only serializes the calls that conflict', async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims, { delay: 30 });
    const plain = traced('plain', log);
    await runCalls([edit, plain], [
      call('a1', 'edit', { path: 'a' }),
      call('b1', 'edit', { path: 'b' }),
      call('a2', 'edit', { path: 'a' }),
      call('p1', 'plain'),
    ], mode);
    expect(after(log, 'a1', 'a2')).toBe(true);
    expect(overlapped(log, 'a1', 'b1')).toBe(true);
    expect(overlapped(log, 'b1', 'a2')).toBe(true);
    expect(overlapped(log, 'a1', 'p1')).toBe(true);
  });

  it('serializes calls of different tools that share a static claim', async () => {
    const log: string[] = [];
    const read = traced('read', log, ['db:users']);
    const write = traced('write', log, ['db:users']);
    const other = traced('other', log, ['db:orders']);
    await runCalls([read, write, other], [call('w', 'write'), call('r', 'read'), call('o', 'other')], mode);
    expect(after(log, 'w', 'r')).toBe(true);
    expect(overlapped(log, 'w', 'o')).toBe(true);
  });

  it('works claims out from the parsed args and the call context, asynchronously', async () => {
    const log: string[] = [];
    const seen: Array<{ path?: string; workspace?: string; toolCallId?: string }> = [];
    const edit = traced('edit', log, async (input, ctx) => {
      seen.push({ path: input.path, workspace: ctx.workspace, toolCallId: ctx.toolCallId });
      await sleep(5);
      return [`${ctx.workspace}:${input.path}`];
    });
    await runCalls([edit], [call('e1', 'edit', { path: 'a' }), call('e2', 'edit', { path: 'a' }), call('e3', 'edit', { path: 'b' })], mode, { workspace: 'ws' });
    expect(seen.sort((x, y) => x.toolCallId!.localeCompare(y.toolCallId!))).toEqual([
      { path: 'a', workspace: 'ws', toolCallId: 'e1' },
      { path: 'a', workspace: 'ws', toolCallId: 'e2' },
      { path: 'b', workspace: 'ws', toolCallId: 'e3' },
    ]);
    expect(after(log, 'e1', 'e2')).toBe(true);
    expect(overlapped(log, 'e1', 'e3')).toBe(true);
  });

  it("runs a call claiming '*' alone, after the calls before it and before the calls after it", async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims);
    const plain = traced('plain', log);
    const migrate = traced('migrate', log, ['*']);
    await runCalls([edit, plain, migrate], [
      call('e1', 'edit', { path: 'a' }),
      call('p1', 'plain'),
      call('m', 'migrate'),
      call('e2', 'edit', { path: 'b' }),
      call('p2', 'plain'),
    ], mode);
    expect(overlapped(log, 'e1', 'p1')).toBe(true);
    for (const before of ['e1', 'p1']) expect(after(log, before, 'm')).toBe(true);
    for (const later of ['e2', 'p2']) expect(after(log, 'm', later)).toBe(true);
    expect(overlapped(log, 'e2', 'p2')).toBe(true);
  });

  it('emits toolStart for a waiting call when it starts, not while it is queued', async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims);
    const startedAfter: Record<string, string[]> = {};
    const result = await runCalls([edit], [call('e1', 'edit', { path: 'a' }), call('e2', 'edit', { path: 'a' })], mode, {}, (event) => {
      if (event.type === 'toolStart') startedAfter[event.toolCallId!] = [...log];
    });
    // e2's start is reported only once e1 has finished.
    expect(startedAfter['e2']).toContain('end:e1');
    const order = result.events
      .filter((e) => e.type === 'toolStart' || e.type === 'toolOutput')
      .map((e) => `${e.type}:${(e as { toolCallId?: string }).toolCallId}`);
    expect(order.indexOf('toolStart:e2')).toBeGreaterThan(order.indexOf('toolStart:e1'));
    expect(order.filter((e) => e === 'toolStart:e2')).toHaveLength(1);
  });

  it('fails a call whose claims function throws, leaving its siblings alone', async () => {
    const log: string[] = [];
    const broken = traced('broken', log, () => { throw new Error('cannot claim'); });
    const edit = traced('edit', log, fileClaims);
    const result = await runCalls([broken, edit], [call('b', 'broken'), call('e1', 'edit', { path: 'a' }), call('e2', 'edit', { path: 'a' })], mode);
    expect(log).not.toContain('start:b');
    expect(result.replies['b']).toMatch(/Error working out tool claims: cannot claim/);
    expect(result.replies['e1']).toBe('e1-done');
    expect(result.replies['e2']).toBe('e2-done');
    expect(after(log, 'e1', 'e2')).toBe(true);
    const errors = result.events.filter((e) => e.type === 'toolError').map((e) => (e as { toolCallId?: string }).toolCallId);
    const starts = result.events.filter((e) => e.type === 'toolStart').map((e) => (e as { toolCallId?: string }).toolCallId);
    expect(errors).toEqual(['b']);
    expect(starts).not.toContain('b');
    expectPaired(result);
  });

  it('does not start a waiting call once the signal aborts', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const edit = traced('edit', log, fileClaims, { onCall: (ctx) => { if (ctx.toolCallId === 'e1') controller.abort(); } });
    const result = await runCalls([edit], [call('e1', 'edit', { path: 'a' }), call('e2', 'edit', { path: 'a' })], mode, { signal: controller.signal });
    // Give an orphaned waiter every chance to (wrongly) start.
    await sleep(50);
    expect(log).toEqual(['start:e1', 'end:e1']);
    expect(result.replies['e2']).toMatch(/^\[aborted:/);
    expectPaired(result);
  });
});

describe('parallelClaims under sequential', () => {
  it('runs calls one at a time as before, whatever they claim', async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims);
    const prompt = new Prompt({ name: 'seq', description: 'Seq', content: 'Go', tools: [edit], toolExecution: 'sequential' });
    const execute = createMockExecutor({
      responses: [
        { content: '', finishReason: 'tool_calls', toolCalls: [call('s1', 'edit', { path: 'a' }), call('s2', 'edit', { path: 'b' })] },
        { content: 'Done', finishReason: 'stop' },
      ],
    });
    const seq = await collect(prompt, { execute, messages: [] });
    expect(log).toEqual(['start:s1', 'end:s1', 'start:s2', 'end:s2']);
    expect(seq.replies).toEqual({ s1: 's1-done', s2: 's2-done' });
  });
});

describe('parallelClaims when the batch is skipped (immediate)', () => {
  /**
   * A streamer whose first round streams `first` (each chunk after an
   * optional pause) and whose later rounds answer 'Done'.
   */
  function rounds(first: Array<{ chunk: Partial<Chunk>; pauseBefore?: number }>): Streamer<any, any> {
    let round = 0;
    return async function* () {
      round++;
      if (round > 1) {
        yield { content: 'Done', finishReason: 'stop' } as Chunk;
        return { content: 'Done', finishReason: 'stop', model: 'mock' } as Response;
      }
      for (const { chunk, pauseBefore } of first) {
        if (pauseBefore) await sleep(pauseBefore);
        yield chunk as Chunk;
      }
      yield { finishReason: 'tool_calls' } as Chunk;
      return { content: '', finishReason: 'tool_calls', model: 'mock' } as Response;
    };
  }

  const named = (c: ToolCall): Partial<Chunk> => ({ toolCallNamed: { ...c, arguments: '' } });
  const complete = (c: ToolCall): Partial<Chunk> => ({ toolCallNamed: c, toolCallArguments: c, toolCall: c });

  it('never starts a waiting call, nor the earlier sibling it waits on, when the batch is skipped', async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims);
    const j = call('j', 'edit', { path: 'a' });
    const i = call('i', 'edit', { path: 'a' });
    const prompt = new Prompt({ name: 'skip', description: 'Skip', content: 'Go', tools: [edit], toolExecution: 'immediate' });
    // j is named first but its arguments never complete; i completes and
    // begins (waiting on j's claims); then a call to an unknown tool skips
    // the batch.
    const stream = rounds([
      { chunk: named(j) },
      { chunk: complete(i) },
      { chunk: named(call('bad', 'missing_tool')), pauseBefore: 30 },
    ]);
    const result = await collect(prompt, { stream, messages: [] });
    await sleep(50);
    expect(log).toEqual([]);
    expect(result.replies['i']).toBe('[not run: another call in this batch was invalid; call it again]');
    expect(result.replies['j']).toBe('[not run: another call in this batch was invalid; call it again]');
    expect(result.replies['bad']).toMatch(/Tool not found: missing_tool/);
    expectPaired(result);
  });

  it('lets a running call finish but never starts the call waiting on it when the batch is skipped', async () => {
    const log: string[] = [];
    const edit = traced('edit', log, fileClaims, { delay: 60 });
    const prompt = new Prompt({ name: 'skip-running', description: 'Skip', content: 'Go', tools: [edit], toolExecution: 'immediate' });
    const stream = rounds([
      { chunk: complete(call('j', 'edit', { path: 'a' })) },
      { chunk: complete(call('i', 'edit', { path: 'a' })) },
      { chunk: named(call('bad', 'missing_tool')), pauseBefore: 20 },
    ]);
    const result = await collect(prompt, { stream, messages: [] });
    await sleep(100);
    // j had started, so it ran to its end; i, waiting on it, never started.
    // (j's reply is whatever a skipped batch gives a call still running,
    // which parallel claims don't change.)
    expect(log).toEqual(['start:j', 'end:j']);
    expect(result.replies['i']).toBe('[not run: another call in this batch was invalid; call it again]');
    expectPaired(result);
  });
});
