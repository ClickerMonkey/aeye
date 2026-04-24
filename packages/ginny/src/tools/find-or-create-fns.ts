import { z } from 'zod';
import { ai } from '../ai';
import type { FullCtx } from '../context';

interface EngineerResult {
  use: string[];
  created: string[];
}

export const findOrCreateFunctions = ai.tool({
  name: 'find_or_create_functions',
  description: 'Locate or author reusable functions. Returns their signatures.',
  instructions: 'Delegates to the engineer. Provide a description of what is needed.',
  schema: z.object({
    description: z.string().describe('What functions are needed and why'),
  }),
  call: async (input: { description: string }, _refs, ctx: FullCtx) => {
    const { engineer } = await import('../prompts/engineer');
    const result = (await engineer.get('result', { description: input.description }, ctx)) as
      | EngineerResult
      | undefined;
    if (!result) return 'Engineer returned no result.';

    const { use = [], created = [] } = result;
    const lines: string[] = [];

    for (const name of [...use, ...created]) {
      if (!ctx.loadedFns.has(name)) {
        try {
          const def = ctx.store.readFn(name);
          const type = ctx.registry.parse(def.type);
          ctx.registry.register(type);
          ctx.loadedFns.add(name);
        } catch (e: unknown) {
          lines.push(`// Could not load fn '${name}': ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      }
      try {
        const def = ctx.store.readFn(name);
        const type = ctx.registry.parse(def.type);
        lines.push(`fn ${name}: ${type.toCode()}`);
      } catch {
        lines.push(`fn ${name}`);
      }
    }

    return lines.join('\n') || 'No functions loaded.';
  },
});
