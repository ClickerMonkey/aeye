/**
 * Prompt Tool-Result Transformer (`onToolResult`) Tests
 *
 * Verifies the per-prompt `onToolResult` handler that intercepts each
 * tool's SUCCESS result before it's handed to the model:
 *
 * - per-tool `result` + `args` narrowing on `event.tool`
 * - the catch-all default branch
 * - pass-through (`return event.result`) leaves the model message unchanged
 * - transform (return a different value) changes what the model sees,
 *   serialized exactly like an untransformed result
 * - async handlers are awaited
 * - errored / suspended / interrupted slots BYPASS the handler
 * - the `toolOutput` event carries BOTH the raw `result` and the presented
 *   `toModel`
 * - a handler that THROWS becomes a tool error for that slot without
 *   breaking the tool_call ↔ role:'tool' pairing guarantee
 *
 * Compile-time type-safety cases (wrong tool name / wrong field access)
 * live at the bottom behind `// @ts-expect-error`. The repo runs jest with
 * ts-jest `isolatedModules` (transpile-only), so those are verified by a
 * dedicated `tsc --noEmit` pass rather than at test runtime — see the
 * feature report.
 */

import { z } from 'zod';
import { Prompt, PromptEvent, ToolResultEvent } from '../prompt';
import { AnyTool, Tool, PromptSuspend, ToolInterrupt } from '../tool';
import { Context, Message } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

type Ev = PromptEvent<any, [AnyTool]>;

// --- Fixtures -------------------------------------------------------------

const searchTool = new Tool({
  name: 'search',
  description: 'Search the index',
  instructions: 'Search',
  schema: z.object({ query: z.string() }),
  call: (input) => ({ hits: 2, ids: ['a', 'b'], query: input.query }),
});

const mathTool = new Tool({
  name: 'math',
  description: 'Add two numbers',
  instructions: 'Add',
  schema: z.object({ a: z.number(), b: z.number() }),
  call: (input) => input.a + input.b,
});

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

