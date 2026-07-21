/**
 * Prompt Tool-Intercept (`onToolIntercept`) Tests
 *
 * Verifies the per-prompt `onToolIntercept` hook invoked for EVERY tool call
 * BEFORE the tool's own handler runs:
 *
 * - returning a result value short-circuits: the handler is NOT called and
 *   the model sees the injected result (serialized like a real result)
 * - returning `false` (or `undefined`) proceeds to the real handler
 * - a returned result still flows through `onToolResult` / `toolOutput`
 * - throwing `ToolInterrupt` parks the loop (interrupted slot) exactly as a
 *   throw from a handler would; throwing `PromptSuspend` suspends the loop
 * - a non-suspend/interrupt throw becomes a tool error, pairing preserved
 * - async interceptors are awaited
 * - a multi-tool turn where some calls are intercepted and some are not
 *
 * Harness mirrors prompt-tool-result-transformer.test.ts.
 */

import { z } from 'zod';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool, PromptSuspend, ToolInterrupt } from '../tool';
import { Context, Message } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

type Ev = PromptEvent<any, [AnyTool]>;

// --- Fixtures -------------------------------------------------------------

type ToolCallSpec = { id: string; name: string; arguments: string };

interface RunResult {
  events: Ev[];
  messages: Message[];
  toolMessages: Message[];
  suspended: boolean;
}

async function runToolCalls(
  prompt: Prompt<any, any, any, any, any, any, any>,
  toolCalls: ToolCallSpec[],
): Promise<RunResult> {
  const executor = createMockExecutor({
    responses: [
      { content: '', finishReason: 'tool_calls', toolCalls },
      { content: 'Done', finishReason: 'stop' },
    ],
  });
  const ctx: Context<{}, {}> = { execute: executor, messages: [] };
  const events: Ev[] = [];
  let suspended = false;
  for await (const event of prompt.get('stream', {}, ctx)) {
    events.push(event as Ev);
    if ((event as Ev).type === 'suspend') suspended = true;
  }
  const messages = events
    .filter((e): e is Extract<Ev, { type: 'message' }> => e.type === 'message')
    .map((e) => e.message);
  const toolMessages = messages.filter((m) => m.role === 'tool');
  return { events, messages, toolMessages, suspended };
}

const call = (id: string, name: string, args: object): ToolCallSpec => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

// --- Behavioral tests -----------------------------------------------------

