/**
 * Agent Unit Tests
 *
 * Comprehensive tests for the Agent component including:
 * - Component orchestration
 * - Reference handling (tools, prompts, other agents)
 * - Execution with context
 * - Applicability checks
 * - Custom runners
 */

import { a } from '@aeye/schema';
import { Agent } from '../agent';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import { Context } from '../types';

describe('Agent', () => {
  describe('Construction', () => {
    it('should create agent with basic config', () => {
      const agent = new Agent({
        name: 'test',
        description: 'Test agent',
        refs: [],
        call: () => 'result'
      });

      expect(agent.name).toBe('test');
      expect(agent.description).toBe('Test agent');
      expect(agent.kind).toBe('agent');
    });

    it('should store references to components', () => {
      const tool = new Tool({
        name: 'helper',
        description: 'Helper tool',
        instructions: 'Helps with tasks',
        schema: a.object({ input: a.string() }),
        call: (input) => input.input.toUpperCase()
      });

      const agent = new Agent({
        name: 'orchestrator',
        description: 'Orchestrates tools',
        refs: [tool],
        call: () => 'done'
      });

      expect(agent.refs).toHaveLength(1);
      expect(agent.refs[0]).toBe(tool);
    });

    it('should accept multiple component types as refs', () => {
      const tool = new Tool({
        name: 'tool1',
        description: 'Tool',
        instructions: 'Tool instructions',
        schema: a.object({ x: a.number() }),
        call: (input) => input.x * 2
      });

      const prompt = new Prompt({
        name: 'prompt1',
        description: 'Prompt',
        content: 'Test'
      });

      const agent = new Agent({
        name: 'complex',
        description: 'Uses multiple components',
        refs: [tool, prompt],
        call: () => 'result'
      });

      expect(agent.refs).toHaveLength(2);
      expect(agent.refs[0]).toBe(tool);
      expect(agent.refs[1]).toBe(prompt);
    });
  });

  describe('Execution', () => {
    it('should execute with no input', () => {
      const agent = new Agent({
        name: 'simple',
        description: 'Simple agent',
        refs: [],
        call: () => 'executed'
      });

      const result = agent.run();

      expect(result).toBe('executed');
    });

    it('should execute with input', () => {
      const agent = new Agent({
        name: 'processor',
        description: 'Processes input',
        refs: [],
        call: (input: { value: number }) => input.value * 2
      });

      const result = agent.run({ value: 5 });

      expect(result).toBe(10);
    });

    it('should pass context to call function', () => {
      const agent = new Agent({
        name: 'contextual',
        description: 'Uses context',
        refs: [],
        call: (input, refs, ctx: Context<{ userId: string }, {}>) => {
          return `User: ${ctx.userId}`;
        }
      });

      const ctx: Context<{ userId: string }, {}> = {
        userId: 'user123',
        messages: []
      };

      const result = agent.run({}, ctx);

      expect(result).toBe('User: user123');
    });

    it('should provide refs to call function', () => {
      const tool = new Tool({
        name: 'calculator',
        description: 'Calculate',
        instructions: 'Performs calculations',
        schema: a.object({ a: a.number(), b: a.number() }),
        call: (input): number => input.a + input.b
      });

      const agent = new Agent({
        name: 'math',
        description: 'Does math',
        refs: [tool],
        call: (input: { a: number; b: number }, [calc]) => {
          return calc.run({ a: input.a, b: input.b }, {});
        }
      });

      const result = agent.run({ a: 3, b: 4 });

      expect(result).toBe(7);
    });

    it('should handle async execution', async () => {
      const agent = new Agent({
        name: 'async',
        description: 'Async agent',
        refs: [],
        call: async (input: { delay: number }) => {
          await new Promise(resolve => setTimeout(resolve, input.delay));
          return 'done';
        }
      });

      const result = await agent.run({ delay: 10 });

      expect(result).toBe('done');
    });

    it('should orchestrate multiple components', async () => {
      const fetchTool = new Tool({
        name: 'fetch',
        description: 'Fetch data',
        instructions: 'Fetches data from a URL',
        schema: a.object({ url: a.string() }),
        call: async (input) => {
          return { data: `Data from ${input.url}` };
        }
      });

      const processTool = new Tool({
        name: 'process',
        description: 'Process data',
        instructions: 'Processes fetched data',
        schema: a.object({ data: a.string() }),
        call: (input) => {
          return input.data.toUpperCase();
        }
      });

      const agent = new Agent({
        name: 'pipeline',
        description: 'Data pipeline',
        refs: [fetchTool, processTool],
        call: async (input: { url: string }, [fetch, process], ctx) => {
          const fetched = await fetch.run({ url: input.url }, ctx);
          const processed = process.run({ data: fetched.data }, ctx);
          return processed;
        }
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const result = await agent.run({ url: 'https://api.example.com' }, ctx);

      expect(result).toBe('DATA FROM HTTPS://API.EXAMPLE.COM');
    });

    it('should support nested agents', async () => {
      const innerAgent = new Agent({
        name: 'inner',
        description: 'Inner agent',
        refs: [],
        call: (input: { x: number }) => input.x * 2
      });

      const outerAgent = new Agent({
        name: 'outer',
        description: 'Outer agent',
        refs: [innerAgent],
        call: (input: { x: number }, [inner], ctx) => {
          const innerResult = inner.run({ x: input.x }, ctx);
          return innerResult + 10;
        }
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const result = outerAgent.run({ x: 5 }, ctx);

      expect(result).toBe(20); // (5 * 2) + 10
    });
  });

  describe('Custom Runners', () => {
    it('should use custom runner when provided in context', () => {
      const agent = new Agent({
        name: 'tracked',
        description: 'Tracked agent',
        refs: [],
        call: (input: { value: number }) => input.value * 2
      });

      const executionLog: string[] = [];

      const ctx: Context<{}, {}> = {
        messages: [],
        runner: (component, input, ctx, defaultCall) => {
          executionLog.push(`Starting ${component.name}`);
          const result = defaultCall(ctx);
          executionLog.push(`Finished ${component.name}`);
          return result;
        }
      };

      const result = agent.run({ value: 3 }, ctx);

      expect(result).toBe(6);
      expect(executionLog).toEqual([
        'Starting tracked',
        'Finished tracked'
      ]);
    });

    it('should allow runner to modify behavior', () => {
      const agent = new Agent({
        name: 'cacheable',
        description: 'Cacheable agent',
        refs: [],
        call: (input: { compute: boolean }) => {
          return input.compute ? 'computed' : 'not computed';
        }
      });

      const cache = new Map<string, any>();

      const ctx: Context<{}, {}> = {
        messages: [],
        runner: (component, input, ctx, defaultCall) => {
          const key = `${component.name}:${JSON.stringify(input)}`;

          if (cache.has(key)) {
            return cache.get(key);
          }

          const result = defaultCall(ctx);
          cache.set(key, result);
          return result;
        }
      };

      // First call - should compute
      const result1 = agent.run({ compute: true }, ctx);
      expect(result1).toBe('computed');
      expect(cache.size).toBe(1);

      // Second call with same input - should use cache
      const result2 = agent.run({ compute: true }, ctx);
      expect(result2).toBe('computed');
      expect(cache.size).toBe(1); // No new cache entry
    });

    it('should support async runners', async () => {
      const agent = new Agent({
        name: 'logged',
        description: 'Logged agent',
        refs: [],
        call: async (input: { value: string }) => {
          return input.value.toUpperCase();
        }
      });

      const logs: string[] = [];

      const ctx: Context<{}, {}> = {
        messages: [],
        runner: (component, input, ctx, defaultCall) => {
          logs.push('Before execution');
          const result = defaultCall(ctx);
          logs.push('After execution');
          return result;
        }
      };

      const result = await agent.run({ value: 'test' }, ctx);

      expect(result).toBe('TEST');
      expect(logs).toEqual(['Before execution', 'After execution']);
    });
  });

  describe('Applicability', () => {
    it('should be applicable when agent has no refs (self-contained)', async () => {
      const agent = new Agent({
        name: 'self-contained',
        description: 'Self-contained agent',
        refs: [],
        call: () => 'result'
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const applicable = await agent.applicable(ctx);

      expect(applicable).toBe(true);
    });

    it('should be applicable by default when refs are applicable', async () => {
      const tool = new Tool({
        name: 'tool1',
        description: 'Tool',
        instructions: 'Tool instructions',
        schema: a.object({ x: a.number() }),
        call: (input) => input.x
      });

      const agent = new Agent({
        name: 'agent1',
        description: 'Agent',
        refs: [tool],
        call: () => 'result'
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const applicable = await agent.applicable(ctx);

      expect(applicable).toBe(true);
    });

    it('should be inapplicable when all refs are inapplicable', async () => {
      const tool = new Tool({
        name: 'tool1',
        description: 'Tool',
        instructions: 'Tool instructions',
        schema: a.object({ x: a.number() }),
        call: (input) => input.x,
        applicable: () => false
      });

      const agent = new Agent({
        name: 'agent1',
        description: 'Agent',
        refs: [tool],
        call: () => 'result'
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const applicable = await agent.applicable(ctx);

      expect(applicable).toBe(false);
    });

    it('should be applicable if at least one ref is applicable', async () => {
      const tool1 = new Tool({
        name: 'tool1',
        description: 'Tool 1',
        instructions: 'Tool 1 instructions',
        schema: a.object({ x: a.number() }),
        call: (input) => input.x,
        applicable: () => false
      });

      const tool2 = new Tool({
        name: 'tool2',
        description: 'Tool 2',
        instructions: 'Tool 2 instructions',
        schema: a.object({ x: a.number() }),
        call: (input) => input.x,
        applicable: () => true
      });

      const agent = new Agent({
        name: 'agent1',
        description: 'Agent',
        refs: [tool1, tool2],
        call: () => 'result'
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const applicable = await agent.applicable(ctx);

      expect(applicable).toBe(true);
    });

    it('should use custom applicability function when provided', async () => {
      const agent = new Agent({
        name: 'conditional',
        description: 'Conditional agent',
        refs: [],
        call: () => 'result',
        applicable: (ctx: Context<{ authorized: boolean }, {}>) => {
          return ctx.authorized === true;
        }
      });

      const authorizedCtx: Context<{ authorized: boolean }, {}> = {
        authorized: true,
        messages: []
      };

      const unauthorizedCtx: Context<{ authorized: boolean }, {}> = {
        authorized: false,
        messages: []
      };

      expect(await agent.applicable(authorizedCtx)).toBe(true);
      expect(await agent.applicable(unauthorizedCtx)).toBe(false);
    });

    it('should support async applicability checks', async () => {
      const agent = new Agent({
        name: 'asyncCheck',
        description: 'Async check',
        refs: [],
        call: () => 'result',
        applicable: async (ctx: Context<{ userId: string }, {}>) => {
          // Simulate async permission check
          await new Promise(resolve => setTimeout(resolve, 10));
          return ctx.userId === 'admin';
        }
      });

      const adminCtx: Context<{ userId: string }, {}> = {
        userId: 'admin',
        messages: []
      };

      const userCtx: Context<{ userId: string }, {}> = {
        userId: 'user',
        messages: []
      };

      expect(await agent.applicable(adminCtx)).toBe(true);
      expect(await agent.applicable(userCtx)).toBe(false);
    });
  });

  describe('Complex Scenarios', () => {
    it('should build a research pipeline', async () => {
      // Tool to fetch data
      const fetchTool = new Tool({
        name: 'fetch',
        description: 'Fetch data',
        instructions: 'Fetches data about a given topic',
        schema: a.object({ topic: a.string() }),
        call: async (input) => {
          return {
            articles: [
              `Article about ${input.topic} #1`,
              `Article about ${input.topic} #2`
            ]
          };
        }
      });

      // Tool to summarize
      const summarizeTool = new Tool({
        name: 'summarize',
        description: 'Summarize',
        instructions: 'Summarizes text to key points',
        schema: a.object({ text: a.string() }),
        call: (input) => {
          return input.text.substring(0, 20) + '...';
        }
      });

      // Agent to orchestrate research
      const researchAgent = new Agent({
        name: 'researcher',
        description: 'Conducts research',
        refs: [fetchTool, summarizeTool],
        call: async (input: { topic: string }, [fetch, summarize], ctx) => {
          const data = await fetch.run({ topic: input.topic }, ctx);
          const summaries = data.articles.map((article: string) =>
            summarize.run({ text: article }, ctx)
          );
          return {
            topic: input.topic,
            summaries
          };
        }
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const result = await researchAgent.run({ topic: 'AI' }, ctx);

      expect(result.topic).toBe('AI');
      expect(result.summaries).toHaveLength(2);
      expect(result.summaries[0]).toContain('AI');
    });

    it('should handle errors in component execution', () => {
      const errorTool = new Tool({
        name: 'error',
        description: 'Throws error',
        instructions: 'Always fails when called',
        schema: a.object({}),
        call: () => {
          throw new Error('Tool failed');
        }
      });

      const agent = new Agent({
        name: 'errorHandler',
        description: 'Handles errors',
        refs: [errorTool],
        call: (input, [tool], ctx) => {
          try {
            return tool.run({}, ctx);
          } catch (error) {
            return `Error: ${(error as Error).message}`;
          }
        }
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const result = agent.run({}, ctx);

      expect(result).toBe('Error: Tool failed');
    });

    it('should compose agents for multi-stage processing', async () => {
      // Stage 1: Data collection
      const collectorAgent = new Agent({
        name: 'collector',
        description: 'Collects data',
        refs: [],
        call: async (input: { source: string }) => {
          return { data: `Data from ${input.source}`, count: 100 };
        }
      });

      // Stage 2: Data analysis
      const analyzerAgent = new Agent({
        name: 'analyzer',
        description: 'Analyzes data',
        refs: [],
        call: (input: { data: string; count: number }) => {
          return {
            summary: `Analyzed ${input.count} items`,
            insight: input.data.toUpperCase()
          };
        }
      });

      // Stage 3: Report generation
      const reporterAgent = new Agent({
        name: 'reporter',
        description: 'Generates report',
        refs: [collectorAgent, analyzerAgent],
        call: async (input: { source: string }, [collector, analyzer], ctx) => {
          const collected = await collector.run({ source: input.source }, ctx);
          const analyzed = analyzer.run(collected, ctx);
          return {
            report: `Report: ${analyzed.summary} - ${analyzed.insight}`
          };
        }
      });

      const ctx: Context<{}, {}> = {
        messages: []
      };

      const result = await reporterAgent.run({ source: 'API' }, ctx);

      expect(result.report).toContain('Analyzed 100 items');
      expect(result.report).toContain('DATA FROM API');
    });
  });

  describe('Edge Cases', () => {
    it('should handle agent with no refs', () => {
      const agent = new Agent({
        name: 'standalone',
        description: 'Standalone',
        refs: [],
        call: () => 'independent'
      });

      const result = agent.run();

      expect(result).toBe('independent');
    });

    it('should handle undefined input gracefully', () => {
      const agent = new Agent({
        name: 'flexible',
        description: 'Flexible',
        refs: [],
        call: (input: { value?: number }) => {
          return input.value || 0;
        }
      });

      const result = agent.run({});

      expect(result).toBe(0);
    });

    it('should handle empty context', () => {
      const agent = new Agent({
        name: 'minimal',
        description: 'Minimal',
        refs: [],
        call: () => 'works'
      });

      const result = agent.run({}, {} as Context<{}, {}>);

      expect(result).toBe('works');
    });
  });
});
