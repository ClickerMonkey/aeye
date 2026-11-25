import { a } from '@aeye/schema';
import { GinGrammar } from '@aeye/gin';
import type { GrammarCtx } from '../schemas';
import type { TypeDef } from '@aeye/gin';
import { ai } from '../ai';
import { modelFor, toolIterationsConfig } from '../model-selection';
import { ask } from '../tools/ask';

const searchTypes = ai.tool({
  name: 'search_types',
  description: 'Search existing types by keywords.',
  instructions: 'Search the type catalog. Returns name and summary for each match.',
  schema: a.object({
    keywords: a.array(a.string()).describe('Keywords to search for'),
    limit: a.number().default(10),
  }),
  call: async (input, _refs, ctx) => {
    const results = ctx.store.searchTypes({ keywords: input.keywords, limit: input.limit });
    if (results.length === 0) return 'No matching types found.';
    return results.map((r) => `${r.name}: ${r.summary}`).join('\n');
  },
});

const getType = ai.tool({
  name: 'get_type',
  description: 'Get the full definition of a type by name.',
  instructions: 'Retrieve full type code definition by name.',
  schema: a.object({ name: a.string() }),
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
  metadata: modelFor('architect'),
  content: `You are the architect for a gin program — responsible for picking
or designing the gin types a request needs.
Given a description, find existing types or define new ones.

Built-ins: any, void, null, bool, num, text, list<V>, map<K,V>, obj{...props}, optional<T>, fn<args,R>, enum<...>

Use search_types to find existing types, get_type to inspect them.
Respond with valid JSON matching the output schema.

Request: {{description}}`,
  input: (input: { description: string }) => ({ description: input.description }),
  tools: [searchTypes, getType, ask],
  toolIterations: toolIterationsConfig(),
  // Sub-prompt: takes its task via {{description}}, not via inherited
  // messages. Skipping the parent's history avoids dragging in the
  // in-flight tool_calls assistant message that triggered the
  // delegation (which would arrive at the API without its matching
  // tool result and 400 the request).
  excludeMessages: true,
  schema: GinGrammar.result(a.object({
    use: a.array(a.string()).default([]).describe('Names of existing types to use'),
    create: a.array(a.ref('TypeDef')).default([]).describe('New type definitions'),
  })).adapt((ctx: GrammarCtx, _input?: { description: string }) => [ctx.registry]),
});
