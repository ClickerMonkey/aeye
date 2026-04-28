import { z } from 'zod';
import { buildSchemas } from '@aeye/gin';
import type { TypeDef } from '@aeye/gin';
import { ai } from '../ai';
import { modelFor } from '../model-selection';
import { ask } from '../tools/ask';

const searchTypes = ai.tool({
  name: 'search_types',
  description: 'Search existing types by keywords.',
  instructions: 'Search the type catalog. Returns name and summary for each match.',
  schema: z.object({
    keywords: z.array(z.string()).describe('Keywords to search for'),
    limit: z.number().optional().default(10),
  }),
  call: async (input: { keywords: string[]; limit?: number }, _refs, ctx) => {
    const results = ctx.store.searchTypes({ keywords: input.keywords, limit: input.limit });
    if (results.length === 0) return 'No matching types found.';
    return results.map((r) => `${r.name}: ${r.summary}`).join('\n');
  },
});

const getType = ai.tool({
  name: 'get_type',
  description: 'Get the full definition of a type by name.',
  instructions: 'Retrieve full type code definition by name.',
  schema: z.object({ name: z.string() }),
  call: async (input: { name: string }, _refs, ctx) => {
    try {
      const def = ctx.store.readType(input.name);
      const type = ctx.registry.parse(def);
      return type.toCodeDefinition();
    } catch {
      return `Type '${input.name}' not found.`;
    }
  },
});

export const architect = ai.prompt({
  name: 'architect',
  description: 'Design or pick gin types that satisfy a shape request.',
  metadata: modelFor('architect') as any,
  content: `You are the architect for a gin program — responsible for picking
or designing the gin types a request needs.
Given a description, find existing types or define new ones.

Built-ins: any, void, null, bool, num, text, list<V>, map<K,V>, obj{...props}, optional<T>, fn<args,R>, enum<...>

Use search_types to find existing types, get_type to inspect them.
Respond with valid JSON matching the output schema.

Request: {{description}}`,
  input: (input: { description: string }) => ({ description: input.description }),
  tools: [searchTypes, getType, ask],
  toolIterations: 5,
  // Sub-prompt: takes its task via {{description}}, not via inherited
  // messages. Skipping the parent's history avoids dragging in the
  // in-flight tool_calls assistant message that triggered the
  // delegation (which would arrive at the API without its matching
  // tool result and 400 the request).
  excludeMessages: true,
  schema: (_input: { description: string } | undefined, ctx) => {
    const opts = buildSchemas(ctx.registry);
    return z.object({
      use: z.array(z.string()).default([]).describe('Names of existing types to use'),
      create: z.array(opts.Type as z.ZodType<TypeDef>).default([]).describe('New type definitions'),
    });
  },
});
