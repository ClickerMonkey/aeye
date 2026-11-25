/**
 * Schema wiring: answers are decoded through the plan the request was sent
 * with, and every consumer (a codec on the schema, a tool's `call`, the
 * prompt's result) sees the CODE shape, whatever the model wrote.
 *
 * (The encode/decode of each dialect itself — records as pairs, null for
 * absent, tuples as numeric keys, JSON text — is @aeye/schema's job and is
 * covered by its corpus: core-schema-strictify / dialects tests.)
 *
 * A request is planned for OpenAI strict, where a record goes as
 * `[{key, value}]` pairs and an absent optional as `null`:
 * - directly, with `planRequest(request, model)` (Tool.parse);
 * - or by a fake provider that calls `prepareRequest(request, model)` before
 *   replying, as a real one does (Prompt).
 */

import { a } from '@aeye/schema';
import { planRequest, prepareRequest, sentOutput, sentTools } from '../schema';
import { Tool } from '../tool';
import { Prompt } from '../prompt';
import type { Chunk, Context, Request, Response } from '../types';

const OPENAI_STRICT_MODEL = { id: 'gpt-4o', provider: 'openai', capabilities: ['toolsStrict', 'structured'] };

type Args = { args: Record<string, string>; limit?: number };

const ArgsSchema = a.object({
  args: a.record(a.string()),
  limit: a.number().optional(),
});

/** The schema with a codec that records the value it decodes (the code shape, after the wire is undone). */
const capture = (received: { raw?: unknown }) => a.codec(ArgsSchema, {
  decode: (v: Args) => { received.raw = v; return v; },
  encode: (v: Args) => v,
});

