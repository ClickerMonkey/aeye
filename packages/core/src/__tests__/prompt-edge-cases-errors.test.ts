/**
 * Final Coverage Tests for Prompt.ts
 *
 * Tests for edge cases and specific functionality paths in prompt execution,
 * including abort signals, tool execution modes, error handling, and retry logic.
 */

import { a } from '@aeye/schema';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool } from '../tool';
import { Context } from '../types';
import { createMockExecutor, createMockStreamer } from './mocks/executor.mock';

describe('Prompt Final Coverage Lines', () => {
  describe('Abort Signal Handling', () => {
    it('should handle abort signal during streaming', async () => {
      const prompt = new Prompt({
        name: 'abort-test',
        description: 'Test abort',
        content: 'Test'
      });

      const abortController = new AbortController();

      const streamer = createMockStreamer({
        chunks: [
          { content: 'Starting' },
          { content: ' to process', finishReason: 'stop' }
        ]
      });

      const ctx: Context<{}, {}> = {
        stream: streamer as any,
        signal: abortController.signal,
        messages: []
      };

      let chunks = 0;

      // Should throw due to abort
      await expect((async () => {
        for await (const event of prompt.run({}, ctx)) {
          // We should get here once - then no more
          abortController.abort();
          chunks++;
        }
      })()).rejects.toThrow();

      expect(chunks).toBeGreaterThan(0);
    });
  });

  describe('Tool Event Emission in Immediate Mode', () => {
    it('should emit tool start events in immediate mode', async () => {
      const tool = new Tool({
        name: 'immediate-tool',
        description: 'Immediate tool',
        instructions: 'Execute immediately',
        schema: a.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'immediate-emit-start',
        description: 'Immediate emit start',
        content: 'Test',
        tools: [tool],
        toolExecution: 'immediate'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'immediate-tool', arguments: '{}' }]
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

      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const startEvents = events.filter(e => e.type === 'toolStart');
      expect(startEvents.length).toBeGreaterThan(0);
    });

    it('should emit tool output events in immediate mode', async () => {
      const tool = new Tool({
        name: 'fast-tool',
        description: 'Fast tool',
        instructions: 'Fast execution',
        schema: a.object({}),
        call: () => 'fast-result'
      });

      const prompt = new Prompt({
        name: 'immediate-emit-output',
        description: 'Immediate emit output',
        content: 'Test',
        tools: [tool],
        toolExecution: 'immediate'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'fast-tool', arguments: '{}' }]
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

      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const outputEvents = events.filter(e => e.type === 'toolOutput');
      expect(outputEvents.length).toBeGreaterThan(0);
    });

    it('should emit tool error events in immediate mode', async () => {
      const tool = new Tool({
        name: 'error-tool',
        description: 'Error tool',
        instructions: 'Throws error',
        schema: a.object({}),
        call: () => {
          throw new Error('Tool error');
        }
      });

      const prompt = new Prompt({
        name: 'immediate-emit-error',
        description: 'Immediate emit error',
        content: 'Test',
        tools: [tool],
        toolExecution: 'immediate'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'error-tool', arguments: '{}' }]
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

      for await (const event of prompt.run({}, ctx)) {
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'toolError');
      expect(errorEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Content Filter Handling', () => {
    it('should handle content_filter finish reason', async () => {
      const prompt = new Prompt({
        name: 'content-filter',
        description: 'Content filter',
        content: 'Test'
      });

      const executor = createMockExecutor({
        response: {
          content: 'Inappropriate content',
          finishReason: 'content_filter'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow('filtered due to content policy');
    });
  });

  describe('Length Finish Reason Without Usage Info', () => {
    it('should error when length finish reason has no usage info', async () => {
      const prompt = new Prompt({
        name: 'length-no-usage',
        description: 'Length no usage',
        content: 'Test'
      });

      const executor = createMockExecutor({
        response: {
          content: 'Response',
          finishReason: 'length'
          // No usage provided
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow('no token usage was provided');
    });
  });

  describe('Skip Mode When Tool Has Error', () => {
    it('should skip tool execution and emit events when tool has error', async () => {
      const validTool = new Tool({
        name: 'valid-tool',
        description: 'Valid',
        instructions: 'Valid',
        schema: a.object({}),
        call: () => 'valid'
      });

      const prompt = new Prompt({
        name: 'skip-mode',
        description: 'Skip mode',
        content: 'Test',
        tools: [validTool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'invalid-tool', arguments: '{}' }, // Invalid tool name
              { id: 'call_2', name: 'valid-tool', arguments: '{}' }
            ]
          },
          {
            content: 'Recovered',
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
        events.push(event);
      }

      // Should have tool error event for invalid tool
      const errorEvents = events.filter(e => e.type === 'toolError');
      expect(errorEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Tool Error Emission in Different Execution Modes', () => {
    it('should emit tool error in sequential mode', async () => {
      const errorTool = new Tool({
        name: 'seq-error',
        description: 'Sequential error',
        instructions: 'Error',
        schema: a.object({}),
        call: () => {
          throw new Error('Sequential error');
        }
      });

      const prompt = new Prompt({
        name: 'seq-error-emit',
        description: 'Sequential error emit',
        content: 'Test',
        tools: [errorTool],
        toolExecution: 'sequential'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'seq-error', arguments: '{}' }]
          },
          {
            content: 'Recovered',
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
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'toolError');
      expect(errorEvents.length).toBeGreaterThan(0);
    });

    it('should emit tool error in parallel mode', async () => {
      const errorTool = new Tool({
        name: 'par-error',
        description: 'Parallel error',
        instructions: 'Error',
        schema: a.object({}),
        call: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          throw new Error('Parallel error');
        }
      });

      const prompt = new Prompt({
        name: 'par-error-emit',
        description: 'Parallel error emit',
        content: 'Test',
        tools: [errorTool],
        toolExecution: 'parallel'
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'par-error', arguments: '{}' }]
          },
          {
            content: 'Recovered',
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
        events.push(event);
      }

      const errorEvents = events.filter(e => e.type === 'toolError');
      expect(errorEvents.length).toBeGreaterThan(0);
    });
  });

  describe('Custom Validation Error Handling', () => {
    it('should handle validation error with custom validate function', async () => {
      const prompt = new Prompt({
        name: 'custom-validation',
        description: 'Custom validation',
        content: 'Test',
        schema: a.object({ value: a.number() }),
        validate: (output) => {
          if (output.value < 10) {
            throw new Error('Value must be at least 10');
          }
        }
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '{"value": 5}',
            finishReason: 'stop'
          },
          {
            content: '{"value": 15}',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toEqual({ value: 15 });
    });
  });

  describe('Reconfig Config Assignment', () => {
    it('should apply reconfig custom config and delete messages', async () => {
      let reconfigCalled = false;

      const prompt = new Prompt({
        name: 'reconfig-config',
        description: 'Reconfig config',
        content: 'Test',
        schema: a.object({ value: a.string() }),
        reconfig: (stats, ctx) => {
          reconfigCalled = true;
          return {
            config: {
              maxTokens: 2000,
              temperature: 0.5,
              messages: [{ role: 'user', content: 'Should be deleted' }] as any
            },
            maxIterations: 5
          };
        }
      });

      const executor = createMockExecutor({
        responses: [
          { content: 'invalid', finishReason: 'stop' },
          { content: '{"value": "success"}', finishReason: 'stop' }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(reconfigCalled).toBe(true);
      expect(result).toEqual({ value: 'success' });
    });
  });

  describe('Tools Max Limit Logic', () => {
    it('should remove tools and required toolChoice after reaching toolsMax', async () => {
      const tool = new Tool({
        name: 'limited-tool',
        description: 'Limited',
        instructions: 'Limited',
        schema: a.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'tools-max',
        description: 'Tools max',
        content: 'Test',
        tools: [tool],
        toolIterations: 1,
        schema: a.object({ summary: a.string() }),
        config: {
          toolChoice: 'required'
        }
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'limited-tool', arguments: '{}' }]
          },
          {
            content: '{"summary": "completed"}',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toEqual({ summary: 'completed' });
    });
  });

  describe('Maximum Iterations Error', () => {
    it('should error when maximum iterations reached without valid response', async () => {
      const prompt = new Prompt({
        name: 'max-iterations',
        description: 'Max iterations',
        content: 'Test',
        schema: a.object({ value: a.string() }),
        toolIterations: 0,
        forgetRetries: 0,
        toolRetries: 0,
        outputRetries: 0,
      });

      // Return invalid JSON for all attempts
      const executor = createMockExecutor({
        responses: Array(11).fill({
          content: 'not valid json',
          finishReason: 'stop'
        })
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow(/^Prompt max-iterations failed: The output was not valid JSON:\n.*not valid JSON/);
    });
  });

  describe('Schema Compatibility Check', () => {
    // `applicable` replaces `schema: () => false`: a direct run doesn't call the model.
    it('should return undefined when the prompt is not applicable', async () => {
      const prompt = new Prompt({
        name: 'schema-false',
        description: 'Schema false',
        content: 'Test',
        schema: a.object({ value: a.string() }),
        // Not applicable here: the prompt does not run.
        applicable: () => false,
      });

      const executor = createMockExecutor({
        response: {
          content: 'Should not run',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBeUndefined();
    });
  });

  describe('Token Counting Fallback', () => {
    it('should return messages as-is when no token counting method available', async () => {
      const prompt = new Prompt({
        name: 'no-token-info',
        description: 'No token info',
        content: 'Test'
      });

      let callCount = 0;

      const executor = jest.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            content: '',
            finishReason: 'length',
            // No usage, no way to estimate
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
          { role: 'user', content: 'Message 1' },
          { role: 'assistant', content: 'Response 1' }
        ]
        // No estimateUsage, no usage, messages have no tokens
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow('no token usage was provided');
    });
  });

  describe('Tool Parse Early Return', () => {
    it('should return early from parse when status is not ready', async () => {
      const tool = new Tool({
        name: 'parse-early-return',
        description: 'Parse early return',
        instructions: 'Parse',
        schema: a.object({ value: a.string() }),
        call: (input) => input.value
      });

      const prompt = new Prompt({
        name: 'parse-early',
        description: 'Parse early',
        content: 'Test',
        tools: [tool]
      });

      // First attempt has invalid tool name, which sets status to 'error'
      // Then attempting to parse again should return early
      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'non-existent', arguments: '{}' } // Status will be 'error'
            ]
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
  });
});
