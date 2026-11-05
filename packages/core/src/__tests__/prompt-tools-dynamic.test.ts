/**
 * Tests for dynamic functionality in Prompt
 */

import { z } from 'zod';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { Context } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

describe('Prompt dynamic', () => {
  it('should re-resolve prompt at end of each iteration when dynamic is true', async () => {
    let callCount = 0;
    let toolApplicableCalls = 0;

    const conditionalTool = new Tool({
      name: 'conditional-tool',
      description: 'Tool that becomes unavailable after first check',
      instructions: 'Use this tool',
      schema: z.object({ value: z.string() }),
      call: (args) => `Called with: ${args.value}`,
      applicable: async () => {
        toolApplicableCalls++;
        // Only applicable on first check (initial resolve)
        return toolApplicableCalls === 1;
      }
    });

    const alwaysAvailableTool = new Tool({
      name: 'always-tool',
      description: 'Tool that is always available',
      instructions: 'Always available',
      schema: z.object({ value: z.string() }),
      call: (args) => `Always: ${args.value}`,
      applicable: async () => true
    });

    const prompt = new Prompt({
      name: 'dynamic-tools-test',
      description: 'Test dynamic tools',
      content: 'Test',
      tools: [conditionalTool, alwaysAvailableTool],
      dynamic: true
    });

    const executor = jest.fn(async (request) => {
      callCount++;
      
      // First iteration: both tools should be available
      if (callCount === 1) {
        expect(request.tools?.length).toBe(2);
        return {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [{
            id: 'call_1',
            name: 'conditional-tool',
            arguments: '{"value": "test"}'
          }],
          model: 'model-abc',
        };
      }
      
      // Second iteration: only always-tool should be available (conditional-tool becomes unavailable)
      if (callCount === 2) {
        expect(request.tools?.length).toBe(1);
        expect(request.tools?.[0].name).toBe('always-tool');
        return {
          content: 'Done',
          finishReason: 'stop' as const,
          model: 'model-abc',
        };
      }

      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toBe('Done');
    expect(callCount).toBe(2);
    // Should be called at least 2 times (initial + dynamic resolve at end of iteration 1)
    expect(toolApplicableCalls).toBeGreaterThanOrEqual(2);
  });

  it('should not re-resolve when dynamic is false', async () => {
    let callCount = 0;
    let toolApplicableCalls = 0;

    const conditionalTool = new Tool({
      name: 'conditional-tool',
      description: 'Tool with applicable check',
      instructions: 'Use this tool',
      schema: z.object({ value: z.string() }),
      call: (args) => `Called with: ${args.value}`,
      applicable: async () => {
        toolApplicableCalls++;
        return true;
      }
    });

    const prompt = new Prompt({
      name: 'static-tools-test',
      description: 'Test static tools',
      content: 'Test',
      tools: [conditionalTool],
      dynamic: false // Explicitly false
    });

    const executor = jest.fn(async (request) => {
      callCount++;
      
      if (callCount === 1) {
        return {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [{
            id: 'call_1',
            name: 'conditional-tool',
            arguments: '{"value": "test"}'
          }],
          model: 'model-abc',
        };
      }

      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toBe('Done');
    expect(callCount).toBe(2);
    // Should only be called once during initial resolution
    expect(toolApplicableCalls).toBe(1);
  });

  it('should work with retool function and dynamic', async () => {
    let callCount = 0;
    let retoolCalls = 0;

    const tool1 = new Tool({
      name: 'tool1',
      description: 'First tool',
      instructions: 'Tool 1',
      schema: z.object({}),
      call: () => 'result1'
    });

    const tool2 = new Tool({
      name: 'tool2',
      description: 'Second tool',
      instructions: 'Tool 2',
      schema: z.object({}),
      call: () => 'result2'
    });

    const prompt = new Prompt({
      name: 'retool-dynamic-test',
      description: 'Test retool with dynamic',
      content: 'Test',
      tools: [tool1, tool2],
      dynamic: true,
      retool: () => {
        retoolCalls++;
        // First call: return both tools, second call onwards: return only tool2
        return retoolCalls === 1 ? ['tool1', 'tool2'] : ['tool2'];
      }
    });

    const executor = jest.fn(async (request) => {
      callCount++;
      
      if (callCount === 1) {
        expect(request.tools?.length).toBe(2);
        return {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [{
            id: 'call_1',
            name: 'tool1',
            arguments: '{}'
          }],
          model: 'model-abc',
        };
      }
      
      if (callCount === 2) {
        expect(request.tools?.length).toBe(1);
        expect(request.tools?.[0].name).toBe('tool2');
        return {
          content: 'Done',
          finishReason: 'stop' as const,
          model: 'model-abc',
        };
      }

      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toBe('Done');
    expect(retoolCalls).toBeGreaterThanOrEqual(2);
  });

  it('should handle case when all tools become unavailable dynamically', async () => {
    let callCount = 0;
    let applicableCallCount = 0;

    const tool = new Tool({
      name: 'disappearing-tool',
      description: 'Tool that disappears',
      instructions: 'Use this',
      schema: z.object({}),
      call: () => 'result',
      applicable: async () => {
        applicableCallCount++;
        // Only available on first check (initial resolution)
        return applicableCallCount === 1;
      }
    });

    const prompt = new Prompt({
      name: 'disappearing-tools-test',
      description: 'Test tools disappearing',
      content: 'Test',
      tools: [tool],
      dynamic: true
    });

    const executor = jest.fn(async (request) => {
      callCount++;
      
      if (callCount === 1) {
        expect(request.tools?.length).toBe(1);
        return {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [{
            id: 'call_1',
            name: 'disappearing-tool',
            arguments: '{}'
          }],
          model: 'model-abc',
        };
      }
      
      // Second iteration: no tools should be available (empty array or undefined)
      if (callCount === 2) {
        expect(request.tools === undefined || request.tools?.length === 0).toBe(true);
        return {
          content: 'Done',
          finishReason: 'stop' as const,
          model: 'model-abc',
        };
      }

      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toBe('Done');
  });

  it('should check tool applicability during initial resolution', async () => {
    let applicableCalls = 0;

    const tool = new Tool({
      name: 'test-tool',
      description: 'Test tool',
      instructions: 'Test',
      schema: z.object({}),
      call: () => 'result',
      applicable: async () => {
        applicableCalls++;
        return true;
      }
    });

    const prompt = new Prompt({
      name: 'initial-applicable-test',
      description: 'Test initial applicable',
      content: 'Test',
      tools: [tool]
      // dynamic not set, should still check applicable initially
    });

    const executor = jest.fn(async () => ({
      content: 'Done',
      finishReason: 'stop' as const,
      model: 'model-abc',
    }));

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toBe('Done');
    // Should be called once during initial resolution
    expect(applicableCalls).toBe(1);
  });

  it('should filter out non-applicable tools during initial resolution', async () => {
    const applicableTool = new Tool({
      name: 'applicable-tool',
      description: 'Applicable',
      instructions: 'Available',
      schema: z.object({}),
      call: () => 'result',
      applicable: async () => true
    });

    const notApplicableTool = new Tool({
      name: 'not-applicable-tool',
      description: 'Not applicable',
      instructions: 'Not available',
      schema: z.object({}),
      call: () => 'result',
      applicable: async () => false
    });

    const prompt = new Prompt({
      name: 'filter-tools-test',
      description: 'Test filtering',
      content: 'Test',
      tools: [applicableTool, notApplicableTool]
    });

    const executor = jest.fn(async (request) => {
      // Only applicable tool should be in the request
      expect(request.tools?.length).toBe(1);
      expect(request.tools?.[0].name).toBe('applicable-tool');
      
      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toBe('Done');
  });

  it('should dynamically update content when dynamic is true', async () => {
    let callCount = 0;
    let inputCalls = 0;

    const prompt = new Prompt({
      name: 'dynamic-content-test',
      description: 'Test dynamic content',
      content: 'Iteration {{iteration}}',
      input: () => {
        inputCalls++;
        return { iteration: inputCalls };
      },
      dynamic: true
    });

    const executor = jest.fn(async (request) => {
      callCount++;
      
      if (callCount === 1) {
        expect(request.messages[0].content).toContain('Iteration 1');
        return {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [],
          model: 'model-abc',
        };
      }
      
      if (callCount === 2) {
        // Content should have been updated by dynamic resolve
        expect(request.messages[0].content).toContain('Iteration 2');
        return {
          content: 'Done',
          finishReason: 'stop' as const,
          model: 'model-abc',
        };
      }

      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    expect(result).toBe('Done');
    expect(callCount).toBe(2);
    expect(inputCalls).toBeGreaterThanOrEqual(2);
  });

  it('should stop iteration when dynamic resolve returns undefined', async () => {
    let callCount = 0;
    let retoolCalls = 0;

    const tool = new Tool({
      name: 'test-tool',
      description: 'Test',
      instructions: 'Test',
      schema: z.object({}),
      call: () => 'result'
    });

    const prompt = new Prompt({
      name: 'stop-on-undefined-test',
      description: 'Test stopping',
      content: 'Test',
      tools: [tool],
      dynamic: true,
      retool: () => {
        retoolCalls++;
        // Return false on second call to trigger undefined from resolve
        return retoolCalls === 1 ? ['test-tool'] : false;
      }
    });

    const executor = jest.fn(async (request) => {
      callCount++;
      
      if (callCount === 1) {
        return {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [{
            id: 'call_1',
            name: 'test-tool',
            arguments: '{}'
          }],
          model: 'model-abc',
        };
      }

      // Should not reach here since resolve returns undefined
      return {
        content: 'Should not reach',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    // Should throw an error since result is undefined and not toolsOnly
    await expect(prompt.get('result', {}, ctx)).rejects.toThrow();
    expect(callCount).toBe(1); // Should only call executor once
  });

  it('should allow retool to return dynamic tool objects', async () => {
    // Create a predefined tool
    const predefinedTool = new Tool({
      name: 'predefined-tool',
      description: 'A predefined tool',
      instructions: 'Use this predefined tool',
      schema: z.object({ value: z.string() }),
      call: (args) => `Predefined: ${args.value}`
    });

    // Create a dynamic tool that will be returned by retool
    const dynamicTool = new Tool({
      name: 'dynamic-tool',
      description: 'A dynamic tool',
      instructions: 'Use this dynamic tool',
      schema: z.object({ query: z.string() }),
      call: (args) => `Dynamic: ${args.query}`
    });

    const prompt = new Prompt({
      name: 'dynamic-retool-test',
      description: 'Test dynamic tools via retool',
      content: 'Test',
      tools: [predefinedTool],
      retool: () => [dynamicTool], // Return only the dynamic tool
      toolsOnly: true, // Only run tools
      toolsMax: 1 // Stop after one successful tool call
    });

    let toolsReceived: any[] = [];
    const executor = jest.fn(async (request) => {
      toolsReceived = request.tools || [];
      return {
        content: '',
        finishReason: 'tool_calls' as const,
        toolCalls: [{
          id: 'call_1',
          name: 'dynamic-tool',
          arguments: '{"query": "test"}'
        }],
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    // Run the prompt in tools mode
    const toolResults = await prompt.get('tools', {}, ctx);
    
    // Verify the dynamic tool was available
    expect(toolsReceived.length).toBe(1);
    expect(toolsReceived[0].name).toBe('dynamic-tool');
    
    // Verify the tool call worked
    expect(toolResults?.length).toBe(1);
    expect(toolResults?.[0].tool).toBe('dynamic-tool');
    expect(toolResults?.[0].result).toBe('Dynamic: test');
  });

  it('should allow retool to return both predefined tool names and dynamic tool objects', async () => {
    // Create predefined tools
    const predefinedTool1 = new Tool({
      name: 'predefined-1',
      description: 'First predefined tool',
      instructions: 'Use predefined 1',
      schema: z.object({ val: z.string() }),
      call: (args) => `P1: ${args.val}`
    });

    const predefinedTool2 = new Tool({
      name: 'predefined-2',
      description: 'Second predefined tool',
      instructions: 'Use predefined 2',
      schema: z.object({ val: z.string() }),
      call: (args) => `P2: ${args.val}`
    });

    // Create a dynamic tool
    const dynamicTool = new Tool({
      name: 'dynamic-search',
      description: 'Dynamic search tool',
      instructions: 'Use dynamic search',
      schema: z.object({ query: z.string() }),
      call: (args) => `Search: ${args.query}`
    });

    const prompt = new Prompt({
      name: 'mixed-retool-test',
      description: 'Test mixed tool selection',
      content: 'Test',
      tools: [predefinedTool1, predefinedTool2],
      // Return predefined-1 by name and dynamic tool by object
      retool: () => ['predefined-1', dynamicTool]
    });

    let toolsReceived: any[] = [];
    let callCount = 0;

    const executor = jest.fn(async (request) => {
      callCount++;
      toolsReceived = request.tools || [];

      if (callCount === 1) {
        // Should have 2 tools: predefined-1 and dynamic-search
        return {
          content: '',
          finishReason: 'tool_calls' as const,
          toolCalls: [{
            id: 'call_1',
            name: 'dynamic-search',
            arguments: '{"query": "hello"}'
          }],
          model: 'model-abc',
        };
      }

      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    const result = await prompt.get('result', {}, ctx);
    
    // Verify both tools were available
    expect(toolsReceived.length).toBe(2);
    expect(toolsReceived.map(t => t.name).sort()).toEqual(['dynamic-search', 'predefined-1']);
    
    expect(result).toBe('Done');
  });

  it('should check applicability for dynamic tools', async () => {
    let applicableCalls = 0;

    // Create a dynamic tool with applicability check
    const dynamicTool = new Tool({
      name: 'applicable-dynamic',
      description: 'Dynamic tool with applicability',
      instructions: 'Use this',
      schema: z.object({}),
      call: () => 'result',
      applicable: async () => {
        applicableCalls++;
        return true;
      }
    });

    const prompt = new Prompt({
      name: 'applicable-dynamic-test',
      description: 'Test applicability for dynamic tools',
      content: 'Test',
      tools: [],
      retool: () => [dynamicTool]
    });

    const executor = jest.fn(async () => ({
      content: 'Done',
      finishReason: 'stop' as const,
      model: 'model-abc',
    }));

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    await prompt.get('result', {}, ctx);
    
    // The applicable function should have been called for the dynamic tool
    expect(applicableCalls).toBe(1);
  });

  it('should filter out non-applicable dynamic tools', async () => {
    // Create an applicable dynamic tool
    const applicableTool = new Tool({
      name: 'applicable-dynamic',
      description: 'Applicable dynamic tool',
      instructions: 'Use this',
      schema: z.object({}),
      call: () => 'applicable result',
      applicable: async () => true
    });

    // Create a non-applicable dynamic tool
    const notApplicableTool = new Tool({
      name: 'not-applicable-dynamic',
      description: 'Not applicable dynamic tool',
      instructions: 'Should not appear',
      schema: z.object({}),
      call: () => 'should not be called',
      applicable: async () => false
    });

    const prompt = new Prompt({
      name: 'filter-dynamic-test',
      description: 'Test filtering dynamic tools',
      content: 'Test',
      tools: [],
      retool: () => [applicableTool, notApplicableTool]
    });

    let toolsReceived: any[] = [];
    const executor = jest.fn(async (request) => {
      toolsReceived = request.tools || [];
      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    const ctx: Context<{}, {}> = {
      execute: executor,
      messages: []
    };

    await prompt.get('result', {}, ctx);
    
    // Only the applicable dynamic tool should be available
    expect(toolsReceived.length).toBe(1);
    expect(toolsReceived[0].name).toBe('applicable-dynamic');
  });

  it('should support dynamic tool injection for type-based tool selection', async () => {
    // Simulate the use case from the issue:
    // A base "search" type could be satisfied by multiple implementations

    // Create multiple search implementations
    const personSearch = new Tool({
      name: 'person_search',
      description: 'Search for people',
      instructions: 'Use to search for people by name',
      schema: z.object({ query: z.string() }),
      call: (args) => `Found person: ${args.query}`
    });

    const taskSearch = new Tool({
      name: 'task_search',
      description: 'Search for tasks',
      instructions: 'Use to search for tasks by title',
      schema: z.object({ query: z.string() }),
      call: (args) => `Found task: ${args.query}`
    });

    const projectSearch = new Tool({
      name: 'project_search',
      description: 'Search for projects',
      instructions: 'Use to search for projects',
      schema: z.object({ query: z.string() }),
      call: (args) => `Found project: ${args.query}`
    });

    // Create a prompt that dynamically selects search tools based on context
    const prompt = new Prompt({
      name: 'dynamic-search-test',
      description: 'Test dynamic search tool selection',
      content: 'Test',
      tools: [],
      retool: (_, ctx) => {
        // Dynamically select search tools based on context
        // In a real app, this could be based on user permissions, data model, etc.
        const searchTools = [];
        if ((ctx as any).enablePersonSearch) searchTools.push(personSearch);
        if ((ctx as any).enableTaskSearch) searchTools.push(taskSearch);
        if ((ctx as any).enableProjectSearch) searchTools.push(projectSearch);
        return searchTools;
      }
    });

    let toolsReceived: any[] = [];
    const executor = jest.fn(async (request) => {
      toolsReceived = request.tools || [];
      return {
        content: 'Done',
        finishReason: 'stop' as const,
        model: 'model-abc',
      };
    });

    // Context with only person and task search enabled
    const ctx1: Context<{ enablePersonSearch: boolean; enableTaskSearch: boolean; enableProjectSearch: boolean }, {}> = {
      execute: executor,
      messages: [],
      enablePersonSearch: true,
      enableTaskSearch: true,
      enableProjectSearch: false
    };

    await prompt.get('result', {}, ctx1);
    
    expect(toolsReceived.length).toBe(2);
    expect(toolsReceived.map(t => t.name).sort()).toEqual(['person_search', 'task_search']);

    // Context with all search tools enabled
    const ctx2: Context<{ enablePersonSearch: boolean; enableTaskSearch: boolean; enableProjectSearch: boolean }, {}> = {
      execute: executor,
      messages: [],
      enablePersonSearch: true,
      enableTaskSearch: true,
      enableProjectSearch: true
    };

    await prompt.get('result', {}, ctx2);
    
    expect(toolsReceived.length).toBe(3);
    expect(toolsReceived.map(t => t.name).sort()).toEqual(['person_search', 'project_search', 'task_search']);
  });
});

describe('tools that do not compile', () => {
  it('leaves out a tool without instructions and still runs the next one', async () => {
    const hidden = new Tool({ name: 'hidden', description: 'Hidden', schema: z.object({}), call: () => 'never' });
    const shown = new Tool({ name: 'shown', description: 'Shown', instructions: 'Use shown', schema: z.object({}), call: () => 'ran' });
    const prompt = new Prompt({ name: 'pairs', description: 'Pairs', content: 'Use tools.', tools: [hidden, shown] });
    const execute = createMockExecutor({ responses: [
      { content: '', finishReason: 'tool_calls', toolCalls: [{ id: '1', name: 'shown', arguments: '{}' }] },
      { content: 'done' },
    ] });

    const results: string[] = [];
    for await (const event of prompt.get('stream', {}, { execute })) {
      if (event.type === 'toolOutput') {
        results.push(`${event.tool.name}=${event.result}`);
      }
    }

    expect(execute.mock.calls[0][0].tools?.map(t => t.name)).toEqual(['shown']);
    expect(results).toEqual(['shown=ran']);
  });
});
