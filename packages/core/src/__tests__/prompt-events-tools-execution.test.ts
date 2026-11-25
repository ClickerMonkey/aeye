/**
 * Prompt 100% Coverage Tests
 *
 * Comprehensive tests to achieve 100% coverage of prompt.ts
 */

import { a } from '@aeye/schema';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool } from '../tool';
import { Context, Message } from '../types';
import { withEvents } from '../common';
import { createMockExecutor, createMockStreamer } from './mocks/executor.mock';

describe('Prompt 100% Coverage', () => {
  describe('Custom Runner with Events', () => {
    it('should use custom runner with event tracking in get method', async () => {
      const prompt = new Prompt({
        name: 'runner-events',
        description: 'Runner with events',
        content: 'Test'
      });

      let runnerCalled = false;
      const innerEvents: PromptEvent<any, [AnyTool]>[] = [];

      const streamer = createMockStreamer({
        chunks: [
          { content: 'Hello' },
          { content: ' world', finishReason: 'stop', usage: { text: { input: 5, output: 10, total: 15 } } }
        ],
      });

      const ctx: Context<{}, {}> = {
        stream: streamer,
        runner: withEvents<typeof prompt>({
          // @ts-ignore
          onPromptEvent: (instance, event) => {
            runnerCalled = true;
            // @ts-ignore
            innerEvents.push(event);
          },
        }),
        messages: []
      };

      const outerEvents: PromptEvent<any, any>[] = [];
      for await (const chunk of prompt.run({}, ctx)) {
        outerEvents.push(chunk);
      }

      expect(runnerCalled).toBe(true);
      expect(outerEvents.length).toBeGreaterThan(0);
      expect(innerEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Event Emission in Immediate Tool Mode', () => {
    it('should emit prompt events when onPromptEvent is provided', async () => {
      const tool = new Tool({
        name: 'emitter',
        description: 'Emitter',
        instructions: 'Emit events',
        schema: a.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'with-events',
        description: 'With events',
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
              name: 'emitter',
              arguments: '{}'
            }]
          },
          {
            content: 'Done',
            finishReason: 'stop'
          }
        ]
      });

      const capturedEvents: PromptEvent<any, [AnyTool]>[] = [];

      const ctx: Context<{}, {}> = {
        execute: executor,
        instance: { id: 'test-instance' } as any,
        messages: []
      };

      // Use stream mode with events to trigger event emission
      for await (const event of prompt.get('stream', {}, ctx)) {
        // @ts-ignore
        capturedEvents.push(event);
      }

      // Should have various event types including tool events
      expect(capturedEvents.length).toBeGreaterThan(0);
      const toolEvents = capturedEvents.filter(e => e.type === 'toolOutput' || e.type === 'toolStart');
      expect(toolEvents.length).toBeGreaterThan(0);
    });

    it('should emit tool start, output, and error events in immediate mode', async () => {
      const tool = new Tool({
        name: 'immediate-tool',
        description: 'Immediate tool',
        instructions: 'Immediate',
        schema: a.object({}),
        call: () => 'immediate-result'
      });

      const prompt = new Prompt({
        name: 'immediate-mode',
        description: 'Immediate mode',
        content: 'Test',
        tools: [tool],
        toolExecution: 'immediate'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'immediate-tool',
              arguments: '{}'
            }]
          },
          {
            content: 'Done',
            finishReason: 'stop'
          }
        ]
      });

      const events: PromptEvent<any, [AnyTool]>[] = [];

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      for await (const event of prompt.get('stream', {}, ctx)) {
        // @ts-ignore
        events.push(event);
      }

      // Check for tool start and output events
      const startEvents = events.filter(e => e.type === 'toolStart');
      const outputEvents = events.filter(e => e.type === 'toolOutput');

      expect(startEvents.length).toBeGreaterThan(0);
      expect(outputEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Tool Execution Paths', () => {
    it('should handle sequential tool execution with parsing', async () => {
      const tool1 = new Tool({
        name: 'seq1',
        description: 'Sequential 1',
        instructions: 'Seq 1',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value * 2
      });

      const tool2 = new Tool({
        name: 'seq2',
        description: 'Sequential 2',
        instructions: 'Seq 2',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value + 10
      });

      const prompt = new Prompt({
        name: 'sequential-tools',
        description: 'Sequential tools',
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
              { id: 'call_1', name: 'seq1', arguments: JSON.stringify({ value: 5 }) },
              { id: 'call_2', name: 'seq2', arguments: JSON.stringify({ value: 3 }) }
            ]
          },
          {
            content: 'Results: 10 and 13',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Results: 10 and 13');
    });

    it('should handle parallel/immediate tool execution', async () => {
      const tool1 = new Tool({
        name: 'par1',
        description: 'Parallel 1',
        instructions: 'Par 1',
        schema: a.object({}),
        call: async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return 'result1';
        }
      });

      const tool2 = new Tool({
        name: 'par2',
        description: 'Parallel 2',
        instructions: 'Par 2',
        schema: a.object({}),
        call: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return 'result2';
        }
      });

      const prompt = new Prompt({
        name: 'parallel-tools',
        description: 'Parallel tools',
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
              { id: 'call_1', name: 'par1', arguments: '{}' },
              { id: 'call_2', name: 'par2', arguments: '{}' }
            ]
          },
          {
            content: 'Both done',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Both done');
    });
  });

  describe('Tool Error Handling and Status Tracking', () => {
    it('should track tool parse errors', async () => {
      const tool = new Tool({
        name: 'strict-parser',
        description: 'Strict parser',
        instructions: 'Parse strictly',
        schema: a.object({ required: a.string() }),
        call: (input) => input.required
      });

      const prompt = new Prompt({
        name: 'parse-errors',
        description: 'Parse errors',
        content: 'Test',
        tools: [tool],
        toolsMax: 2,
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'strict-parser',
              arguments: '{"wrong": "field"}' // Will fail parsing
            }]
          },
          {
            content: 'Recovered',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Recovered');
    });

    it('should track tool execution errors', async () => {
      const tool = new Tool({
        name: 'thrower',
        description: 'Throws error',
        instructions: 'Throw',
        schema: a.object({}),
        call: () => {
          throw new Error('Tool execution error');
        }
      });

      const prompt = new Prompt({
        name: 'execution-errors',
        description: 'Execution errors',
        content: 'Test',
        tools: [tool],
        toolsMax: 2,
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'thrower',
              arguments: '{}'
            }]
          },
          {
            content: 'Handled error',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Handled error');
    });

    it('should track successful tool executions', async () => {
      const tool = new Tool({
        name: 'success-tool',
        description: 'Success',
        instructions: 'Success',
        schema: a.object({}),
        call: () => 'success'
      });

      const prompt = new Prompt({
        name: 'success-tracking',
        description: 'Success tracking',
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
              name: 'success-tool',
              arguments: '{}'
            }]
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

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Done');
    });
  });

  describe('Message Handling and Reconfiguration', () => {
    it('should handle messages with no content in tool execution', async () => {
      const tool = new Tool({
        name: 'content-checker',
        description: 'Content checker',
        instructions: 'Check content',
        schema: a.object({}),
        call: () => 'checked'
      });

      const prompt = new Prompt({
        name: 'no-content',
        description: 'No content',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '', // Empty content
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'content-checker',
              arguments: '{}'
            }]
          },
          {
            content: 'Final',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Final');
    });

    it('should handle finishReason stop with no tool calls but with content', async () => {
      const tool = new Tool({
        name: 'unused-tool',
        description: 'Unused',
        instructions: 'Unused',
        schema: a.object({}),
        call: () => 'unused'
      });

      const prompt = new Prompt({
        name: 'stop-with-content',
        description: 'Stop with content',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        response: {
          content: 'Direct answer without tools',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Direct answer without tools');
    });

    it('should handle reconfig that returns updated config', async () => {
      let reconfigCalls = 0;

      const prompt = new Prompt({
        name: 'reconfig-update',
        description: 'Reconfig update',
        content: 'Test',
        schema: a.object({ value: a.number() }),
        reconfig: (stats, ctx) => {
          reconfigCalls++;
          if (reconfigCalls === 1) {
            // Return updated config to continue
            return { maxIterations: 5 };
          }
          // Stop after second call
          return { maxIterations: 0 };
        }
      });

      const executor = createMockExecutor({
        responses: [
          { content: 'not json', finishReason: 'stop' },
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
  });

  describe('Output Validation and Schema Parsing', () => {
    it('should retry when the output fails a schema check', async () => {
      const prompt = new Prompt({
        name: 'validation-error',
        description: 'Validation error',
        content: 'Extract',
        schema: a.object({
          name: a.string(),
          age: a.number().positive()
        }),
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: JSON.stringify({ name: 'Alice', age: -5 }), // Invalid age
            finishReason: 'stop'
          },
          {
            content: JSON.stringify({ name: 'Alice', age: 25 }),
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toEqual({ name: 'Alice', age: 25 });
      // The retry tells the model which value broke which rule.
      const retry = (executor as jest.Mock).mock.calls[1][0].messages as Array<{ role: string; content: unknown }>;
      const corrective = retry.filter(m => m.role === 'user').map(m => String(m.content)).join(' | ');
      expect(corrective).toContain('1 problem in your answer');
      expect(corrective).toMatch(/age: .*(positive|greater than 0)/i);
    });

    it('should handle non-JSON response when schema expected', async () => {
      const prompt = new Prompt({
        name: 'non-json',
        description: 'Non JSON',
        content: 'Extract',
        schema: a.object({ value: a.string() }),
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: 'This is not JSON at all',
            finishReason: 'stop'
          },
          {
            content: '{"value": "proper json"}',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toEqual({ value: 'proper json' });
    });
  });

  describe('Context Window Management and Message Trimming', () => {
    it('should use estimateUsage for messages without token counts', async () => {
      const prompt = new Prompt({
        name: 'estimate-in-forget',
        description: 'Estimate in forget',
        content: 'Test'
      });

      let estimateCalls = 0;
      let callCount = 0;

      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: { input: 3000, output: 0, total: 3000 } },
            model: 'model-xyz',
          } as const;
        }
        return {
          content: 'Success after forget',
          finishReason: 'stop',
          model: 'model-xyz',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'user', content: 'Message without tokens' },
          { role: 'assistant', content: 'Response without tokens' }
        ],
        estimateUsage: (msg: Message) => {
          estimateCalls++;
          const tokens = msg.content.length * 0.25;
          return { text: { input: tokens } };
        },
        maxOutputTokens: 1000
      };

      await prompt.get('result', {}, ctx);
      expect(estimateCalls).toBeGreaterThan(0);
    });

    it('should handle message chunking with token boundaries', async () => {
      const prompt = new Prompt({
        name: 'chunking',
        description: 'Chunking',
        content: 'Test with many messages'
      });

      let callCount = 0;

      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: { input: 2000, output: 0, total: 2000 } },
            model: 'model-abc',
          } as const;
        } 
        return {
          content: 'Trimmed successfully',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'system', content: 'System message', tokens: 50 },
          { role: 'user', content: 'Message 1', tokens: 200 },
          { role: 'assistant', content: 'Response 1', tokens: 200 },
          { role: 'user', content: 'Message 2', tokens: 200 },
          { role: 'assistant', content: 'Response 2', tokens: 200 },
          { role: 'user', content: 'Message 3', tokens: 200 }
        ],
        maxOutputTokens: 500
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Trimmed successfully');
      expect(callCount).toBe(2);
    });

    it('should preserve system messages when trimming', async () => {
      const prompt = new Prompt({
        name: 'preserve-system',
        description: 'Preserve system',
        content: 'Test'
      });

      let callCount = 0;
      let lastRequest: any;

      const executor = jest.fn(async (request) => {
        callCount++;
        lastRequest = request;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: { input: 2000, output: 0, total: 2000 } },
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'Done',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'system', content: 'Important system message', tokens: 100 },
          { role: 'user', content: 'Old message', tokens: 500 },
          { role: 'assistant', content: 'Old response', tokens: 500 },
          { role: 'user', content: 'Recent message', tokens: 100 }
        ],
        maxOutputTokens: 500
      };

      await prompt.get('result', {}, ctx);

      // System message should be preserved
      const systemMessages = lastRequest.messages.filter((m: Message) => m.role === 'system');
      expect(systemMessages.length).toBeGreaterThan(0);
    });

    it('should handle case where no user messages exist', async () => {
      const prompt = new Prompt({
        name: 'no-user-msgs',
        description: 'No user msgs',
        content: 'Test'
      });

      let callCount = 0;

      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: { input: 2000, output: 0, total: 2000 } },
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'Done',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'system', content: 'System only', tokens: 100 }
        ],
        maxOutputTokens: 500
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Done');
    });

    it('should handle system messages in middle of conversation during trimming', async () => {
      const prompt = new Prompt({
        name: 'mid-system',
        description: 'Mid system',
        content: 'Test'
      });

      let callCount = 0;

      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            usage: { text: { input: 2000, output: 0, total: 2000 } },
            model: 'model-abc',
          } as const;
        }
        return {
          content: 'Done',
          finishReason: 'stop',
          model: 'model-abc',
        } as const;
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: [
          { role: 'system', content: 'Initial system', tokens: 100 },
          { role: 'user', content: 'User 1', tokens: 300 },
          { role: 'system', content: 'Mid system', tokens: 100 },
          { role: 'user', content: 'User 2', tokens: 300 }
        ],
        maxOutputTokens: 500
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Done');
    });
  });

  describe('Tool Execution Edge Cases', () => {
    it('should handle tool parse that rejects with error', async () => {
      const tool = new Tool({
        name: 'bad-parser',
        description: 'Bad parser',
        instructions: 'Parse badly',
        schema: a.object({ value: a.string().min(10) }), // Strict validation
        call: (input) => input.value
      });

      const prompt = new Prompt({
        name: 'parse-rejection',
        description: 'Parse rejection',
        content: 'Test',
        tools: [tool],
        toolsMax: 2,
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'bad-parser',
              arguments: '{"value": "short"}' // Too short, will fail validation
            }]
          },
          {
            content: 'Recovered from parse error',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Recovered from parse error');
    });

    it('should handle tool execution that throws', async () => {
      const tool = new Tool({
        name: 'runtime-error',
        description: 'Runtime error',
        instructions: 'Runtime error',
        schema: a.object({}),
        call: () => {
          throw new Error('Runtime execution error');
        }
      });

      const prompt = new Prompt({
        name: 'runtime-error',
        description: 'Runtime error',
        content: 'Test',
        tools: [tool],
        toolsMax: 2,
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'runtime-error',
              arguments: '{}'
            }]
          },
          {
            content: 'Recovered from runtime error',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Recovered from runtime error');
    });
  });
});
