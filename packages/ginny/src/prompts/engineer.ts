import { z } from 'zod';
import { ai } from '../ai';
import { modelFor } from '../model-selection';
import type { FullCtx } from '../context';

const searchFns = ai.tool({
  name: 'search_fns',
  description: 'Search existing functions by keywords.',
  instructions: 'Search the function catalog.',
  schema: z.object({
    keywords: z.array(z.string()),
    limit: z.number().optional().default(10),
  }),
  call: async (input: { keywords: string[]; limit?: number }, _refs, ctx: FullCtx) => {
    const results = ctx.store.searchFns({ keywords: input.keywords, limit: input.limit });
    if (results.length === 0) return 'No matching functions found.';
    return results.map((r) => `${r.name}: ${r.summary}`).join('\n');
  },
});

const getFn = ai.tool({
  name: 'get_fn',
  description: 'Get the full signature of a function by name.',
  instructions: 'Retrieve function signature by name.',
  schema: z.object({ name: z.string() }),
  call: async (input: { name: string }, _refs, ctx: FullCtx) => {
    try {
      const def = ctx.store.readFn(input.name);
      const type = ctx.registry.parse(def.type);
      return `${input.name}: ${type.toCode()}`;
    } catch {
      return `Function '${input.name}' not found.`;
    }
  },
});

const createNewFn = ai.tool({
  name: 'create_new_fn',
  description: 'Spin up a programmer to implement a new function and persist it.',
  instructions: 'Create a new reusable function by recursively invoking the programmer.',
  schema: z.object({
    name: z.string().describe('Unique function name'),
    description: z.string().describe('What the function should do'),
  }),
  call: async (input: { name: string; description: string }, _refs, ctx: FullCtx) => {
    const { programmer } = await import('./programmer');
    const request = `Create a reusable gin function named '${input.name}': ${input.description}. Write it as a program, test it, and finish.`;
    await programmer.get('result', { request }, ctx);
    return `Function '${input.name}' created.`;
  },
});

export const engineer = ai.prompt({
  name: 'engineer',
  description: 'Design or reuse gin functions — the reusable building blocks of programs.',
  metadata: modelFor('engineer') as any,
  content: `You are the engineer — responsible for designing and curating
reusable gin functions. Find an existing function that matches the
request or spin up a programmer to author a new one.

Request: {{description}}`,
  input: (input: { description: string }) => ({ description: input.description }),
  tools: [searchFns, getFn, createNewFn],
  toolIterations: 8,
  schema: z.object({
    use: z.array(z.string()).default([]).describe('Names of existing functions to use'),
    created: z.array(z.string()).default([]).describe('Names of newly created functions'),
  }),
});
