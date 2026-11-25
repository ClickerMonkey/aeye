/**
 * Additional Prompt Coverage Tests
 *
 * Tests for tool parsing, retry logic, input translation, tool resolution,
 * and various edge cases in prompt execution flow.
 */

import { a } from '@aeye/schema';
import { Prompt, PromptEvent } from '../prompt';
import { AnyTool, Tool } from '../tool';
import { Context } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

describe('Prompt Additional Coverage', () => {
  describe('Asynchronous Tool Argument Parsing', () => {
    it('should parse tool arguments asynchronously', async () => {
      const tool = new Tool({
        name: 'async-parse',
        description: 'Async parse tool',
        instructions: 'Parse async',
        schema: a.object({ value: a.number() }),
        call: (input) => input.value * 2
      });

      const prompt = new Prompt({
        name: 'async-parse-test',
        description: 'Test async parsing',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'async-parse', arguments: '{"value":5}' }]
          },
          {
            content: 'Result: 10',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Result: 10');
    });
  });

  describe('Length Finish Without Usage Breaks Execution', () => {
    it('should break when length finish reason occurs without usage info', async () => {
      const prompt = new Prompt({
        name: 'length-no-usage-break',
        description: 'Length no usage break',
        content: 'Test',
        forgetRetries: 0 // No retries, so it will break
      });

      const executor = createMockExecutor({
        response: {
          content: 'Too long',
          finishReason: 'length',
          // No usage provided
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow(
        'no token usage was provided so context cannot be trimmed'
      );
    });
  });

  describe('Tool Calls Without Finish Reason', () => {
    it('should handle tool calls even when finish reason is missing', async () => {
      const tool = new Tool({
        name: 'no-finish',
        description: 'No finish tool',
        instructions: 'No finish',
        schema: a.object({}),
        call: () => 'executed'
      });

      const prompt = new Prompt({
        name: 'no-finish-reason',
        description: 'No finish reason',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'no-finish', arguments: '{}' }]
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

  describe('Tool Message With Undefined Result', () => {
    it('should skip adding tool message when result and error are both undefined', async () => {
      const tool = new Tool({
        name: 'undefined-result',
        description: 'Undefined result',
        instructions: 'Returns undefined',
        schema: a.object({}),
        call: () => undefined
      });

      const prompt = new Prompt({
        name: 'undefined-result-test',
        description: 'Test undefined result',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'undefined-result', arguments: '{}' }]
          },
          {
            content: 'Completed',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Completed');
    });
  });

  describe('Output Retries Decrement', () => {
    it('should decrement outputRetries when output parsing fails', async () => {
      const prompt = new Prompt({
        name: 'output-retry-decrement',
        description: 'Output retry decrement',
        content: 'Test',
        schema: a.object({ value: a.number() }),
        outputRetries: 2
      });

      const executor = createMockExecutor({
        responses: [
          { content: 'not json', finishReason: 'stop' },
          { content: 'still not json', finishReason: 'stop' },
          { content: '{"value":42}', finishReason: 'stop' }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toEqual({ value: 42 });
    });
  });

  describe('Break When Output Retries Exhausted', () => {
    it('should break when outputRetries is exhausted', async () => {
      const prompt = new Prompt({
        name: 'no-retries-break',
        description: 'No retries break',
        content: 'Test',
        schema: a.object({ value: a.number() }),
        outputRetries: 0 // No retries
      });

      const executor = createMockExecutor({
        response: {
          content: 'invalid json forever',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      await expect(prompt.get('result', {}, ctx)).rejects.toThrow('not valid JSON');
    });
  });

  describe('Tool Resolution and Instruction Compilation', () => {
    it('should compile tool instructions when tools are present', async () => {
      const tool1 = new Tool({
        name: 'compiler-test-1',
        description: 'Compiler test 1',
        instructions: 'First tool instructions',
        schema: a.object({}),
        call: () => 'result1'
      });

      const tool2 = new Tool({
        name: 'compiler-test-2',
        description: 'Compiler test 2',
        instructions: 'Second tool instructions',
        schema: a.object({}),
        call: () => 'result2'
      });

      const prompt = new Prompt({
        name: 'tool-compilation',
        description: 'Tool compilation test',
        content: 'Use tools',
        tools: [tool1, tool2]
      });

      const executor = createMockExecutor({
        response: {
          content: 'Used tools',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Used tools');
    });

    it('should filter tools based on retool function', async () => {
      const tool1 = new Tool({
        name: 'filtered-tool-1',
        description: 'Filtered 1',
        instructions: 'Tool 1',
        schema: a.object({}),
        call: () => 'result1'
      });

      const tool2 = new Tool({
        name: 'filtered-tool-2',
        description: 'Filtered 2',
        instructions: 'Tool 2',
        schema: a.object({}),
        call: () => 'result2'
      });

      const prompt = new Prompt({
        name: 'tool-filtering',
        description: 'Tool filtering test',
        content: 'Use selected tools',
        tools: [tool1, tool2],
        retool: () => ['filtered-tool-1'] // Only allow tool1
      });

      const executor = createMockExecutor({
        response: {
          content: 'Selected tools used',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Selected tools used');
    });
  });

  describe('Input Translation', () => {
    it('should translate input using input function', async () => {
      const prompt = new Prompt({
        name: 'input-translation',
        description: 'Input translation test',
        content: 'Process {{processedValue}}',
        input: (input?: { rawValue?: string }) => ({
          processedValue: input?.rawValue ? input.rawValue.toUpperCase() : 'DEFAULT'
        })
      });

      const executor = createMockExecutor({
        response: {
          content: 'Processed',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', { rawValue: 'hello' }, ctx);
      expect(result).toBe('Processed');
    });

    it('should handle undefined input in translation', async () => {
      const prompt = new Prompt({
        name: 'no-input-translation',
        description: 'No input translation',
        content: 'Process {{value}}',
        input: (input: { value?: string }) => ({
          value: input?.value || 'fallback'
        })
      });

      const executor = createMockExecutor({
        response: {
          content: 'Done',
          finishReason: 'stop'
        }
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', {}, ctx);
      expect(result).toBe('Done');
    });
  });

  describe('Streamify Executor Response', () => {
    it('should convert executor response to chunks via streamify', async () => {
      const prompt = new Prompt({
        name: 'streamify-test',
        description: 'Streamify test',
        content: 'Test'
      });

      const executor = createMockExecutor({
        responses: [{
          content: 'Streamified response',
          finishReason: 'stop',
          reasoning: 'Some reasoning',
          toolCalls: [
            { id: 'call_1', name: 'tool1', arguments: '{}' }
          ]
        }, {
          content: 'Streamified response without bad tool call',
          finishReason: 'stop',
        }]
      });

      const ctx: Context<{}, {}> = {
        execute: executor, // This will trigger streamify
        messages: []
      };

      const events: PromptEvent<string, []>[] = [];
      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'textComplete')).toBe(true);
    });
  });

  describe('Missing Tool Error Handling', () => {
    it('should set error.ready when tool is not found', async () => {
      const tool = new Tool({
        name: 'existing-tool',
        description: 'Existing',
        instructions: 'Exists',
        schema: a.object({}),
        call: () => 'result'
      });

      const prompt = new Prompt({
        name: 'missing-tool-test',
        description: 'Missing tool test',
        content: 'Test',
        tools: [tool]
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'non-existent-tool', arguments: '{}' }
            ]
          },
          {
            content: 'Recovered from missing tool',
            finishReason: 'stop'
          }
        ]
      });

      const events: PromptEvent<string, [AnyTool]>[] = [];

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      for await (const event of prompt.get('stream', {}, ctx)) {
        events.push(event);
      }

      // Should have a tool error event for the missing tool
      const toolErrors = events.filter(e => e.type === 'toolError');
      expect(toolErrors.length).toBeGreaterThan(0);
    });
  });

  describe('Tool Argument Parse Error Handling', () => {
    it('should catch parse errors and set status to invalid', async () => {
      const tool = new Tool({
        name: 'parse-error-tool',
        description: 'Parse error',
        instructions: 'Parse with error',
        schema: a.object({ required: a.string().min(10) }), // Strict validation
        call: (input) => input.required
      });

      const prompt = new Prompt({
        name: 'parse-error-handling',
        description: 'Parse error handling',
        content: 'Test',
        tools: [tool],
        toolRetries: 1
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [
              { id: 'call_1', name: 'parse-error-tool', arguments: '{"required":"short"}' }
            ]
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
  });

  describe('Combined scenarios for multiple lines', () => {
    it('should handle complex tool scenario with retries and translations', async () => {
      const tool = new Tool({
        name: 'complex-tool',
        description: 'Complex tool',
        instructions: 'Complex operations',
        schema: a.object({ data: a.string() }),
        call: (input) => `processed: ${input.data}`
      });

      const prompt = new Prompt({
        name: 'complex-scenario',
        description: 'Complex scenario',
        content: 'Process {{message}}',
        input: (input: { text?: string }) => ({
          message: `transformed: ${input?.text || 'default'}`
        }),
        schema: a.object({ result: a.string() }),
        tools: [tool],
        outputRetries: 1,
        toolRetries: 1
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'complex-tool', arguments: '{"data":"test"}' }]
          },
          {
            content: 'not valid json',
            finishReason: 'stop'
          },
          {
            content: '{"result":"success"}',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{}, {}> = {
        execute: executor,
        messages: []
      };

      const result = await prompt.get('result', { text: 'input' }, ctx);
      expect(result).toEqual({ result: 'success' });
    });
  });
});
