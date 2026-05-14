import { z } from 'zod';
import { buildSchemas } from '@aeye/gin';
import type { TypeDef } from '@aeye/gin';
import { ai } from '../ai';
import { modelFor, toolIterationsConfig } from '../model-selection';
import { refreshVarsGlobal } from '../vars-global';
import { ask } from '../tools/ask';

const searchVars = ai.tool({
  name: 'search_vars',
  description: 'Search existing vars by keywords.',
  instructions: 'Search the vars catalog.',
  schema: z.object({
    keywords: z.array(z.string()),
    limit: z.number().optional().default(10),
  }),
  call: async (input: { keywords: string[]; limit?: number }, _refs, ctx) => {
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
  call: async (input: { name: string }, _refs, ctx) => {
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
  schema: (ctx) => {
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
    ctx,
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

export const dba = ai.prompt({
  name: 'dba',
  description: 'Curate the catalog of named typed values (vars.*).',
  metadata: modelFor('dba'),
  content: `You are the dba — keeper of the catalog of named typed values
(\`vars.*\`) persisted to disk. Each entry is a typed datum any gin program
can read from \`vars.<name>\`. Find an existing entry that matches the
request, or create a new one.

When the requested var is a credential or external parameter the user
hasn't supplied yet (API key, secret, account id, base URL, etc.):
- Create the var anyway with a placeholder value of the correct type
  (empty text \`""\`, zero, etc.).
- Put **clear setup instructions** in the var's \`docs\` field telling
  the user EXACTLY where to obtain the value and how to populate it
  — the dashboard URL, the menu path, scopes/permissions needed, any
  format requirements. The docs are how the user knows what to do.

Do not ask the user for these values; create the slot with good docs
so the programmer can return a clear "set vars.X then re-run" message.

Request: {{description}}`,
  input: (input: { description: string }) => ({ description: input.description }),
  tools: [searchVars, getVar, createVar, ask],
  toolIterations: toolIterationsConfig(),
  excludeMessages: true,
  schema: z.object({
    use: z.array(z.string()).default([]).describe('Names of existing vars to use'),
    created: z.array(z.string()).default([]).describe('Names of newly created vars'),
  }),
});