describe('Prompt onToolResult transformer', () => {
  it('passes a result through unchanged when the handler returns event.result', async () => {
    const prompt = new Prompt({
      name: 'passthrough',
      description: 'Pass-through',
      content: 'Search',
      tools: [searchTool],
      onToolResult: (event) => event.result,
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);

    expect(toolMessages).toHaveLength(1);
    // Identical to what the raw result would serialize to.
    expect(toolMessages[0].content).toBe(JSON.stringify({ hits: 2, ids: ['a', 'b'], query: 'hi' }));
  });

  it('matches the no-handler baseline for pass-through', async () => {
    const baseline = new Prompt({
      name: 'baseline',
      description: 'No handler',
      content: 'Search',
      tools: [searchTool],
    });
    const withHandler = new Prompt({
      name: 'with',
      description: 'Handler',
      content: 'Search',
      tools: [searchTool],
      onToolResult: (event) => event.result,
    });

    const a = await runToolCalls(baseline, [call('c1', 'search', { query: 'hi' })]);
    const b = await runToolCalls(withHandler, [call('c1', 'search', { query: 'hi' })]);

    expect(b.toolMessages[0].content).toBe(a.toolMessages[0].content);
  });

  it('transforms the model-facing value (string returned verbatim)', async () => {
    const prompt = new Prompt({
      name: 'transform-string',
      description: 'Transform',
      content: 'Search',
      tools: [searchTool],
      onToolResult: () => 'REDACTED',
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);

    expect(toolMessages[0].content).toBe('REDACTED');
  });

  it('transforms the model-facing value (object gets JSON.stringify-d)', async () => {
    const prompt = new Prompt({
      name: 'transform-object',
      description: 'Transform',
      content: 'Search',
      tools: [searchTool],
      onToolResult: () => ({ summary: 'ok' }),
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);

    expect(toolMessages[0].content).toBe(JSON.stringify({ summary: 'ok' }));
  });

  it('narrows result + args per tool on event.tool', async () => {
    const seen: string[] = [];
    const prompt = new Prompt({
      name: 'narrowing',
      description: 'Narrowing',
      content: 'Do things',
      tools: [searchTool, mathTool],
      onToolResult: (event) => {
        if (event.tool === 'search') {
          // event.result: { hits, ids, query }; event.args: { query }
          seen.push(`search:${event.args.query}:${event.result.hits}`);
          return `hits=${event.result.hits} for ${event.args.query}`;
        }
        // Default branch — the catch-all. Here event is the `math` member.
        seen.push(`math:${event.args.a}+${event.args.b}=${event.result}`);
        return `sum=${event.result}`;
      },
    });

    const { toolMessages } = await runToolCalls(prompt, [
      call('c1', 'search', { query: 'zed' }),
      call('c2', 'math', { a: 3, b: 4 }),
    ]);

    const byId = Object.fromEntries(toolMessages.map((m) => [m.toolCallId, m.content]));
    expect(byId['c1']).toBe('hits=2 for zed');
    expect(byId['c2']).toBe('sum=7');
    expect(seen).toContain('search:zed:2');
    expect(seen).toContain('math:3+4=7');
  });

  it('uses the default (catch-all) branch for any tool when unmatched', async () => {
    const prompt = new Prompt({
      name: 'default-branch',
      description: 'Default',
      content: 'Add',
      tools: [searchTool, mathTool],
      onToolResult: (event) => {
        if (event.tool === 'search') {
          return event.result;
        }
        // Catch-all: applies to `math` (and any other future tool).
        return `default:${event.tool}`;
      },
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'math', { a: 1, b: 2 })]);

    expect(toolMessages[0].content).toBe('default:math');
  });

  it('awaits an async handler', async () => {
    const prompt = new Prompt({
      name: 'async',
      description: 'Async',
      content: 'Search',
      tools: [searchTool],
      onToolResult: async (event) => {
        await new Promise((r) => setTimeout(r, 5));
        return `async:${event.result.hits}`;
      },
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'search', { query: 'x' })]);

    expect(toolMessages[0].content).toBe('async:2');
  });

  it('does NOT invoke the handler for an errored tool (passes through untouched)', async () => {
    const boomTool = new Tool({
      name: 'boom',
      description: 'Throws',
      instructions: 'Boom',
      schema: z.object({}),
      call: () => {
        throw new Error('kaboom');
      },
    });
    const handler = jest.fn((event: ToolResultEvent<{}, {}, [typeof boomTool]>) => event.result);
    const prompt = new Prompt({
      name: 'errored',
      description: 'Errored',
      content: 'Boom',
      tools: [boomTool],
      onToolResult: handler,
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'boom', {})]);

    expect(handler).not.toHaveBeenCalled();
    expect(toolMessages[0].content).toContain('Error executing tool');
    expect(toolMessages[0].content).toContain('kaboom');
  });

  it('does NOT invoke the handler for a suspended tool (bypass, no tool message)', async () => {
    const suspendTool = new Tool({
      name: 'suspends',
      description: 'Suspends',
      instructions: 'Suspend',
      schema: z.object({}),
      call: () => {
        throw new PromptSuspend('need approval');
      },
    });
    const handler = jest.fn((event: ToolResultEvent<{}, {}, [typeof suspendTool]>) => event.result);
    const prompt = new Prompt({
      name: 'suspended',
      description: 'Suspended',
      content: 'Suspend',
      tools: [suspendTool],
      onToolResult: handler,
    });

    const { toolMessages, suspended } = await runToolCalls(prompt, [call('c1', 'suspends', {})]);

    expect(handler).not.toHaveBeenCalled();
    expect(suspended).toBe(true);
    // Suspended tools intentionally leave their slot unpaired.
    expect(toolMessages).toHaveLength(0);
  });

  it('does NOT invoke the handler for an interrupted tool (bypass, synthetic marker)', async () => {
    const interruptTool = new Tool({
      name: 'interrupts',
      description: 'Interrupts',
      instructions: 'Interrupt',
      schema: z.object({}),
      call: () => {
        throw new ToolInterrupt('stop');
      },
    });
    const handler = jest.fn((event: ToolResultEvent<{}, {}, [typeof interruptTool]>) => event.result);
    const prompt = new Prompt({
      name: 'interrupted',
      description: 'Interrupted',
      content: 'Interrupt',
      tools: [interruptTool],
      onToolResult: handler,
    });

    const { toolMessages } = await runToolCalls(prompt, [call('c1', 'interrupts', {})]);

    expect(handler).not.toHaveBeenCalled();
    // toolsComplete default true → synthesized marker, never the handler.
    expect(toolMessages[0].content).toContain('[interrupted');
  });

  it('emits the raw result AND the presented toModel on the toolOutput event', async () => {
    const prompt = new Prompt({
      name: 'event-fields',
      description: 'Event fields',
      content: 'Search',
      tools: [searchTool],
      onToolResult: () => ({ summary: 'ok' }),
    });

    const { events } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);
    const output = events.find((e) => e.type === 'toolOutput') as
      | Extract<Ev, { type: 'toolOutput' }>
      | undefined;

    expect(output).toBeDefined();
    // Raw result is preserved on the event...
    expect(output!.result).toEqual({ hits: 2, ids: ['a', 'b'], query: 'hi' });
    // ...and the transformed value is exposed as `toModel`.
    expect(output!.toModel).toEqual({ summary: 'ok' });
  });

  it('leaves toModel equal to the raw result when no handler is set', async () => {
    const prompt = new Prompt({
      name: 'no-handler-tomodel',
      description: 'No handler',
      content: 'Search',
      tools: [searchTool],
    });

    const { events } = await runToolCalls(prompt, [call('c1', 'search', { query: 'hi' })]);
    const output = events.find((e) => e.type === 'toolOutput') as
      | Extract<Ev, { type: 'toolOutput' }>
      | undefined;

    expect(output!.toModel).toEqual(output!.result);
  });

  it('treats a throwing handler as a tool error without breaking pairing', async () => {
    const prompt = new Prompt({
      name: 'throwing-handler',
      description: 'Throwing handler',
      content: 'Search',
      tools: [searchTool],
      onToolResult: () => {
        throw new Error('boom');
      },
    });

    const { events, messages, toolMessages } = await runToolCalls(prompt, [
      call('c1', 'search', { query: 'hi' }),
    ]);

    // The model sees an error for that slot.
    expect(toolMessages[0].content).toContain('Error transforming tool result: boom');

    // No toolOutput event fired; a toolError did.
    expect(events.find((e) => e.type === 'toolOutput')).toBeUndefined();
    expect(events.find((e) => e.type === 'toolError')).toBeDefined();

    // Pairing guarantee: every assistant tool_call has a matching role:'tool' reply.
    const assistantCallIds = messages
      .filter((m) => m.role === 'assistant' && m.toolCalls)
      .flatMap((m) => m.toolCalls!.map((tc) => tc.id));
    const toolReplyIds = new Set(toolMessages.map((m) => m.toolCallId));
    for (const id of assistantCallIds) {
      expect(toolReplyIds.has(id)).toBe(true);
    }
  });
});

