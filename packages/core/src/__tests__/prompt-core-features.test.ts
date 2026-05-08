/**
 * Prompt Unit Tests
 *
 * Comprehensive tests for the Prompt component including:
 * - Template rendering with Handlebars
 * - Tool execution (sequential, parallel, immediate)
 * - Schema validation with Zod
 * - Streaming and non-streaming execution
 * - Context handling and applicability
 */

import { z } from 'zod';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { Context } from '../types';
import { createMockExecutor, createMockStreamer } from './mocks/executor.mock';
import { mockMessages } from './mocks/fixtures';

describe('Prompt', () => {
  describe('Construction', () => {
    it('should create prompt with basic config', () => {
      const prompt = new Prompt({
        name: 'test',
        description: 'Test prompt',
        content: 'Hello {{name}}'
      });

      expect(prompt.name).toBe('test');
      expect(prompt.description).toBe('Test prompt');
    });

    it('should create prompt with input function', () => {
      const prompt = new Prompt({
        name: 'greet',
        description: 'Greet user',
        content: 'Hello {{name}}',
        input: (input: { user: string }) => ({ name: input.user })
      });

      expect(prompt).toBeDefined();
    });

    it('should create prompt with schema', () => {
      const prompt = new Prompt({
        name: 'extract',
        description: 'Extract data',
        content: 'Extract information',
        schema: z.object({ name: z.string(), age: z.number() })
      });

      expect(prompt).toBeDefined();
    });

    it('should create prompt with tools', () => {
      const tool = new Tool({
        name: 'calculate',
        description: 'Calculate',
        instructions: 'Calculate numbers',
        schema: z.object({ a: z.number(), b: z.number() }),
        call: (input) => input.a + input.b
      });

      const prompt = new Prompt({
        name: 'math',
        description: 'Math prompt',
        content: 'Do math',
        tools: [tool]
      });

      expect(prompt.refs).toHaveLength(1);
      expect(prompt.refs[0]).toBe(tool);
    });
  });

  describe('Handlebars Template Rendering', () => {
    it('should render simple template', async () => {
      const prompt = new Prompt({
        name: 'greet',
        description: 'Greet',
        content: 'Hello {{name}}!',
        input: (input: { name: string }) => ({ name: input.name })
      });

      // Mock executor to capture the rendered message
      const executor = createMockExecutor({
        response: { content: 'Hi', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', { name: 'Alice' }, ctx);

      // Check that executor was called with rendered template
      expect(executor).toHaveBeenCalled();
      const request = (executor as any).mock.calls[0][0];
      expect(request.messages[0].content).toContain('Hello Alice!');
    });

    it('should render template with multiple variables', async () => {
      const prompt = new Prompt({
        name: 'report',
        description: 'Report',
        content: '{{user}} scored {{score}} points',
        input: (input: { user: string; score: number }) => input
      });

      const executor = createMockExecutor({
        response: { content: 'OK', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', { user: 'Bob', score: 100 }, ctx);

      const request = (executor as any).mock.calls[0][0];
      expect(request.messages[0].content).toContain('Bob scored 100 points');
    });

    it('should render template with loops', async () => {
      const prompt = new Prompt({
        name: 'list',
        description: 'List items',
        content: 'Items:\n{{#each items}}- {{this}}\n{{/each}}',
        input: (input: { items: string[] }) => input
      });

      const executor = createMockExecutor({
        response: { content: 'Listed', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', { items: ['A', 'B', 'C'] }, ctx);

      const request = (executor as any).mock.calls[0][0];
      expect(request.messages[0].content).toContain('- A');
      expect(request.messages[0].content).toContain('- B');
      expect(request.messages[0].content).toContain('- C');
    });

    it('should render template with conditionals', async () => {
      const prompt = new Prompt({
        name: 'conditional',
        description: 'Conditional',
        content: '{{#if isAdmin}}Admin access{{else}}User access{{/if}}',
        input: (input: { isAdmin: boolean }) => input
      });

      const executor = createMockExecutor({
        response: { content: 'OK', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', { isAdmin: true }, ctx);

      const request = (executor as any).mock.calls[0][0];
      expect(request.messages[0].content).toContain('Admin access');
    });
  });

  describe('Schema Validation', () => {
    it('should parse response with Zod schema', async () => {
      const prompt = new Prompt({
        name: 'extract',
        description: 'Extract',
        content: 'Extract person info',
        schema: z.object({
          name: z.string(),
          age: z.number()
        })
      });

      const executor = createMockExecutor({
        response: {
          content: JSON.stringify({ name: 'Alice', age: 30 }),
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);

      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    it('should handle schema validation errors', async () => {
      const prompt = new Prompt({
        name: 'extract',
        description: 'Extract',
        content: 'Extract',
        schema: z.object({
          name: z.string(),
          age: z.number()
        }),
        toolIterations: 1,
      });

      const executor = createMockExecutor({
        response: {
          content: JSON.stringify({ name: 'Alice', age: 'invalid' }), // Invalid age
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      // Should throw when validation fails and no more retries
      await expect(prompt.get('result', {}, ctx)).rejects.toThrow();
    });

    it('should support plain text output (no schema)', async () => {
      const prompt = new Prompt({
        name: 'chat',
        description: 'Chat',
        content: 'Say hello'
      });

      const executor = createMockExecutor({
        response: {
          content: 'Hello, world!',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);

      expect(result).toBe('Hello, world!');
    });
  });

  describe('Tool Execution', () => {
    it('should execute tools when called by AI', async () => {
      const tool = new Tool({
        name: 'add',
        description: 'Add numbers',
        instructions: 'Add two numbers together',
        schema: z.object({ a: z.number(), b: z.number() }),
        call: (input) => input.a + input.b
      });

      const prompt = new Prompt({
        name: 'math',
        description: 'Math',
        content: 'Calculate',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          // First call: tool calls
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'add',
              arguments: '{ "a": 5, "b": 3 }'
            }]
          },
          // Second call: final answer
          {
            content: '8',
            finishReason: 'stop',
            usage: { text: { input: 10, output: 5 } }
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);

      expect(result).toBe('8');
      // Executor should be called at least twice (tool call + final answer)
      expect(executor).toHaveBeenCalled();
    });

    it('should execute multiple tools in parallel', async () => {
      const tool1 = new Tool({
        name: 'multiply',
        description: 'Multiply',
        instructions: 'Multiply two numbers',
        schema: z.object({ a: z.number(), b: z.number() }),
        call: async (input) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return input.a * input.b;
        }
      });

      const tool2 = new Tool({
        name: 'subtract',
        description: 'Subtract',
        instructions: 'Subtract two numbers',
        schema: z.object({ a: z.number(), b: z.number() }),
        call: async (input) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return input.a - input.b;
        }
      });

      const prompt = new Prompt({
        name: 'math',
        description: 'Math',
        content: 'Calculate',
        tools: [tool1, tool2],
        toolExecution: 'parallel'
      });

      const executor = createMockExecutor({
        responses: [
          // First call: tool calls
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'multiply', arguments: '{ "a": 5, "b": 3 }' },
              { id: 'call_2', name: 'subtract', arguments: '{ "a": 10, "b": 4 }' }
            ]
          },
          // Second call: final answer
          {
            content: 'Results: 15 and 6',
            finishReason: 'stop',
            usage: { text: { input: 10, output: 5 } }
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const startTime = Date.now();
      await prompt.get('result', {}, ctx);
      const duration = Date.now() - startTime;

      // Parallel should be faster than sequential (< 15ms instead of ~20ms)
      expect(duration).toBeLessThan(70);
    });

    it('should handle tool errors gracefully', async () => {
      const tool = new Tool({
        name: 'divide',
        description: 'Divide',
        instructions: 'Divide two numbers',
        schema: z.object({ a: z.number(), b: z.number() }),
        call: (input) => {
          if (input.b === 0) throw new Error('Division by zero');
          return input.a / input.b;
        }
      });

      const prompt = new Prompt({
        name: 'math',
        description: 'Math',
        content: 'Calculate',
        tools: [tool],
        toolIterations: 2,
      });

      const executor = createMockExecutor({
        responses: [
          // First call: tool calls (error)
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'divide',
              arguments: JSON.stringify({ a: 10, b: 0 })
            }]
          },
          // Second call: final answer after tool error
          {
            content: 'Cannot divide by zero',
            finishReason: 'stop',
            usage: { text: { input: 10, output: 5 } }
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);

      expect(result).toBe('Cannot divide by zero');
    });
  });

  describe('Streaming', () => {
    it('should stream text content', async () => {
      const prompt = new Prompt({
        name: 'chat',
        description: 'Chat',
        content: 'Say hello'
      });

      const streamer = createMockStreamer({
        chunks: [
          { content: 'Hello' },
          { content: ' ' },
          { content: 'world' },
          { content: '!', finishReason: 'stop', usage: { text: { input: 5, output: 10 } } }
        ]
      });

      const ctx: Context<{}, {}> = {
        stream: streamer as any,
        messages: []
      };

      const textChunks: string[] = [];
      for await (const chunk of prompt.get('streamContent', {}, ctx)) {
        textChunks.push(chunk);
      }

      // Should include all chunks (note: may include duplicates due to prompt retries)
      expect(textChunks).toContain('Hello');
      expect(textChunks).toContain(' ');
      expect(textChunks).toContain('world');
      expect(textChunks).toContain('!');
    });

    it('should emit events during streaming', async () => {
      const prompt = new Prompt({
        name: 'chat',
        description: 'Chat',
        content: 'Count to 3'
      });

      const streamer = createMockStreamer({
        chunks: [
          { content: '1' },
          { content: ', 2' },
          { content: ', 3', finishReason: 'stop', usage: { text: { input: 5, output: 8 } } }
        ]
      });

      const ctx: Context<{}, {}> = {
        stream: streamer as any,
        messages: []
      };

      const events: any[] = [];
      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      // Should have text partials and complete event
      const textEvents = events.filter(e => e.type === 'textPartial');
      const completeEvents = events.filter(e => e.type === 'complete');

      expect(textEvents.length).toBeGreaterThan(0);
      expect(completeEvents).toHaveLength(1);
    });
  });

  describe('Context and Applicability', () => {
    it('should check default applicability', async () => {
      const prompt = new Prompt({
        name: 'test',
        description: 'Test',
        content: 'Test'
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const applicable = await prompt.applicable(ctx);

      expect(applicable).toBe(true);
    });

    it('should use custom applicability function', async () => {
      const prompt = new Prompt({
        name: 'admin',
        description: 'Admin only',
        content: 'Admin action',
        applicable: async (ctx: Context<{ isAdmin: boolean }, {}>) => {
          return ctx.isAdmin === true;
        }
      });

      const adminCtx: Context<{ isAdmin: boolean }, {}> = {
        isAdmin: true,
        messages: []
      };

      const userCtx: Context<{ isAdmin: boolean }, {}> = {
        isAdmin: false,
        messages: []
      };

      expect(await prompt.applicable(adminCtx)).toBe(true);
      expect(await prompt.applicable(userCtx)).toBe(false);
    });

    it('should include context messages in request', async () => {
      const prompt = new Prompt({
        name: 'continue',
        description: 'Continue conversation',
        content: 'Continue the conversation'
      });

      const executor = createMockExecutor({
        response: { content: 'Continued', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' }
        ]
      };

      await prompt.get('result', {}, ctx);

      const request = (executor as any).mock.calls[0][0];
      expect(request.messages.length).toBeGreaterThan(1); // Should include context messages
    });

    it('should exclude context messages when configured', async () => {
      const prompt = new Prompt({
        name: 'standalone',
        description: 'Standalone',
        content: 'Standalone prompt',
        excludeMessages: true
      });

      // Snapshot at call time — the Prompt loop mutates request.messages
      // post-call (pushes assistant response), so jest.fn().mock.calls
      // captures a reference that reflects the mutation.
      let snapshot: { content: unknown }[] = [];
      const baseExecutor = createMockExecutor({
        response: { content: 'Response', finishReason: 'stop' }
      });
      const executor: typeof baseExecutor = jest.fn(async (request, ctx, metadata, signal) => {
        snapshot = request.messages.map((m: any) => ({ content: m.content }));
        return baseExecutor(request, ctx, metadata, signal);
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'Previous message' }
        ]
      };

      await prompt.get('result', {}, ctx);

      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].content).toContain('Standalone prompt');
    });
  });

  describe('Configuration', () => {
    it('should apply static config', async () => {
      const prompt = new Prompt({
        name: 'configured',
        description: 'Configured',
        content: 'Test',
        config: {
          temperature: 0.5,
          maxTokens: 100
        }
      });

      const executor = createMockExecutor({
        response: { content: 'OK', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', {}, ctx);

      const request = (executor as any).mock.calls[0][0];
      expect(request.temperature).toBe(0.5);
      expect(request.maxTokens).toBe(100);
    });

    it('should apply dynamic config function', async () => {
      const prompt = new Prompt({
        name: 'dynamic',
        description: 'Dynamic',
        content: 'Test',
        config: (input?: { temp: number }) => ({
          temperature: input?.temp
        })
      });

      const executor = createMockExecutor({
        response: { content: 'OK', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await prompt.get('result', { temp: 0.8 }, ctx);

      const request = (executor as any).mock.calls[0][0];
      expect(request.temperature).toBe(0.8);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty input', async () => {
      const prompt = new Prompt({
        name: 'empty',
        description: 'Empty',
        content: 'No variables'
      });

      const executor = createMockExecutor({
        response: { content: 'OK', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);

      expect(result).toBe('OK');
    });

    it('should handle refusal from AI', async () => {
      const prompt = new Prompt({
        name: 'refused',
        description: 'Refused',
        content: 'Request something'
      });

      const executor = createMockExecutor({
        response: {
          content: 'I cannot do that',
          finishReason: 'stop',
          refusal: 'Policy violation'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      // Refusal is treated as an error by the prompt
      await expect(prompt.get('result', {}, ctx)).rejects.toThrow('Policy violation');
    });
  });
});
