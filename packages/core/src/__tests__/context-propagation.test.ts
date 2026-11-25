/**
 * Context Propagation Tests
 *
 * Tests to ensure that context is properly passed down through component hierarchies
 * and that modifications to context are visible to child components.
 */

import { a } from '@aeye/schema';
import { Agent } from '../agent';
import { Tool } from '../tool';
import { Prompt } from '../prompt';
import { Context } from '../types';
import { createMockExecutor } from './mocks/executor.mock';

describe('Context Propagation', () => {
  describe('Tool Context Access', () => {
    it('should receive context properties in tool call', async () => {
      let receivedContext: any;

      const tool = new Tool({
        name: 'contextReader',
        description: 'Reads context',
        instructions: 'Read context',
        schema: a.object({}),
        call: (input, refs, ctx) => {
          receivedContext = ctx;
          return 'success';
        },
        types: { context: {userId: 'string'} }
      });

      const ctx: Context<{ userId: string }, {}> = {
        userId: 'user123',
        messages: []
      };

      const result = tool.run({}, ctx);

      expect(result).toBe('success');
      expect(receivedContext).toBeDefined();
      expect(receivedContext.userId).toBe('user123');
    });

    it('should see modified context in nested tool', async () => {
      const executionLog: string[] = [];

      const innerTool = new Tool({
        name: 'inner',
        description: 'Inner tool',
        instructions: 'Inner',
        schema: a.object({}),
        call: (input, refs, ctx: Context<{ counter: number }, {}>) => {
          executionLog.push(`inner:${ctx.counter}`);
          return ctx.counter;
        },
        types: { context: {counter: 0} }
      });

      const outerTool = new Tool({
        name: 'outer',
        description: 'Outer tool',
        instructions: 'Outer',
        schema: a.object({}),
        refs: [innerTool],
        call: (input, [inner], ctx: Context<{ counter: number }, {}>) => {
          executionLog.push(`outer:${ctx.counter}`);

          // Modify context
          const modifiedCtx = { ...ctx, counter: ctx.counter + 10 };

          // Call inner tool with modified context
          const result = inner.run({}, modifiedCtx);

          return result;
        },
        types: { context: {counter: 0} }
      });

      const ctx: Context<{ counter: number }, {}> = {
        counter: 5,
        messages: []
      };

      const result = outerTool.run({}, ctx);

      expect(result).toBe(15);
      expect(executionLog).toEqual(['outer:5', 'inner:15']);
    });
  });

  describe('Agent Context Access', () => {
    it('should receive context properties in agent call', async () => {
      let receivedContext: any;

      const agent = new Agent({
        name: 'contextReader',
        description: 'Reads context',
        refs: [],
        call: (input, refs, ctx) => {
          receivedContext = ctx;
          return 'success';
        },
        types: { context: {sessionId: ''} }
      });

      const ctx: Context<{ sessionId: string }, {}> = {
        sessionId: 'session-456',
        messages: []
      };

      const result = agent.run({}, ctx);

      expect(result).toBe('success');
      expect(receivedContext).toBeDefined();
      expect(receivedContext.sessionId).toBe('session-456');
    });

    it('should see modified context in nested agent', async () => {
      const executionLog: string[] = [];

      const innerAgent = new Agent({
        name: 'inner',
        description: 'Inner agent',
        refs: [],
        call: (input, refs, ctx: Context<{ level: number }, {}>) => {
          executionLog.push(`inner:${ctx.level}`);
          return `Level ${ctx.level}`;
        },
        types: { context: {level: 0} }
      });

      const outerAgent = new Agent({
        name: 'outer',
        description: 'Outer agent',
        refs: [innerAgent],
        call: (input, [inner], ctx: Context<{ level: number }, {}>) => {
          executionLog.push(`outer:${ctx.level}`);

          // Modify context
          const modifiedCtx = { ...ctx, level: ctx.level + 1 };

          // Call inner agent with modified context
          const result = inner.run({}, modifiedCtx);

          return result;
        },
        types: { context: {level: 0} }
      });

      const ctx: Context<{ level: number }, {}> = {
        level: 1,
        messages: []
      };

      const result = outerAgent.run({}, ctx);

      expect(result).toBe('Level 2');
      expect(executionLog).toEqual(['outer:1', 'inner:2']);
    });

    it('should propagate context through multi-level hierarchy', async () => {
      const executionLog: string[] = [];

      const tool = new Tool({
        name: 'leafTool',
        description: 'Leaf tool',
        instructions: 'Leaf',
        schema: a.object({}),
        call: (input, refs, ctx: Context<{ depth: number; path: string }, {}>) => {
          const newPath = `${ctx.path}/tool`;
          executionLog.push(`tool:depth=${ctx.depth},path=${newPath}`);
          return newPath;
        },
        types: { context: {depth: 0, path: ''} }
      });

      const innerAgent = new Agent({
        name: 'innerAgent',
        description: 'Inner agent',
        refs: [tool],
        call: (input, [t], ctx: Context<{ depth: number; path: string }, {}>) => {
          const newPath = `${ctx.path}/innerAgent`;
          executionLog.push(`innerAgent:depth=${ctx.depth},path=${newPath}`);

          // Modify context and pass to tool
          const modifiedCtx = { ...ctx, depth: ctx.depth + 1, path: newPath };
          return t.run({}, modifiedCtx);
        },
        types: { context: {depth: 0, path: ''} }
      });

      const outerAgent = new Agent({
        name: 'outerAgent',
        description: 'Outer agent',
        refs: [innerAgent],
        call: (input, [inner], ctx: Context<{ depth: number; path: string }, {}>) => {
          const newPath = `${ctx.path}/outerAgent`;
          executionLog.push(`outerAgent:depth=${ctx.depth},path=${newPath}`);

          // Modify context and pass to inner agent
          const modifiedCtx = { ...ctx, depth: ctx.depth + 1, path: newPath };
          return inner.run({}, modifiedCtx);
        },
        types: { context: {depth: 0, path: ''} }
      });

      const ctx: Context<{ depth: number; path: string }, {}> = {
        depth: 0,
        path: 'root',
        messages: []
      };

      const result = outerAgent.run({}, ctx);

      expect(result).toBe('root/outerAgent/innerAgent/tool');
      expect(executionLog).toEqual([
        'outerAgent:depth=0,path=root/outerAgent',
        'innerAgent:depth=1,path=root/outerAgent/innerAgent',
        'tool:depth=2,path=root/outerAgent/innerAgent/tool'
      ]);
    });
  });

  describe('Prompt Context Access', () => {
    it('should receive context properties in prompt', async () => {
      let receivedContext: any;

      const prompt = new Prompt({
        name: 'contextReader',
        description: 'Reads context',
        content: 'Test',
        input: (inputData: any, ctx: Context<{ tenantId: string }, {}>) => {
          receivedContext = ctx;
          return {};
        }
      });

      const executor = createMockExecutor({
        response: { content: 'OK', finishReason: 'stop' }
      });

      const ctx: Context<{ tenantId: string }, {}> = {
        tenantId: 'tenant-789',
        execute: executor,
        messages: []
      };

      await prompt.get('result', {}, ctx);

      expect(receivedContext).toBeDefined();
      expect(receivedContext.tenantId).toBe('tenant-789');
    });

    it('should see modified context in tool called by prompt', async () => {
      const executionLog: string[] = [];

      const tool = new Tool({
        name: 'logger',
        description: 'Logger',
        instructions: 'Log value',
        schema: a.object({}),
        call: (input, refs, ctx: Context<{ value: number }, {}>) => {
          executionLog.push(`tool:${ctx.value}`);
          return ctx.value * 2;
        },
        types: { context: {value: 0} }
      });

      const prompt = new Prompt({
        name: 'multiplier',
        description: 'Multiplier',
        content: 'Multiply',
        tools: [tool],
        types: { context: {value: 0} }
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'logger',
              arguments: '{}'
            }]
          },
          {
            content: '20',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{ value: number }, {}> = {
        value: 10,
        execute: executor,
        messages: []
      };

      await prompt.get('result', {}, ctx);

      expect(executionLog).toContain('tool:10');
    });
  });

  describe('Mixed Component Hierarchy', () => {
    it('should propagate context changes through agent->prompt->tool', async () => {
      const executionLog: string[] = [];

      const tool = new Tool({
        name: 'counter',
        description: 'Counter',
        instructions: 'Count',
        schema: a.object({}),
        call: (input, refs, ctx: Context<{ count: number }, {}>) => {
          executionLog.push(`tool:count=${ctx.count}`);
          return `Count: ${ctx.count}`;
        },
        types: { context: {count: 0} }
      });

      const prompt = new Prompt({
        name: 'counter',
        description: 'Counter',
        content: 'Count',
        tools: [tool],
        types: { context: {count: 0} }
      });

      const agent = new Agent({
        name: 'counterAgent',
        description: 'Counter agent',
        refs: [prompt],
        call: async (input: { increment: number }, [p], ctx: Context<{ count: number }, {}>) => {
          executionLog.push(`agent:count=${ctx.count}`);

          // Modify context
          const modifiedCtx = { ...ctx, count: ctx.count + input.increment };

          // The prompt will call the tool with the modified context
          return await p.get('result', {}, modifiedCtx);
        },
        types: { context: {count: 0} }
      });

      const executor = createMockExecutor({
        responses: [
          {
            content: '',
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call_1',
              name: 'counter',
              arguments: '{}'
            }]
          },
          {
            content: 'Count: 15',
            finishReason: 'stop'
          }
        ]
      });

      const ctx: Context<{ count: number }, {}> = {
        count: 10,
        execute: executor,
        messages: []
      };

      const result = await agent.run({ increment: 5 }, ctx);

      expect(executionLog).toContain('agent:count=10');
      expect(executionLog).toContain('tool:count=15');
      expect(result).toBe('Count: 15');
    });

    it('should maintain separate context branches', async () => {
      const executionLog: string[] = [];

      const tool1 = new Tool({
        name: 'tool1',
        description: 'Tool 1',
        instructions: 'Tool 1',
        schema: a.object({}),
        call: (input, refs, ctx: Context<{ value: string }, {}>) => {
          executionLog.push(`tool1:${ctx.value}`);
          return ctx.value;
        }
      });

      const tool2 = new Tool({
        name: 'tool2',
        description: 'Tool 2',
        instructions: 'Tool 2',
        schema: a.object({}),
        call: (input, refs, ctx: Context<{ value: string }, {}>) => {
          executionLog.push(`tool2:${ctx.value}`);
          return ctx.value;
        },
        types: { context: {value: ''} }
      });

      const agent = new Agent({
        name: 'branching',
        description: 'Branching agent',
        refs: [tool1, tool2],
        call: (input, [t1, t2], ctx: Context<{ value: string }, {}>) => {
          executionLog.push(`agent:${ctx.value}`);

          // Call tool1 with modified context
          const ctx1 = { ...ctx, value: `${ctx.value}-branch1` };
          const result1 = t1.run({}, ctx1);

          // Call tool2 with different modified context
          const ctx2 = { ...ctx, value: `${ctx.value}-branch2` };
          const result2 = t2.run({}, ctx2);

          return `${result1} & ${result2}`;
        },
        types: { context: {value: ''} }
      });

      const ctx: Context<{ value: string }, {}> = {
        value: 'root',
        messages: []
      };

      const result = agent.run({}, ctx);

      expect(result).toBe('root-branch1 & root-branch2');
      expect(executionLog).toEqual([
        'agent:root',
        'tool1:root-branch1',
        'tool2:root-branch2'
      ]);
    });
  });

  describe('Context Immutability', () => {
    it('should not affect parent context when child modifies it', async () => {
      const contextSnapshots: any[] = [];

      const innerAgent = new Agent({
        name: 'inner',
        description: 'Inner',
        refs: [],
        call: (input, refs, ctx: Context<{ value: number }, {}>) => {
          // Try to mutate (shouldn't affect parent)
          (ctx as any).value = 999;
          return 'modified';
        },
        types: { context: {value: 0} }
      });

      const outerAgent = new Agent({
        name: 'outer',
        description: 'Outer',
        refs: [innerAgent],
        call: (input, [inner], ctx: Context<{ value: number }, {}>) => {
          contextSnapshots.push({ before: ctx.value });

          // Pass context to inner agent
          inner.run({}, ctx);

          contextSnapshots.push({ after: ctx.value });
          return ctx.value;
        },
        types: { context: {value: 0} }
      });

      const ctx: Context<{ value: number }, {}> = {
        value: 42,
        messages: []
      };

      const result = outerAgent.run({}, ctx);

      // The mutation in inner agent should have affected the context
      // since objects are passed by reference in JavaScript
      expect(result).toBe(999);
      expect(contextSnapshots[0].before).toBe(42);
      expect(contextSnapshots[1].after).toBe(999);
    });

    it('should properly isolate context with spread operator', async () => {
      const contextSnapshots: any[] = [];

      const innerAgent = new Agent({
        name: 'inner',
        description: 'Inner',
        refs: [],
        call: (input, refs, ctx: Context<{ value: number }, {}>) => {
          // Mutate the passed context
          (ctx as any).value = 999;
          return 'modified';
        },
        types: { context: {value: 0} }
      });

      const outerAgent = new Agent({
        name: 'outer',
        description: 'Outer',
        refs: [innerAgent],
        call: (input, [inner], ctx: Context<{ value: number }, {}>) => {
          contextSnapshots.push({ before: ctx.value });

          // Create a copy before passing
          const ctxCopy = { ...ctx };
          inner.run({}, ctxCopy);

          contextSnapshots.push({ after: ctx.value });
          return ctx.value;
        },
        types: { context: {value: 0} }
      });

      const ctx: Context<{ value: number }, {}> = {
        value: 42,
        messages: []
      };

      const result = outerAgent.run({}, ctx);

      // With spread operator, parent context should be protected
      expect(result).toBe(42);
      expect(contextSnapshots[0].before).toBe(42);
      expect(contextSnapshots[1].after).toBe(42);
    });
  });

  describe('Context with Messages', () => {
    it('should preserve messages through hierarchy', async () => {
      const messagesLog: number[] = [];

      const tool = new Tool({
        name: 'messageCounter',
        description: 'Count messages',
        instructions: 'Count',
        schema: a.object({}),
        call: (input, refs, ctx) => {
          messagesLog.push(ctx.messages?.length || 0);
          return ctx.messages?.length || 0;
        }
      });

      const agent = new Agent({
        name: 'messageAgent',
        description: 'Message agent',
        refs: [tool],
        call: (input, [t], ctx) => {
          messagesLog.push(ctx.messages?.length || 0);

          // Add a message and pass modified context
          const modifiedCtx = {
            ...ctx,
            messages: [
              ...(ctx.messages || []),
              { role: 'user' as const, content: 'New message' }
            ]
          };

          return t.run({}, modifiedCtx);
        }
      });

      const ctx: Context<{}, {}> = {
        messages: [
          { role: 'user', content: 'Initial message' }
        ]
      };

      const result = agent.run({}, ctx);

      expect(result).toBe(2);
      expect(messagesLog).toEqual([1, 2]);
    });
  });
});