describe("Tool.parse + Prompt output parse hand the conceptual value to the schema's codec", () => {
  describe('Tool.parse', () => {
    const makeTool = (received: { raw?: unknown }) =>
      new Tool<{}, {}, string, Args>({
        name: 'wire-tool',
        description: 'decode before the codec',
        instructions: '',
        schema: capture(received),
        call: () => 'ok',
      });

    const strictPlan = async (tool: Tool<{}, {}, string, Args>, ctx: Context<{}, {}>) => {
      const plan = planRequest({ tools: [(await tool.definition(ctx))!] }, OPENAI_STRICT_MODEL);
      expect(plan.get('wire-tool').strict).toBe(true);
      return plan;
    };

    it('planned for OpenAI strict: array-of-pairs + null-optional decoded', async () => {
      const received: { raw?: unknown } = {};
      const tool = makeTool(received);
      const ctx = {} as Context<{}, {}>;
      const wire = JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null });
      await tool.parse(ctx, wire, await strictPlan(tool, ctx));
      // Custom parser saw the conceptual value: record + optional absent.
      expect(received.raw).toEqual({ args: { a: 'b' } });
      expect('limit' in (received.raw as object)).toBe(false);
    });

    it('planned for OpenAI strict: a present optional is kept', async () => {
      const received: { raw?: unknown } = {};
      const tool = makeTool(received);
      const ctx = {} as Context<{}, {}>;
      const wire = JSON.stringify({ args: [{ key: 'k', value: 'v' }], limit: 5 });
      await tool.parse(ctx, wire, await strictPlan(tool, ctx));
      expect(received.raw).toEqual({ args: { k: 'v' }, limit: 5 });
    });

    it('with NO plan: decoded in the code shape (an answer in the code shape passes as is)', async () => {
      const received: { raw?: unknown } = {};
      const tool = makeTool(received);
      const ctx = {} as Context<{}, {}>;
      await tool.parse(ctx, JSON.stringify({ args: { a: 'b' }, limit: 2 }));
      expect(received.raw).toEqual({ args: { a: 'b' }, limit: 2 });
    });

    it('with NO plan: wire pairs do not fit the code shape, so the call is rejected before the codec', async () => {
      const received: { raw?: unknown } = {};
      const tool = makeTool(received);
      const ctx = {} as Context<{}, {}>;
      await expect(tool.parse(ctx, JSON.stringify({ args: [{ key: 'a', value: 'b' }] }))).rejects.toThrow();
      expect(received.raw).toBeUndefined();
    });

    it('a call without a codec gets the code shape too', async () => {
      const seen: unknown[] = [];
      const tool = new Tool({
        name: 'wire-tool',
        description: 'decode before call',
        instructions: '',
        schema: ArgsSchema,
        call: (input) => { seen.push(input); return 'ok'; },
      });
      const ctx = {} as Context<{}, {}>;
      const plan = planRequest({ tools: [(await tool.definition(ctx))!] }, OPENAI_STRICT_MODEL);
      const input = await tool.parse(ctx, JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null }), plan);
      tool.run(input, ctx);
      expect(seen).toEqual([{ args: { a: 'b' } }]);
    });
  });

  describe('Prompt output parse', () => {
    const makePrompt = (received: { raw?: unknown }) =>
      new Prompt<{}, {}, string, {}, Args>({
        name: 'wire-prompt',
        description: 'decode before the output codec',
        content: 'Test',
        schema: capture(received),
      });

    it('planned for OpenAI strict by the provider (executor)', async () => {
      const received: { raw?: unknown } = {};
      const prompt = makePrompt(received);
      const sent: Request[] = [];
      // A provider plans the request for its model before sending it.
      const executor = jest.fn(async (request: Request): Promise<Response> => {
        const prepared = await prepareRequest(request, OPENAI_STRICT_MODEL);
        sent.push(prepared);
        return {
          content: JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null }),
          finishReason: 'stop',
          model: 'mock',
        };
      });
      const ctx: Context<{}, {}> = { execute: executor, messages: [] };
      const result = await prompt.get('result', {}, ctx);
      // What was sent: the record as pairs, strict.
      const output = sentOutput(sent[0]);
      expect(output?.strict).toBe(true);
      expect(JSON.stringify(output?.schema)).toContain('"key"');
      expect(received.raw).toEqual({ args: { a: 'b' } });
      expect(result).toEqual({ args: { a: 'b' } });
    });

    it('planned for OpenAI strict by the provider (streamer)', async () => {
      const received: { raw?: unknown } = {};
      const prompt = makePrompt(received);
      const streamer = async function* (request: Request): AsyncGenerator<Chunk, Response, void> {
        await prepareRequest(request, OPENAI_STRICT_MODEL);
        const content = JSON.stringify({ args: [{ key: 'x', value: 'y' }], limit: 3 });
        yield { content, finishReason: 'stop' };
        return { content, finishReason: 'stop', model: 'mock' };
      };
      const ctx: Context<{}, {}> = { stream: streamer as any, messages: [] };
      let result: unknown;
      for await (const event of prompt.get('stream', {}, ctx)) {
        if (event.type === 'complete') result = event.output;
      }
      expect(received.raw).toEqual({ args: { x: 'y' }, limit: 3 });
      expect(result).toEqual({ args: { x: 'y' }, limit: 3 });
    });

    it('without a codec the result is the code shape', async () => {
      const prompt = new Prompt({
        name: 'wire-prompt',
        description: 'decode the output',
        content: 'Test',
        schema: ArgsSchema,
      });
      const executor = jest.fn(async (request: Request): Promise<Response> => {
        await prepareRequest(request, OPENAI_STRICT_MODEL);
        return { content: JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null }), finishReason: 'stop', model: 'mock' };
      });
      const result = await prompt.get('result', {}, { execute: executor, messages: [] });
      expect(result).toEqual({ args: { a: 'b' } });
    });

    it('with NO plan (no provider planned): decoded in the code shape', async () => {
      const received: { raw?: unknown } = {};
      const prompt = makePrompt(received);
      const executor = jest.fn(async () => ({
        content: JSON.stringify({ args: { a: 'b' } }),
        finishReason: 'stop' as const,
        model: 'mock',
      }));
      const ctx: Context<{}, {}> = { execute: executor, messages: [] };
      await prompt.get('result', {}, ctx);
      expect(received.raw).toEqual({ args: { a: 'b' } });
    });
  });

  describe('Prompt tool calls', () => {
    it("a tool's call gets the code shape of a call planned for OpenAI strict", async () => {
      const seen: unknown[] = [];
      const tool = new Tool({
        name: 'wire_tool',
        description: 'decode before call',
        instructions: '',
        schema: ArgsSchema,
        call: (input) => { seen.push(input); return 'ok'; },
      });
      const prompt = new Prompt({ name: 'p', description: 'p', content: 'Use the tool.', tools: [tool] });
      let calls = 0;
      const sent: Request[] = [];
      const executor = jest.fn(async (request: Request): Promise<Response> => {
        const prepared = await prepareRequest(request, OPENAI_STRICT_MODEL);
        sent.push(prepared);
        return calls++ === 0
          ? {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: '1', name: 'wire_tool', arguments: JSON.stringify({ args: [{ key: 'a', value: 'b' }], limit: null }) }],
            model: 'mock',
          }
          : { content: 'done', finishReason: 'stop', model: 'mock' };
      });
      const result = await prompt.get('result', {}, { execute: executor, messages: [] });
      expect(result).toBe('done');
      const [sentTool] = sentTools(sent[0]);
      expect(sentTool.strict).toBe(true);
      expect(JSON.stringify(sentTool.parameters)).toContain('"key"');
      expect(seen).toEqual([{ args: { a: 'b' } }]);
    });
  });
});
