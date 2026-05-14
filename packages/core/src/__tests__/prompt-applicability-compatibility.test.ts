/**
 * Final Coverage Tests for Prompt
 *
 * Targeted tests to cover remaining uncovered lines in prompt.ts
 */

import { z } from 'zod';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { Context, ToolCall } from '../types';
import { createMockExecutor, createMockStreamer } from './mocks/executor.mock';

describe('Prompt Final Coverage', () => {
  describe('Applicability', () => {
    it('should check schema applicability', async () => {
      const prompt = new Prompt({
        name: 'check-schema',
        description: 'Check schema',
        content: 'Test',
        schema: () => false // Not applicable
      });

      const applicable = await prompt.applicable();
      expect(applicable).toBe(false);
    });

    it('should check config applicability', async () => {
      const prompt = new Prompt({
        name: 'check-config',
        description: 'Check config',
        content: 'Test',
        config: () => false // Not applicable
      });

      const applicable = await prompt.applicable();
      expect(applicable).toBe(false);
    });

    it('should check retool applicability', async () => {
      const prompt = new Prompt({
        name: 'check-retool',
        description: 'Check retool',
        content: 'Test',
        retool: () => false // Not applicable
      });

      const applicable = await prompt.applicable();
      expect(applicable).toBe(false);
    });
  });

  describe('Custom Runner', () => {
    it('should support custom runner in get stream mode', async () => {
      const prompt = new Prompt({
        name: 'with-runner-stream',
        description: 'With runner stream',
        content: 'Test'
      });

      let runnerCalled = false;

      const streamer = createMockStreamer({
        chunks: [
          { content: 'test', finishReason: 'stop' }
        ]
      });

      const ctx: Context<{}, {}> = {
        stream: streamer as any,
        runner: (component, input, ctx, defaultRun) => {
          runnerCalled = true;
          return defaultRun(ctx);
        },
        messages: []
      };

      prompt.run({}, ctx)

      expect(runnerCalled).toBe(true);
    });
  });

  describe('Resolve Function', () => {
    it('should return undefined when config returns false', async () => {
      const prompt = new Prompt({
        name: 'config-false',
        description: 'Config false',
        content: 'Test',
        config: () => false
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

    it('should return undefined when retool returns false', async () => {
      const tool = new Tool({
        name: 'test-tool',
        description: 'Test',
        instructions: 'Test',
        schema: z.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'retool-false',
        description: 'Retool false',
        content: 'Test',
        tools: [tool],
        retool: () => false
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
  });

  describe('Forget Function', () => {
    it('should handle forget when no inputTokens available', async () => {
      const prompt = new Prompt({
        name: 'forget-no-tokens',
        description: 'Forget no tokens',
        content: 'Test'
      });

      let callCount = 0;
      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: {}, // No inputTokens
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'success',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('success');
    });

    it('should handle forget when no context messages', async () => {
      const prompt = new Prompt({
        name: 'forget-no-ctx-msgs',
        description: 'Forget no context msgs',
        content: 'Test'
      });

      let callCount = 0;
      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: {input : 1000 } },
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'success',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        // No messages
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('success');
    });

    it('should handle forget when availablePromptTokens <= 0', async () => {
      const prompt = new Prompt({
        name: 'forget-negative-tokens',
        description: 'Forget negative tokens',
        content: 'Test'
      });

      let callCount = 0;
      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: { input: 100 } }, // Very few tokens
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'success',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'test', tokens: 50 }
        ],
        maxOutputTokens: 4096 // Large, will make available tokens negative
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('success');
    });

    it('should use estimateUsage when messages missing tokens', async () => {
      const prompt = new Prompt({
        name: 'estimate-usage',
        description: 'Estimate usage',
        content: 'Test'
      });

      let estimatorCalled = false;
      let callCount = 0;

      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: { input: 1000, total: 1000 } },
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'success',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'test message without tokens' }
        ],
        estimateUsage: () => {
          estimatorCalled = true;
          return { text: { input: 10 } };
        },
        maxOutputTokens: 500
      };

      await prompt.get('result', {}, ctx);
      expect(estimatorCalled).toBe(true);
    });
  });

  describe('Streamify', () => {
    it('should convert executor to streamer', async () => {
      const prompt = new Prompt({
        name: 'streamify-test',
        description: 'Streamify test',
        content: 'Test'
      });

      const executor = createMockExecutor({
        response: {
          content: 'test',
          finishReason: 'stop',
          reasoning: 'some reasoning',
          toolCalls: []
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor, // Using execute instead of stream triggers streamify
        messages: []
      };

      // Use stream mode to trigger streamify
      const events = [];
      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Message Handling', () => {
    it('should exclude context messages when excludeMessages is true', async () => {
      const prompt = new Prompt({
        name: 'exclude-msgs',
        description: 'Exclude msgs',
        content: 'Test',
        excludeMessages: true
      });

      // Snapshot messages at executor invocation time. The Prompt loop
      // mutates `request.messages` after the executor returns (the
      // assistant response is pushed in for the next iteration), so
      // jest.fn().mock.calls captures a reference that reflects the
      // post-mutation state — we have to snapshot here.
      let messagesAtCall: number | undefined;
      const baseExecutor = createMockExecutor({
        response: { content: 'response', finishReason: 'stop' }
      });
      const executor: typeof baseExecutor = jest.fn(async (request, ctx, metadata, signal) => {
        messagesAtCall = request.messages.length;
        return baseExecutor(request, ctx, metadata, signal);
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'previous message' },
          { role: 'assistant', content: 'previous response' }
        ]
      };

      await prompt.get('result', {}, ctx);

      // The executor should have seen only the prompt's system message.
      expect(messagesAtCall).toBe(1);
    });

    it('should include context messages by default', async () => {
      const prompt = new Prompt({
        name: 'include-msgs',
        description: 'Include msgs',
        content: 'Test'
      });

      const executor = createMockExecutor({
        response: { content: 'response', finishReason: 'stop' }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'previous message' }
        ]
      };

      await prompt.get('result', {}, ctx);

      const call = (executor as any).mock.calls[0][0];
      expect(call.messages.length).toBeGreaterThan(1); // Context messages + prompt message
    });
  });

  describe('Tool Execution Modes', () => {
    it('should handle skip mode for tool execution', async () => {
      const tool = new Tool({
        name: 'skipper',
        description: 'Skipper',
        instructions: 'Skip',
        schema: z.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'skip-tools',
        description: 'Skip tools',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'nonexistent', // Tool not found, will skip
              arguments: '{}'
            }]
          },
          {
            content: 'recovered',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('recovered');
    });
  });

  describe('Additional Coverage', () => {
    it('should return kind as prompt (line 224)', () => {
      const prompt = new Prompt({
        name: 'test',
        description: 'test',
        content: 'test'
      });

      expect(prompt.kind).toBe('prompt');
    });

    it('should handle tool execution with parallel mode (lines 575-577)', async () => {
      const tool1 = new Tool({
        name: 'par-tool-1',
        description: 'Parallel tool 1',
        instructions: 'First parallel tool',
        schema: z.object({ value: z.number() }),
        call: async (args) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return `result1: ${args.value}`;
        }
      });

      const tool2 = new Tool({
        name: 'par-tool-2',
        description: 'Parallel tool 2',
        instructions: 'Second parallel tool',
        schema: z.object({ value: z.number() }),
        call: async (args) => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return `result2: ${args.value}`;
        }
      });

      const prompt = new Prompt({
        name: 'parallel-test',
        description: 'Parallel test',
        content: 'Test parallel tool execution',
        tools: [tool1, tool2],
        toolExecution: 'parallel'
      });

      const executor = jest.fn(async (request) => {
        if (request.messages.length === 1) {
          return {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: 'call_1',
                name: 'par-tool-1',
                arguments: '{"value": 10}'
              },
              {
                id: 'call_2',
                name: 'par-tool-2',
                arguments: '{"value": 20}'
              }
            ] as ToolCall[],
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'All parallel tools executed',
          finishReason: 'stop' as const,
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('All parallel tools executed');
    });

    it('should handle tool execution with sequential mode (lines 609, 615, 618)', async () => {
      const tool1 = new Tool({
        name: 'seq-tool-1',
        description: 'Sequential tool 1',
        instructions: 'First tool',
        schema: z.object({ value: z.number() }),
        call: (args) => `result1: ${args.value}`
      });

      const tool2 = new Tool({
        name: 'seq-tool-2',
        description: 'Sequential tool 2',
        instructions: 'Second tool',
        schema: z.object({ value: z.number() }),
        call: (args) => `result2: ${args.value}`
      });

      const prompt = new Prompt({
        name: 'sequential-test',
        description: 'Sequential test',
        content: 'Test sequential tool execution',
        tools: [tool1, tool2],
        toolExecution: 'sequential'
      });

      let callCount = 0;

      const executor = jest.fn(async (request) => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'tool_calls' as const,
            toolCalls: [
              {
                id: 'call_1',
                name: 'seq-tool-1',
                arguments: '{"value": 1}'
              },
              {
                id: 'call_2',
                name: 'seq-tool-2',
                arguments: '{"value": 2}'
              }
            ] as ToolCall[],
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'All tools executed',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('All tools executed');
    });

    it('should handle tool execution error path (line 1057)', async () => {
      const errorTool = new Tool({
        name: 'error-tool',
        description: 'Tool that throws',
        instructions: 'Throws an error',
        schema: z.object({}),
        call: async () => {
          throw new Error('Tool execution failed!');
        }
      });

      const prompt = new Prompt({
        name: 'tool-error-test',
        description: 'Tool error test',
        content: 'Test tool error',
        tools: [errorTool]
      });

      let callCount = 0;

      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'tool_calls' as const,
            toolCalls: [{
              id: 'call_1',
              name: 'error-tool',
              arguments: '{}'
            }] as ToolCall[],
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'Handled tool error',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBeDefined();
    });
  });
});
