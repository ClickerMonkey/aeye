/**
 * Prompt Streaming and Tool Event Tests
 *
 * Tests for streaming behavior, tool event emission, abort handling,
 * reconfig retry overrides, and tool execution state management.
 */

import { a } from '@aeye/schema';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool } from '../tool';
import { Context } from '../types';
import { createMockExecutor, createMockStreamer } from './mocks/executor.mock';

describe('Prompt Streaming and Tool Events', () => {
  describe('Stream Controller Abort Handling', () => {
    it('should break from stream loop when controller is aborted', async () => {
      const prompt = new Prompt({
        name: 'abort-during-stream',
        description: 'Abort during stream',
        content: 'Test'
      });

      let chunkCount = 0;
      const streamer = createMockStreamer({
        chunks: [
          { content: 'First' },
          { content: 'Second' },
          { content: 'Third', finishReason: 'stop' }
        ]
      });

      const abortController = new AbortController();
      const ctx: Context<{}, {}> = {
        stream: streamer as any,
        signal: abortController.signal,
        messages: []
      };

      const events: PromptEvent<string, []>[] = [];

      try {
        for await (const event of prompt.run({}, ctx)) {
          events.push(event);
          chunkCount++;
          if (chunkCount === 2) {
            abortController.abort(); // Abort mid-stream
          }
        }
      } catch (e) {
        // Expected to throw
      }

      // Should have processed some events before abort
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Tool Event Emission in Skip Mode', () => {
    it.skip('should emit tool start events when processing invalid tools', async () => {
      const validTool = new Tool({
        name: 'valid-tool',
        description: 'Valid tool',
        instructions: 'Valid',
        schema: a.object({}),
        call: () => 'valid-result'
      });

      const prompt = new Prompt({
        name: 'emit-start-skip',
        description: 'Emit start skip',
        content: 'Test',
        tools: [validTool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_2', name: 'valid-tool', arguments: '{}' },
              { id: 'call_1', name: 'invalid-tool', arguments: '{}' }, // Will abort
            ]
          },
          {
            content: 'Recovered',
            finishReason: 'stop'
          }
        ]
      });

      const events: PromptEvent<string, [AnyTool]>[] = [];

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      // Should have tool start events
      const startEvents = events.filter(e => e.type === 'toolStart');
      expect(startEvents.length).toBeGreaterThan(0);
    });

    it('should emit tool output events when tools complete in skip mode', async () => {
      const tool = new Tool({
        name: 'output-tool',
        description: 'Output tool',
        instructions: 'Output',
        schema: a.object({}),
        call: () => 'output-result'
      });

      const prompt = new Prompt({
        name: 'emit-output-skip',
        description: 'Emit output skip',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'missing-tool', arguments: '{}' }, // Will error
              { id: 'call_2', name: 'output-tool', arguments: '{}' }
            ]
          },
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_2', name: 'output-tool', arguments: '{}' }
            ]
          },
          {
            content: 'Done',
            finishReason: 'stop'
          }
        ]
      });

      const events: PromptEvent<string, [AnyTool]>[] = [];

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      // Should have tool output events
      const outputEvents = events.filter(e => e.type === 'toolOutput');
      expect(outputEvents.length).toBeGreaterThan(0);
    });

    it('should emit tool error events in skip mode', async () => {
      const errorTool = new Tool({
        name: 'error-tool',
        description: 'Error tool',
        instructions: 'Error',
        schema: a.object({}),
        call: () => {
          throw new Error('Tool failed');
        }
      });

      const prompt = new Prompt({
        name: 'emit-error-skip',
        description: 'Emit error skip',
        content: 'Test',
        tools: [errorTool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'nonexistent', arguments: '{}' }, // Triggers skip
              { id: 'call_2', name: 'error-tool', arguments: '{}' }
            ]
          },
          {
            content: 'Handled',
            finishReason: 'stop'
          }
        ]
      });

      const events: PromptEvent<string, [AnyTool]>[] = [];

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      // Should have tool error events
      const errorEvents = events.filter(e => e.type === 'toolError');
      expect(errorEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Tool Start Event Emission in Sequential Mode', () => {
    it('should emit tool start during sequential execution', async () => {
      const tool = new Tool({
        name: 'seq-tool',
        description: 'Sequential tool',
        instructions: 'Sequential',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value * 2
      });

      const prompt = new Prompt({
        name: 'seq-start-emit',
        description: 'Sequential start emit',
        content: 'Test',
        tools: [tool],
        toolExecution: 'sequential'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'seq-tool', arguments: '{"value":5}' }
            ]
          },
          {
            content: 'Result',
            finishReason: 'stop'
          }
        ]
      });

      const events: PromptEvent<string, [AnyTool]>[] = [];

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      const startEvents = events.filter(e => e.type === 'toolStart');
      expect(startEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Tools Max Disables Tools', () => {
    it('should disable tools when toolsMax limit reached', async () => {
      const tool = new Tool({
        name: 'limited-tool',
        description: 'Limited',
        instructions: 'Limited',
        schema: a.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'tools-max-disable',
        description: 'Tools max disable',
        content: 'Test',
        tools: [tool],
        toolsMax: 1
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'limited-tool', arguments: '{}' }]
          },
          {
            content: 'After max reached',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('After max reached');
    });
  });

  describe('Reconfig Retry Parameter Overrides', () => {
    it('should override outputRetries via reconfig', async () => {
      let reconfigCalled = false;

      const prompt = new Prompt({
        name: 'reconfig-output-retries',
        description: 'Reconfig output retries',
        content: 'Test',
        schema: a.object({ value: a.number() }),
        outputRetries: 1, // Start with 0
        reconfig: (stats) => {
          reconfigCalled = true;
          return {
            outputRetries: 2 // Give it 2 more retries
          };
        }
      });

      const executor = createMockExecutor({
        responses: [
          { content: 'invalid json', finishReason: 'stop' },
          { content: 'still invalid', finishReason: 'stop' },
          { content: '{"value":42}', finishReason: 'stop' }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(reconfigCalled).toBe(true);
      expect(result).toEqual({ value: 42 });
    });

    it.skip('should override forgetRetries via reconfig', async () => {
      let reconfigCalled = false;

      const prompt = new Prompt({
        name: 'reconfig-forget-retries',
        description: 'Reconfig forget retries',
        content: 'Test',
        schema: a.object({ result: a.string() }),
        forgetRetries: 1,
        reconfig: (stats) => {
          reconfigCalled = true;
          return {
            forgetRetries: 0
          };
        }
      });

      const executor = createMockExecutor({
        responses: [{
          content: 'not valid json',
          finishReason: 'stop',
          usage: { text: { input: 5000, output: 0, total: 5000 } },
          model: 'test-model'
        }, {
          content: 'Success',
          finishReason: 'stop',
          model: 'test-model'
        }],
      })

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: [
          { role: 'user', content: 'Test message', tokens: 100 }
        ],
        contextWindow: 2000,
        maxOutputTokens: 500
      };

      const result = await prompt.get('result', {}, ctx);
      expect(reconfigCalled).toBe(true);
      expect(result).toBe('Success');
    });

    it('should override toolRetries and disable tools when set to 0', async () => {
      let reconfigCalled = false;

      const tool = new Tool({
        name: 'retry-tool',
        description: 'Retry tool',
        instructions: 'Retry',
        schema: a.object({}),
        call: () => {
          throw new Error('Tool error');
        }
      });

      const prompt = new Prompt({
        name: 'reconfig-tool-retries',
        description: 'Reconfig tool retries',
        content: 'Test',
        tools: [tool],
        toolRetries: 2,
        reconfig: (stats) => {
          if (stats.toolCallErrors > 0) {
            reconfigCalled = true;
            return {
              toolRetries: 0 // Disable retries
            };
          }
          return {};
        }
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'retry-tool', arguments: '{}' }]
          },
          {
            content: 'Recovered without tools',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(reconfigCalled).toBe(true);
      expect(result).toBe('Recovered without tools');
    });
  });

  describe('Context Window Trimming Fallback', () => {
    it('should return messages unchanged when no token counting available', async () => {
      const prompt = new Prompt({
        name: 'no-token-counting',
        description: 'No token counting',
        content: 'Test'
      });

      let callCount = 0;
      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            // No usage provided
            model: 'test-model'
          } as const;
        }
        return {
          content: 'Done',
          finishReason: 'stop',
          model: 'test-model'
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: [
          { role: 'user', content: 'Message 1' },
          { role: 'assistant', content: 'Response 1' }
        ]
        // No estimateUsage, no contextWindow, no usage
      };

      // Should fail because it can't trim without token info
      await expect(prompt.get('result', {}, ctx)).rejects.toThrow(
        'no token usage was provided'
      );
    });
  });

  describe('Tool Parse Early Return', () => {
    it('should return early from parse when tool status is not ready', async () => {
      const tool = new Tool({
        name: 'early-return-tool',
        description: 'Early return',
        instructions: 'Early return',
        schema: a.object({ value: a.string() }),
        call: (input) => input.value
      });

      const prompt = new Prompt({
        name: 'parse-early-return',
        description: 'Parse early return',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              // First call to non-existent tool sets status to 'error'
              { id: 'call_1', name: 'nonexistent-tool', arguments: '{}' }
            ]
          },
          {
            content: 'Recovered',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor as any,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Recovered');
    });
  });
});