describe('Prompt onToolIntercept', () => {
  it('short-circuits when the interceptor returns a result (handler NOT called)', async () => {
    const handler = jest.fn(() => ({ hits: 2, ids: ['a', 'b'] }));
    const searchTool = new Tool({
      name: 'search',
      description: 'Search the index',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'intercepted',
      description: 'Intercepted',
      content: 'Search',
      tools: [searchTool],
      onToolIntercept: () => ({ injected: true }),
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);

    expect(handler).not.toHaveBeenCalled();
    expect(toolMessages).toHaveLength(1);
    // Model sees the injected value, serialized exactly like a real result.
    expect(toolMessages[0].content).toBe(JSON.stringify({ injected: true }));
  });

  it('injects a string result verbatim', async () => {
    const handler = jest.fn(() => 'real');
    const echoTool = new Tool({
      name: 'echo',
      description: 'Echo',
      instructions: 'Echo',
      schema: z.object({ text: z.string() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'intercept-string',
      description: 'Intercept string',
      content: 'Echo',
      tools: [echoTool],
      onToolIntercept: () => 'REDACTED',
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'echo', { text: 'hi' })]);

    expect(handler).not.toHaveBeenCalled();
    expect(toolMessages[0].content).toBe('REDACTED');
  });

  it('proceeds to the real handler when the interceptor returns false', async () => {
    const handler = jest.fn((input: { a: number; b: number }) => input.a + input.b);
    const mathTool = new Tool({
      name: 'math',
      description: 'Add',
      instructions: 'Add',
      schema: z.object({ a: z.number(), b: z.number() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'not-intercepted',
      description: 'Not intercepted',
      content: 'Add',
      tools: [mathTool],
      onToolIntercept: () => false,
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'math', { a: 3, b: 4 })]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(toolMessages[0].content).toBe(JSON.stringify(7));
  });

  it('proceeds to the real handler when the interceptor returns undefined', async () => {
    const handler = jest.fn((input: { a: number; b: number }) => input.a + input.b);
    const mathTool = new Tool({
      name: 'math',
      description: 'Add',
      instructions: 'Add',
      schema: z.object({ a: z.number(), b: z.number() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'undefined-intercept',
      description: 'Undefined intercept',
      content: 'Add',
      tools: [mathTool],
      onToolIntercept: () => undefined,
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'math', { a: 5, b: 6 })]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(toolMessages[0].content).toBe(JSON.stringify(11));
  });

  it('receives the matched tool instance and parsed args', async () => {
    const seen: Array<{ name: string; args: any }> = [];
    const searchTool = new Tool({
      name: 'search',
      description: 'Search',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: () => 'real',
    });
    const prompt = new Prompt({
      name: 'inspect',
      description: 'Inspect',
      content: 'Search',
      tools: [searchTool],
      onToolIntercept: (tool, args) => {
        seen.push({ name: tool.name, args });
        return { ok: tool.name };
      },
    });

    await runToolCalls(prompt, [call('c1', 'search', { query: 'zed' })]);

    expect(seen).toEqual([{ name: 'search', args: { query: 'zed' } }]);
  });

  it('routes an intercepted result through onToolResult and the toolOutput event', async () => {
    const searchTool = new Tool({
      name: 'search',
      description: 'Search',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: () => 'real',
    });
    const prompt = new Prompt({
      name: 'intercept-plus-transform',
      description: 'Intercept + transform',
      content: 'Search',
      tools: [searchTool],
      onToolIntercept: () => ({ raw: 1 }),
      onToolResult: (event) => ({ transformed: event.result }),
    });

    const { events, toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);

    const output = events.find((e) => e.type === 'toolOutput') as
      | Extract<Ev, { type: 'toolOutput' }>
      | undefined;
    expect(output).toBeDefined();
    // Raw result is the interceptor's value; toModel is onToolResult's transform.
    expect(output!.result).toEqual({ raw: 1 });
    expect(output!.toModel).toEqual({ transformed: { raw: 1 } });
    expect(toolMessages[0].content).toBe(JSON.stringify({ transformed: { raw: 1 } }));
  });

  it('awaits an async interceptor', async () => {
    const handler = jest.fn(() => 'real');
    const searchTool = new Tool({
      name: 'search',
      description: 'Search',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'async-intercept',
      description: 'Async intercept',
      content: 'Search',
      tools: [searchTool],
      onToolIntercept: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'async-injected';
      },
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'x' })]);

    expect(handler).not.toHaveBeenCalled();
    expect(toolMessages[0].content).toBe('async-injected');
  });

  it('parks the loop when the interceptor throws ToolInterrupt (like a handler would)', async () => {
    const handler = jest.fn(() => 'real');
    const searchTool = new Tool({
      name: 'search',
      description: 'Search',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'intercept-interrupt',
      description: 'Intercept interrupt',
      content: 'Search',
      tools: [searchTool],
      onToolIntercept: () => {
        throw new ToolInterrupt('stop from interceptor');
      },
    });

    const { events, toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);

    expect(handler).not.toHaveBeenCalled();
    // toolInterrupt event fired; toolsComplete default synthesizes the marker.
    expect(events.find((e) => e.type === 'toolInterrupt')).toBeDefined();
    expect(toolMessages[0].content).toContain('[interrupted');
  });

  it('suspends the loop when the interceptor throws PromptSuspend (like a handler would)', async () => {
    const handler = jest.fn(() => 'real');
    const searchTool = new Tool({
      name: 'search',
      description: 'Search',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'intercept-suspend',
      description: 'Intercept suspend',
      content: 'Search',
      tools: [searchTool],
      onToolIntercept: () => {
        throw new PromptSuspend('need approval from interceptor');
      },
    });

    const { events, toolMessages, suspended } = await runToolCalls(prompt, [
      call('c1', 'search', { query: 'hi' }),
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(suspended).toBe(true);
    expect(events.find((e) => e.type === 'toolSuspend')).toBeDefined();
    // Suspended tools intentionally leave their slot unpaired.
    expect(toolMessages).toHaveLength(0);
  });

  it('treats a non-suspend/interrupt throw as a tool error without breaking pairing', async () => {
    const handler = jest.fn(() => 'real');
    const searchTool = new Tool({
      name: 'search',
      description: 'Search',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: handler,
    });
    const prompt = new Prompt({
      name: 'intercept-throw',
      description: 'Intercept throw',
      content: 'Search',
      tools: [searchTool],
      onToolIntercept: () => {
        throw new Error('boom in interceptor');
      },
    });

    const { events, messages, toolMessages } = await runToolCalls(prompt, [
      call('c1', 'search', { query: 'hi' }),
    ]);

    expect(handler).not.toHaveBeenCalled();
    expect(toolMessages[0].content).toContain('boom in interceptor');
    expect(events.find((e) => e.type === 'toolError')).toBeDefined();
    expect(events.find((e) => e.type === 'toolOutput')).toBeUndefined();

    // Pairing guarantee: every assistant tool_call has a matching role:'tool'.
    const assistantCallIds = messages
      .filter((m) => m.role === 'assistant' && m.toolCalls)
      .flatMap((m) => m.toolCalls!.map((tc) => tc.id));
    const toolReplyIds = new Set(toolMessages.map((m) => m.toolCallId));
    for (const id of assistantCallIds) {
      expect(toolReplyIds.has(id)).toBe(true);
    }
  });

  it('intercepts some tools and runs the handler for others in the same turn', async () => {
    const searchHandler = jest.fn(() => ({ hits: 9 }));
    const mathHandler = jest.fn((input: { a: number; b: number }) => input.a + input.b);
    const searchTool = new Tool({
      name: 'search',
      description: 'Search',
      instructions: 'Search',
      schema: z.object({ query: z.string() }),
      call: searchHandler,
    });
    const mathTool = new Tool({
      name: 'math',
      description: 'Add',
      instructions: 'Add',
      schema: z.object({ a: z.number(), b: z.number() }),
      call: mathHandler,
    });
    const prompt = new Prompt({
      name: 'mixed',
      description: 'Mixed',
      content: 'Do things',
      tools: [searchTool, mathTool],
      // Intercept only `search`; let `math` run its real handler.
      onToolIntercept: (tool) => (tool.name === 'search' ? { injected: true } : false),
    });

    const { toolMessages } = await runToolCalls(prompt, [
      call('c1', 'search', { query: 'zed' }),
      call('c2', 'math', { a: 3, b: 4 }),
    ]);

    expect(searchHandler).not.toHaveBeenCalled();
    expect(mathHandler).toHaveBeenCalledTimes(1);

    const byId = Object.fromEntries(toolMessages.map((m) => [m.toolCallId, m.content]));
    expect(byId['c1']).toBe(JSON.stringify({ injected: true }));
    expect(byId['c2']).toBe(JSON.stringify(7));
  });
});
