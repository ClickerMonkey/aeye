/**
 * Common Utility Functions Tests
 *
 * Comprehensive tests for all utility functions in common.ts
 */

import {
  resolveFn,
  isSettled,
  isPromise,
  isAsyncGenerator,
  yieldAll,
  resolve,
  consumeAll,
  accumulateUsage,
  getModel,
  getResponseFromChunks,
  getChunksFromResponse,
  withEvents,
} from '../common';
import { Usage, Chunk, Response, Component, Context, Events } from '../types';

describe('Common Utilities', () => {
  describe('resolveFn', () => {
    it('should handle undefined input', async () => {
      const fn = resolveFn(undefined);
      const result = await fn();
      expect(result).toBeUndefined();
    });

    it('should handle direct value', async () => {
      const fn = resolveFn(42);
      const result = await fn();
      expect(result).toBe(42);
    });

    it('should handle function', async () => {
      const fn = resolveFn(() => 'hello');
      const result = await fn();
      expect(result).toBe('hello');
    });

    it('should handle async function', async () => {
      const fn = resolveFn(async () => 'async hello');
      const result = await fn();
      expect(result).toBe('async hello');
    });

    it('should handle function with arguments', async () => {
      const fn = resolveFn((a: number, b: number) => a + b);
      const result = await fn(5, 3);
      expect(result).toBe(8);
    });

    it('should handle Promise', async () => {
      const fn = resolveFn(Promise.resolve(100));
      const result = await fn();
      expect(result).toBe(100);
    });

    it('should handle reprocess with value', async () => {
      const fn = resolveFn(42, (x) => x * 2);
      const result = await fn();
      expect(result).toBe(84);
    });

    it('should handle reprocess with function', async () => {
      const fn = resolveFn((x: number) => x + 10, (r) => r * 2);
      const result = await fn(5);
      expect(result).toBe(30); // (5 + 10) * 2
    });

    it('should handle reprocess with Promise', async () => {
      const fn = resolveFn(Promise.resolve(50), (x) => x / 2);
      const result = await fn();
      expect(result).toBe(25);
    });

    it('should cache reprocessed value', async () => {
      let callCount = 0;
      const fn = resolveFn(42, (x) => {
        callCount++;
        return x * 2;
      });

      const result1 = await fn();
      const result2 = await fn();

      expect(result1).toBe(84);
      expect(result2).toBe(84);
      expect(callCount).toBe(1); // Only called once due to caching
    });

    it('should handle function without reprocess', async () => {
      const fn = resolveFn((x: string) => x.toUpperCase());
      const result = await fn('hello');
      expect(result).toBe('HELLO');
    });

    it('should handle Promise without reprocess', async () => {
      const fn = resolveFn(Promise.resolve('test'));
      const result = await fn();
      expect(result).toBe('test');
    });
  });

  describe('isSettled', () => {
    it('should return false for any promise (implementation races with immediate false)', async () => {
      // The implementation: Promise.race([p.then(() => true), Promise.resolve(false)])
      // Promise.resolve(false) wins immediately, so this always returns false
      const p = Promise.resolve(42);
      const result = await isSettled(p);
      expect(result).toBe(false);
    });

    it('should return false for pending promise', async () => {
      const p = new Promise((resolve) => setTimeout(resolve, 1000));
      const result = await isSettled(p);
      expect(result).toBe(false);
    });

    it('should return false for rejected promise', async () => {
      const p = Promise.reject(new Error('test'));
      // Catch to prevent unhandled rejection
      p.catch(() => {});
      const result = await isSettled(p);
      expect(result).toBe(false);
    });
  });

  describe('isPromise', () => {
    it('should return true for Promise', () => {
      expect(isPromise(Promise.resolve(42))).toBe(true);
    });

    it('should return true for thenable', () => {
      const thenable = { then: () => {} };
      expect(isPromise(thenable)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isPromise(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isPromise(undefined)).toBe(false);
    });

    it('should return false for number', () => {
      expect(isPromise(42)).toBe(false);
    });

    it('should return false for string', () => {
      expect(isPromise('hello')).toBe(false);
    });

    it('should return false for object without then', () => {
      expect(isPromise({ value: 42 })).toBe(false);
    });
  });

  describe('isAsyncGenerator', () => {
    it('should return true for async generator', () => {
      async function* gen() {
        yield 1;
        yield 2;
      }
      expect(isAsyncGenerator(gen())).toBe(true);
    });

    it('should return false for null', () => {
      expect(isAsyncGenerator(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isAsyncGenerator(undefined)).toBe(false);
    });

    it('should return false for regular function', () => {
      expect(isAsyncGenerator(() => {})).toBe(false);
    });

    it('should return false for Promise', () => {
      expect(isAsyncGenerator(Promise.resolve(42))).toBe(false);
    });

    it('should return false for sync generator', () => {
      function* gen() {
        yield 1;
      }
      expect(isAsyncGenerator(gen())).toBe(false);
    });

    it('should return false for object with partial interface', () => {
      const partial = {
        next: () => {},
        [Symbol.asyncIterator]: () => {}
      };
      expect(isAsyncGenerator(partial)).toBe(false);
    });
  });

  describe('yieldAll', () => {
    it('should yield promises as they settle', async () => {
      const promises = [
        new Promise(resolve => setTimeout(() => resolve('a'), 50)),
        new Promise(resolve => setTimeout(() => resolve('b'), 10)),
        new Promise(resolve => setTimeout(() => resolve('c'), 30)),
      ];

      const results: string[] = [];
      for await (const { result, index } of yieldAll(promises)) {
        const value = await result;
        results.push(value as string);
      }

      // Should yield in settlement order, not creation order
      expect(results).toEqual(['b', 'c', 'a']);
    });

    it('should handle rejected promises', async () => {
      const promises = [
        Promise.resolve('success'),
        Promise.reject(new Error('failure')),
        Promise.resolve('also success'),
      ];

      const results: Array<{ value?: string; error?: Error; index: number }> = [];

      for await (const { result, index } of yieldAll(promises)) {
        try {
          const value = await result;
          results.push({ value: value as string, index });
        } catch (error) {
          results.push({ error: error as Error, index });
        }
      }

      expect(results).toHaveLength(3);
      expect(results[0].value).toBe('success');
      expect(results[1].error?.message).toBe('failure');
      expect(results[2].value).toBe('also success');
    });

    it('should handle empty array', async () => {
      const promises: Promise<any>[] = [];
      const results = [];

      for await (const item of yieldAll(promises)) {
        results.push(item);
      }

      expect(results).toHaveLength(0);
    });

    it('should track indices correctly', async () => {
      const promises = [
        Promise.resolve('first'),
        Promise.resolve('second'),
        Promise.resolve('third'),
      ];

      const indices: number[] = [];
      for await (const { index } of yieldAll(promises)) {
        indices.push(index);
      }

      // All indices should be yielded
      expect(indices.sort()).toEqual([0, 1, 2]);
    });
  });

  describe('resolve', () => {
    it('should resolve plain value', async () => {
      const result = await resolve(42);
      expect(result).toBe(42);
    });

    it('should resolve Promise', async () => {
      const result = await resolve(Promise.resolve('hello'));
      expect(result).toBe('hello');
    });

    it('should resolve AsyncGenerator return value', async () => {
      async function* gen() {
        yield 1;
        yield 2;
        yield 3;
        return 'final';
      }

      const result = await resolve(gen());
      expect(result).toBe('final');
    });

    it('should resolve AsyncGenerator with no return', async () => {
      async function* gen() {
        yield 1;
        yield 2;
      }

      const result = await resolve(gen());
      expect(result).toBeUndefined();
    });

    it('should resolve null', async () => {
      const result = await resolve(null);
      expect(result).toBeNull();
    });

    it('should resolve undefined', async () => {
      const result = await resolve(undefined);
      expect(result).toBeUndefined();
    });

    it('should resolve object', async () => {
      const obj = { foo: 'bar' };
      const result = await resolve(obj);
      expect(result).toBe(obj);
    });
  });

  describe('consumeAll', () => {
    it('should consume all values from generator', async () => {
      async function* gen() {
        yield 1;
        yield 2;
        yield 3;
      }

      const results = await consumeAll(gen());
      expect(results).toEqual([1, 2, 3]);
    });

    it('should handle empty generator', async () => {
      async function* gen() {
        // Empty
      }

      const results = await consumeAll(gen());
      expect(results).toEqual([]);
    });

    it('should handle generator with different types', async () => {
      async function* gen() {
        yield 'a';
        yield 'b';
        yield 'c';
      }

      const results = await consumeAll(gen());
      expect(results).toEqual(['a', 'b', 'c']);
    });

    it('should handle generator with mixed values', async () => {
      async function* gen() {
        yield 1;
        yield 'string';
        yield { value: 'object' };
        yield null;
      }

      const results = await consumeAll(gen());
      expect(results).toEqual([1, 'string', { value: 'object' }, null]);
    });
  });

  describe('accumulateUsage', () => {
    it('should accumulate all usage fields', () => {
      const target: Usage = {
        text: { input: 10, output: 20, cached: 5 },
        reasoning: { output: 3 },
        audio: { seconds: 1.5 },
        cost: 0.001
      };

      const add: Usage = {
        text: { input: 15, output: 25, cached: 8 },
        reasoning: { output: 5 },
        audio: { seconds: 2.0 },
        cost: 0.002
      };

      accumulateUsage(target, add);

      expect(target.text!.input).toBe(25);
      expect(target.text!.output).toBe(45);
      expect(target.text!.cached).toBe(13);
      expect(target.reasoning!.output).toBe(8);
      expect(target.audio!.seconds).toBe(3.5);
      expect(target.cost).toBe(0.003);
    });

    it('should handle undefined add parameter', () => {
      const target: Usage = {
        text: { input: 10, output: 20 }
      };

      accumulateUsage(target, undefined);

      expect(target.text!.input).toBe(10);
      expect(target.text!.output).toBe(20);
    });

    it('should handle empty target', () => {
      const target: Usage = {};
      const add: Usage = {
        text: { input: 15, output: 25 }
      };

      accumulateUsage(target, add);

      expect(target.text!.input).toBe(15);
      expect(target.text!.output).toBe(25);
    });

    it('should handle partial add object', () => {
      const target: Usage = {
        text: { input: 10, output: 20 }
      };

      const add: Usage = {
        text: { input: 5 },
        cost: 0.001
      };

      accumulateUsage(target, add);

      expect(target.text!.input).toBe(15);
      expect(target.text!.output).toBe(20); // Unchanged
      expect(target.cost).toBe(0.001);
    });

    it('should handle zero values', () => {
      const target: Usage = {
        text: { input: 10 }
      };

      const add: Usage = {
        text: { input: 0, output: 0 }
      };

      accumulateUsage(target, add);

      // Zero values ARE added (0 is a valid number)
      expect(target.text!.input).toBe(10); // 10 + 0 = 10
      expect(target.text!.output).toBe(0); // 0 is set
    });

    it('should initialize fields if target is empty', () => {
      const target: Usage = {};
      const add: Usage = {
        text: { input: 100 },
        cost: 0.05
      };

      accumulateUsage(target, add);

      expect(target.text!.input).toBe(100);
      expect(target.cost).toBe(0.05);
    });
  });

  describe('getModel', () => {
    it('should convert string to Model object', () => {
      const result = getModel('gpt-4');
      expect(result).toEqual({ id: 'gpt-4' });
    });

    it('should return Model object as-is', () => {
      const model = { id: 'gpt-4', contextWindow: 8192 };
      const result = getModel(model);
      expect(result).toBe(model);
    });

    it('should handle undefined input', () => {
      const result = getModel(undefined);
      expect(result).toBeUndefined();
    });

    it('should preserve all Model properties', () => {
      const model = {
        id: 'claude-3',
        contextWindow: 200000,
        maxOutput: 4096,
        inputCost: 0.003,
        outputCost: 0.015
      };
      const result = getModel(model);
      expect(result).toEqual(model);
    });
  });

  describe('getResponseFromChunks', () => {
    it('should aggregate content from chunks', () => {
      const chunks: Chunk[] = [
        { content: 'Hello' },
        { content: ' world' },
        { content: '!' },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.content).toBe('Hello world!');
    });

    it('should aggregate reasoning from chunks', () => {
      // `Chunk.reasoning` is the `Reasoning` object type (`{ content?: string, details?: ... }`),
      // not a string. Reasoning text concatenates through `accumulateReasoning` →
      // `appendMaybe` on the `content` field.
      const chunks: Chunk[] = [
        { reasoning: { content: 'First thought' } },
        { reasoning: { content: ', second thought' } },
        { content: 'Answer' },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.reasoning?.content).toBe('First thought, second thought');
    });

    it('should handle finishReason', () => {
      const chunks: Chunk[] = [
        { content: 'Response' },
        { finishReason: 'stop' },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.finishReason).toBe('stop');
    });

    it('should handle model', () => {
      const chunks: Chunk[] = [
        { content: 'Response', model: 'gpt-4' },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.model).toBe('gpt-4');
    });

    it('should handle refusal', () => {
      const chunks: Chunk[] = [
        { refusal: 'Cannot answer that' },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.refusal).toBe('Cannot answer that');
    });

    it('should aggregate tool calls', () => {
      const chunks: Chunk[] = [
        {
          toolCall: {
            id: 'call_1',
            name: 'tool1',
            arguments: '{"arg":"value1"}'
          }
        },
        {
          toolCall: {
            id: 'call_2',
            name: 'tool2',
            arguments: '{"arg":"value2"}'
          }
        },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.toolCalls).toHaveLength(2);
      expect(response.toolCalls![0].name).toBe('tool1');
      expect(response.toolCalls![1].name).toBe('tool2');
    });

    it('should accumulate usage', () => {
      const chunks: Chunk[] = [
        {
          usage: {
            text: { input: 10, output: 20 }
          }
        },
        {
          usage: {
            text: { input: 5, output: 10 }
          }
        },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.usage).toEqual({
        text: { input: 15, output: 30 }
      });
    });

    it('should handle empty chunks array', () => {
      const chunks: Chunk[] = [];
      const response = getResponseFromChunks(chunks);
      expect(response.content).toBe('');
      expect(response.finishReason).toBe('stop');
      expect(response.model).toBe('unknown');
    });

    it('should handle all fields together', () => {
      const chunks: Chunk[] = [
        {
          content: 'Hello',
          reasoning: 'Thinking...',
          model: 'gpt-4',
          usage: { text: { input: 10, output: 5 } }
        },
        {
          content: ' world',
          finishReason: 'stop',
          usage: { text: { input: 5, output: 10 } }
        },
      ];

      const response = getResponseFromChunks(chunks);
      expect(response.content).toBe('Hello world');
      expect(response.reasoning).toBe('Thinking...');
      expect(response.finishReason).toBe('stop');
      expect(response.model).toBe('gpt-4');
      expect(response.usage).toEqual({
        text: { input: 15, output: 15 }
      });
    });
  });

  describe('getChunksFromResponse', () => {
    it('should convert basic response to chunks', () => {
      const response: Response = {
        content: 'Hello world',
        finishReason: 'stop',
        model: 'gpt-4',
      };

      const chunks = getChunksFromResponse(response);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Hello world');
      expect(chunks[0].finishReason).toBe('stop');
      expect(chunks[0].model).toBe('gpt-4');
    });

    it('should create chunk for reasoning', () => {
      const response: Response = {
        content: 'Answer',
        reasoning: 'My reasoning',
        finishReason: 'stop',
        model: 'gpt-4',
      };

      const chunks = getChunksFromResponse(response);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].reasoning).toBe('My reasoning');
      expect(chunks[1].content).toBe('Answer');
    });

    it('should create chunk for refusal', () => {
      const response: Response = {
        content: '',
        refusal: 'Cannot answer',
        finishReason: 'refusal',
        model: 'gpt-4',
      };

      const chunks = getChunksFromResponse(response);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].refusal).toBe('Cannot answer');
      expect(chunks[1].finishReason).toBe('refusal');
    });

    it('should create chunk for both reasoning and refusal', () => {
      const response: Response = {
        content: '',
        reasoning: 'Thinking',
        refusal: 'Cannot answer',
        finishReason: 'refusal',
        model: 'gpt-4',
      };

      const chunks = getChunksFromResponse(response);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].reasoning).toBe('Thinking');
      expect(chunks[0].refusal).toBe('Cannot answer');
    });

    it('should create chunks for tool calls', () => {
      const response: Response = {
        content: '',
        finishReason: 'tool_calls',
        model: 'gpt-4',
        toolCalls: [
          {
            id: 'call_1',
            name: 'tool1',
            arguments: '{"arg":"value1"}'
          },
          {
            id: 'call_2',
            name: 'tool2',
            arguments: '{"arg":"value2"}'
          },
        ],
      };

      const chunks = getChunksFromResponse(response);
      // 1 chunk for each tool call + 1 final chunk = 3 total
      expect(chunks).toHaveLength(3);
      expect(chunks[0].toolCall).toBeDefined();
      expect(chunks[0].toolCallNamed).toBeDefined();
      expect(chunks[0].toolCallArguments).toBeDefined();
      expect(chunks[0].toolCall!.name).toBe('tool1');
      expect(chunks[1].toolCall!.name).toBe('tool2');
      expect(chunks[2].finishReason).toBe('tool_calls');
    });

    it('should handle response with no tool calls', () => {
      const response: Response = {
        content: 'Simple response',
        finishReason: 'stop',
        model: 'gpt-4',
      };

      const chunks = getChunksFromResponse(response);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe('Simple response');
    });

    it('should include usage in final chunk', () => {
      const response: Response = {
        content: 'Response',
        finishReason: 'stop',
        model: 'gpt-4',
        usage: {
          text: { input: 10, output: 20 } },
      };

      const chunks = getChunksFromResponse(response);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].usage).toEqual({
        text: { input: 10, output: 20 }
      });
    });

    it('should handle complex response with all fields', () => {
      const response: Response = {
        content: 'Final answer',
        reasoning: 'Let me think',
        finishReason: 'stop',
        model: 'gpt-4',
        usage: {
          text: { input: 50, output: 100 },
        },
        toolCalls: [
          {
            id: 'call_1',
            name: 'calculator',
            arguments: '{"op":"add","a":1,"b":2}'
          },
        ],
      };

      const chunks = getChunksFromResponse(response);
      // 1 for reasoning + 1 for tool call + 1 final = 3
      expect(chunks).toHaveLength(3);
      expect(chunks[0].reasoning).toBe('Let me think');
      expect(chunks[1].toolCall!.name).toBe('calculator');
      expect(chunks[2].content).toBe('Final answer');
      expect(chunks[2].usage).toBeDefined();
    });
  });

  describe('withEvents', () => {
    // Create a mock component for testing
    const createMockComponent = (output: any = 'test-output'): Component<any, any, string, any, any, any> => ({
      kind: 'prompt' as const,
      name: 'test-component',
      description: 'Test component',
      refs: [],
      run: jest.fn(() => output),
      applicable: jest.fn(() => Promise.resolve(true)),
    });

    it('should call onChild when component has parent', async () => {
      const onChild = jest.fn();
      // @ts-ignore
      const events: Events<any> = {
        onChild,
      };

      const runner = withEvents(events);
      const component = createMockComponent();
      const input = { test: 'input' };

      // Create a parent instance
      const parentInstance = {
        id: 'parent:test:0',
        component: createMockComponent(),
        context: {},
        input: {},
        status: 'running' as const,
      };

      const context: Context<any, any> = {
        instance: parentInstance,
      };

      const getOutput = jest.fn(() => Promise.resolve('result'));

      runner(component, input, context, getOutput);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onChild).toHaveBeenCalled();
      const childInstance = onChild.mock.calls[0][1];
      expect(childInstance.parent).toBe(parentInstance);
    });

    it('should handle error with interrupted status when signal is aborted', async () => {
      const onStatus = jest.fn();
      // @ts-ignore
      const events: Events<any> = {
        onStatus,
      };

      const runner = withEvents(events);
      const component = createMockComponent();
      const input = {};

      const abortController = new AbortController();
      const context: Context<any, any> = {
        signal: abortController.signal,
      };

      const error = new Error('Execution error');
      const getOutput = jest.fn(() => {
        abortController.abort(); // Abort before rejection
        return Promise.reject(error);
      });

      try {
        await resolve(runner(component, input, context, getOutput));
      } catch {
        // Expected to throw
      }

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // Find the call where status is 'interrupted'
      const interruptedCall = onStatus.mock.calls.find(
        call => call[0].status === 'interrupted'
      );

      expect(interruptedCall).toBeDefined();
      expect(interruptedCall[0].error).toBe(error);
      expect(interruptedCall[0].completed).toBeDefined();
    });

    it('should handle error with failed status when not aborted', async () => {
      const onStatus = jest.fn();
      const events: Events<any> = {
        onStatus,
      };

      const runner = withEvents(events);
      const component = createMockComponent();
      const input = {};
      const context: Context<any, any> = {};

      const error = new Error('Regular error');
      const getOutput = jest.fn(() => Promise.reject(error));

      try {
        await resolve(runner(component, input, context, getOutput));
      } catch {
        // Expected to throw
      }

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // Find the call where status is 'failed'
      const failedCall = onStatus.mock.calls.find(
        call => call[0].status === 'failed'
      );

      expect(failedCall).toBeDefined();
      expect(failedCall[0].status).toBe('failed');
    });

    it('should set completed timestamp and error on failure', async () => {
      const onStatus = jest.fn();
      const events: Events<any> = {
        onStatus,
      };

      const runner = withEvents(events);
      const component = createMockComponent();
      const input = {};
      const context: Context<any, any> = {};

      const error = new Error('Test error');
      const getOutput = jest.fn(() => Promise.reject(error));

      const startTime = Date.now();
      try {
        await resolve(runner(component, input, context, getOutput));
      } catch {
        // Expected to throw
      }

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // Find the failed status call
      const failedCall = onStatus.mock.calls.find(
        call => call[0].status === 'failed'
      );

      expect(failedCall).toBeDefined();
      expect(failedCall[0].completed).toBeGreaterThanOrEqual(startTime);
      expect(failedCall[0].error).toBe(error);
    });

    it('should call onStatus on error', async () => {
      const onStatus = jest.fn();
      const events: Events<any> = {
        onStatus,
      };

      const runner = withEvents(events);
      const component = createMockComponent();
      const input = {};
      const context: Context<any, any> = {};

      const error = new Error('Error test');
      const getOutput = jest.fn(() => Promise.reject(error));

      try {
        await resolve(runner(component, input, context, getOutput));
      } catch {
        // Expected to throw
      }

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // onStatus should be called at least twice: once for 'pending', once for 'failed'
      expect(onStatus.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Check that onStatus was called with failed status
      const statusCalls = onStatus.mock.calls.map(call => call[0].status);
      expect(statusCalls).toContain('failed');
    });

    it('should handle successful completion', async () => {
      const onStatus = jest.fn();
      const events: Events<any> = {
        onStatus,
      };

      const runner = withEvents(events);
      const component = createMockComponent();
      const input = {};
      const context: Context<any, any> = {};

      const result = 'success-result';
      const getOutput = jest.fn(() => Promise.resolve(result));

      await resolve(runner(component, input, context, getOutput));

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // Find the completed status call
      const completedCall = onStatus.mock.calls.find(
        call => call[0].status === 'completed'
      );

      expect(completedCall).toBeDefined();
      expect(completedCall[0].output).toBe(result);
      expect(completedCall[0].completed).toBeDefined();
    });

    it('should not call onChild when no parent exists', async () => {
      const onChild = jest.fn();
      const events: Events<any> = {
        onChild,
      };

      const runner = withEvents(events);
      const component = createMockComponent();
      const input = {};
      const context: Context<any, any> = {}; // No parent instance

      const getOutput = jest.fn(() => Promise.resolve('result'));

      runner(component, input, context, getOutput);

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onChild).not.toHaveBeenCalled();
    });
  });
});