// --- Compile-time type-safety cases --------------------------------------
//
// These are checked by a dedicated `tsc --noEmit` pass (jest runs with
// ts-jest isolatedModules = transpile-only, so it does not type-check).
// Each `@ts-expect-error` MUST correspond to a real compile error; a
// stale/incorrect one surfaces as an "unused '@ts-expect-error' directive".

describe('onToolResult type-safety (compile-time)', () => {
  it('narrows and rejects invalid access', () => {
    // Positive: narrowing yields the correct types for each tool.
    new Prompt({
      name: 'ts-positive',
      description: 'ok',
      content: 'x',
      tools: [searchTool, mathTool],
      onToolResult: (event) => {
        if (event.tool === 'search') {
          const q: string = event.args.query;
          const h: number = event.result.hits;
          return `${q}:${h}`;
        }
        const sum: number = event.result;
        return sum;
      },
    });

    // Negative: referencing a non-existent tool name must fail to compile.
    new Prompt({
      name: 'ts-bad-name',
      description: 'bad',
      content: 'x',
      tools: [searchTool, mathTool],
      onToolResult: (event) => {
        // @ts-expect-error — 'nope' is not one of the tool names.
        if (event.tool === 'nope') {
          return event.result;
        }
        return event.result;
      },
    });

    // Negative: accessing a field not on the narrowed tool's result.
    new Prompt({
      name: 'ts-bad-result-field',
      description: 'bad',
      content: 'x',
      tools: [searchTool, mathTool],
      onToolResult: (event) => {
        if (event.tool === 'search') {
          // @ts-expect-error — `notAField` does not exist on the search result.
          return event.result.notAField;
        }
        return event.result;
      },
    });

    // Negative: accessing a field not on the narrowed tool's args.
    new Prompt({
      name: 'ts-bad-args-field',
      description: 'bad',
      content: 'x',
      tools: [searchTool, mathTool],
      onToolResult: (event) => {
        if (event.tool === 'search') {
          // @ts-expect-error — `notAnArg` does not exist on the search args.
          return event.args.notAnArg;
        }
        return event.result;
      },
    });

    expect(true).toBe(true);
  });
});
