import { z } from 'zod';
import { buildSchemas } from '@aeye/gin';
import type { TypeDef } from '@aeye/gin';
import { ai } from '../ai';
import type { FullCtx } from '../context';
import { refreshVarsGlobal } from '../vars-global';

const searchVars = ai.tool({
  name: 'search_vars',
  description: 'Search existing vars by keywords.',
  instructions: 'Search the vars catalog.',
  schema: z.object({
    keywords: z.array(z.string()),
    limit: z.number().optional().default(10),
  }),
  call: async (input: { keywords: string[]; limit?: number }, _refs, ctx: FullCtx) => {
    const results = ctx.store.searchVars({ keywords: input.keywords, limit: input.limit });
    if (results.length === 0) return 'No matching vars found.';
    return results.map((r) => `${r.name}: ${r.summary}`).join('\n');
  },
});

const getVar = ai.tool({
  name: 'get_var',
  description: 'Get the full definition of a var by name.',
  instructions: 'Retrieve full var definition (type, value, docs).',
  schema: z.object({ name: z.string() }),
  call: async (input: { name: string }, _refs, ctx: FullCtx) => {
    try {
      const def = ctx.store.readVar(input.name);
      return JSON.stringify(def, null, 2);
    } catch {
      return `Var '${input.name}' not found.`;
    }
  },
});

const createVar = ai.tool({
  name: 'create_var',
  description: 'Create a new persistent var.',
  instructions: 'Create a typed named var. Provide name, type (TypeDef JSON), value, optional docs.',
  schema: (ctx: FullCtx) => {
    const opts = buildSchemas(ctx.registry);
    return z.object({
      name: z.string().describe('Var name (camelCase)'),
      type: opts.Type as z.ZodType<TypeDef>,
      value: z.unknown(),
      docs: z.string().optional(),
    });
  },
  call: async (
    input: { name: string; type: TypeDef; value: unknown; docs?: string },
    _refs,
    ctx: FullCtx,
  ) => {
    const { name, type: typeDef, value, docs } = input;
    ctx.store.writeVar(name, { type: typeDef, value, docs });
    const type = ctx.registry.parse(typeDef);
    const parsed = type.parse(value);
    ctx.loadedVars.set(name, { type, parsed, docs });
    refreshVarsGlobal(ctx);
    return `Created var '${name}'.`;
  },
});

export const varsManager = ai.prompt({
  name: 'vars_manager',
  description: 'Find or create vars for a program.',
  content: `You are a vars manager. Vars are named typed values persisted to disk.
Find existing vars or create new ones as needed.

Request: {{description}}`,
  input: (input: { description: string }) => ({ description: input.description }),
  tools: [searchVars, getVar, createVar],
  toolIterations: 5,
  schema: z.object({
    use: z.array(z.string()).default([]).describe('Names of existing vars to use'),
    created: z.array(z.string()).default([]).describe('Names of newly created vars'),
  }),
});
