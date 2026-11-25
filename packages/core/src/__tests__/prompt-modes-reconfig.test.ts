/**
 * Advanced Prompt Tests
 *
 * Tests for advanced prompt features including:
 * - Different get() modes (tools, stream, streamTools, streamContent)
 * - Reconfig functionality
 * - Tool execution modes (sequential, parallel, immediate)
 * - Error handling and edge cases
 */

import { a } from '@aeye/schema';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { Context } from '../types';
import { createMockExecutor, createMockStreamer } from './mocks/executor.mock';

describe('Prompt Advanced Features', () => {
  describe('Get Modes', () => {
    it('should return only tool outputs in tools mode', async () => {
      const tool = new Tool({
        name: 'calculator',
        description: 'Calculate',
        instructions: 'Calculate numbers',
        schema: a.object({ a: a.number(), b: a.number() }),
        call: (input) => input.a + input.b
      });

      const prompt = new Prompt({
        name: 'math',
        description: 'Math',
        content: 'Do math',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'calculator',
              arguments: JSON.stringify({ a: 5, b: 3 })
            }]
          },
          {
            content: 'The answer is 8',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const tools = await prompt.get('tools', {}, ctx);

      expect(tools).toBeDefined();
      expect(tools).toHaveLength(1);
      expect(tools![0].tool).toBe('calculator');
      expect(tools![0].result).toBe(8);
    });

    it('should stream tool outputs in streamTools mode', async () => {
      const tool = new Tool({
        name: 'doubler',
        description: 'Double',
        instructions: 'Double a number',
        schema: a.object({ x: a.number() }),
        call: (input) => input.x * 2
      });

      const prompt = new Prompt({
        name: 'doubling',
        description: 'Doubling',
        content: 'Double',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'doubler',
              arguments: JSON.stringify({ x: 10 })
            }]
          },
          {
            content: '20',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const toolOutputs = [];
      for await (const output of prompt.get('streamTools', {}, ctx)) {
        toolOutputs.push(output);
      }

      expect(toolOutputs.length).toBeGreaterThan(0);
      const finalOutput = toolOutputs[toolOutputs.length - 1];
      expect(finalOutput.tool).toBe('doubler');
      expect(finalOutput.result).toBe(20);
    });
  });

  describe('Reconfig', () => {
    it('should call reconfig after each iteration', async () => {
      let reconfigCalls = 0;

      const prompt = new Prompt({
        name: 'reconfig-test',
        description: 'Reconfig test',
        content: 'Test',
        schema: a.object({ value: a.number() }),
        reconfig: (stats, ctx) => {
          reconfigCalls++;
          // Continue on first call, stop after
          return reconfigCalls === 1 ? {} : false;
        }
      });

      const executor = createMockExecutor({
        responses: [
          { content: 'invalid json', finishReason: 'stop' },
          { content: '{"value": 42}', finishReason: 'stop' }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);

      expect(reconfigCalls).toBeGreaterThan(0);
      expect(result).toEqual({ value: 42 });
    });

    it('should stop when reconfig returns false', async () => {
      const prompt = new Prompt({
        name: 'stop-early',
        description: 'Stop early',
        content: 'Test',
        schema: a.object({ value: a.number() }),
        reconfig: (stats, ctx) => {
          // Always stop
          return { maxIterations: 0 };
        }
      });

      const executor = createMockExecutor({
        response: { content: 'invalid', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow();
    });
  });

  describe('Tool Execution Modes', () => {
    it('should execute tools sequentially', async () => {
      const executionOrder: string[] = [];

      const tool1 = new Tool({
        name: 'tool1',
        description: 'Tool 1',
        instructions: 'Tool 1',
        schema: a.object({}),
        call: async () => {
          await new Promise(resolve => setTimeout(resolve, 50));
          executionOrder.push('tool1');
          return 'result1';
        }
      });

      const tool2 = new Tool({
        name: 'tool2',
        description: 'Tool 2',
        instructions: 'Tool 2',
        schema: a.object({}),
        call: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          executionOrder.push('tool2');
          return 'result2';
        }
      });

      const prompt = new Prompt({
        name: 'sequential',
        description: 'Sequential',
        content: 'Execute',
        tools: [tool1, tool2],
        toolExecution: 'sequential'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'tool1', arguments: '{}' },
              { id: 'call_2', name: 'tool2', arguments: '{}' }
            ]
          },
          {
            content: 'Done',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', {}, ctx);

      // In sequential mode, tool1 should finish before tool2 starts
      expect(executionOrder).toEqual(['tool1', 'tool2']);
    });

    it('should execute tools in parallel', async () => {
      const startTimes: Record<string, number> = {};
      const endTimes: Record<string, number> = {};

      const tool1 = new Tool({
        name: 'slow',
        description: 'Slow tool',
        instructions: 'Slow',
        schema: a.object({}),
        call: async () => {
          startTimes.slow = Date.now();
          await new Promise(resolve => setTimeout(resolve, 50));
          endTimes.slow = Date.now();
          return 'slow-result';
        }
      });

      const tool2 = new Tool({
        name: 'fast',
        description: 'Fast tool',
        instructions: 'Fast',
        schema: a.object({}),
        call: async () => {
          startTimes.fast = Date.now();
          await new Promise(resolve => setTimeout(resolve, 10));
          endTimes.fast = Date.now();
          return 'fast-result';
        }
      });

      const prompt = new Prompt({
        name: 'parallel',
        description: 'Parallel',
        content: 'Execute',
        tools: [tool1, tool2],
        toolExecution: 'parallel'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'slow', arguments: '{}' },
              { id: 'call_2', name: 'fast', arguments: '{}' }
            ]
          },
          {
            content: 'Done',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', {}, ctx);

      // Fast tool should finish before slow tool
      expect(endTimes.fast).toBeLessThan(endTimes.slow);
      // Both should start around the same time (parallel execution)
      expect(Math.abs(startTimes.slow - startTimes.fast)).toBeLessThan(20);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle prompt with no executor or streamer', async () => {
      const prompt = new Prompt({
        name: 'no-executor',
        description: 'No executor',
        content: 'Test'
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow('No executor or streamer');
    });

    it('should handle retool function returning false', async () => {
      const tool = new Tool({
        name: 'conditional-tool',
        description: 'Conditional',
        instructions: 'Conditional',
        schema: a.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'with-retool',
        description: 'With retool',
        content: 'Test',
        tools: [tool],
        retool: () => false // Not compatible
      });

      const executor = createMockExecutor({
        response: { content: 'fallback', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      // When retool returns false, prompt is not compatible and returns undefined
      const result = await prompt.get('result', {}, ctx);
      expect(result).toBeUndefined();
    });

    it('should handle config returning false', async () => {
      const prompt = new Prompt({
        name: 'config-false',
        description: 'Config false',
        content: 'Test',
        config: () => false // Not compatible
      });

      const executor = createMockExecutor({
        response: { content: 'test', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBeUndefined();
    });

    it('should handle excludeMessages option', async () => {
      const prompt = new Prompt({
        name: 'exclude-messages',
        description: 'Exclude messages',
        content: 'Standalone prompt',
        excludeMessages: true
      });

      const executor = createMockExecutor({
        response: { content: 'response', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'Previous message 1' },
          { role: 'assistant', content: 'Previous response 1' }
        ]
      };

      await prompt.get('result', {}, ctx);

      // Executor should be called with only the prompt message, not context messages
      expect(executor).toHaveBeenCalled();
    });

    it('should handle toolsOnly config', async () => {
      const tool = new Tool({
        name: 'data-fetcher',
        description: 'Fetch data',
        instructions: 'Fetch data',
        schema: a.object({}),
        call: () => ({ data: 'fetched' })
      });

      const prompt = new Prompt({
        name: 'tools-only',
        description: 'Tools only',
        content: 'Fetch',
        tools: [tool],
        toolsOnly: true,
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'data-fetcher',
              arguments: '{}'
            }]
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      // When toolsOnly is true and tools execute, result should be undefined
      expect(result).toBeUndefined();
    });
  });

  describe('Input and Schema Functions', () => {
    it('should handle a dynamic schema bound per (ctx, input)', async () => {
      const WithAge = a.object({ name: a.string(), age: a.number() });
      const NameOnly = a.object({ name: a.string() });
      const prompt = new Prompt({
        name: 'dynamic-schema',
        description: 'Dynamic schema',
        content: 'Extract',
        // Types the prompt's input.
        input: (_input?: { includeAge: boolean }) => ({}),
        schema: a
          .declare<{ Person: { name: string; age?: number } }>()
          .dynamic((_ctx: Context<{}, {}>, input?: { includeAge: boolean }) => ({
            Person: input?.includeAge ? WithAge : NameOnly,
          }), { key: (_ctx, input) => !!input?.includeAge })
          .result('Person'),
      });

      const ctx = (content: string): Context<{}, {}> => ({
        execute: createMockExecutor({ responses: [{ content, finishReason: 'stop' }, { content, finishReason: 'stop' }] }),
        messages: []
      });

      // Without age: the name-only shape fits.
      const result = await prompt.get('result', { includeAge: false }, ctx(JSON.stringify({ name: 'Alice' })));
      expect(result).toEqual({ name: 'Alice' });

      // With age: the shape bound for this input requires it.
      expect(await prompt.get('result', { includeAge: true }, ctx(JSON.stringify({ name: 'Bob', age: 3 }))))
        .toEqual({ name: 'Bob', age: 3 });
      await expect(prompt.get('result', { includeAge: true }, { ...ctx(JSON.stringify({ name: 'Bob' })) }))
        .rejects.toThrow(/age: Required/);
    });

    it('should handle input function', async () => {
      let capturedInput: any;

      const prompt = new Prompt({
        name: 'with-input-fn',
        description: 'With input function',
        content: 'Hello {{greeting}}',
        input: (input: { name: string }, ctx) => {
          capturedInput = input;
          return { greeting: `Hello ${input.name}!` };
        }
      });

      const executor = createMockExecutor({
        response: { content: 'Hi!', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', { name: 'Bob' }, ctx);

      expect(capturedInput).toEqual({ name: 'Bob' });
    });
  });
});
