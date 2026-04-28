import { z } from 'zod';
import { ai } from '../ai';
import { runSubagent } from '../progress';
import { registerFnAsGlobal } from '../fns-global';

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
  call: async (input: { description: string }, _refs, ctx) => {
    const { engineer } = await import('../prompts/engineer');
    const result = await runSubagent(
      `engineer: ${input.description}`,
      () => engineer.get('stream', { description: input.description }, ctx),
      ctx.signal,
    );
    if (!result) return 'Engineer returned no result.';

    const { use = [], created = [] } = result;
    const lines: string[] = [];

    for (const name of [...use, ...created]) {
      if (!ctx.loadedFns.has(name)) {
        try {
          const def = ctx.store.readFn(name);
          const type = ctx.registry.parse(def.type);
          ctx.registry.register(type);
          // Wire as a runtime callable so programs can invoke it.
          // Without this the fn is only typed-known, not executable.
          registerFnAsGlobal(ctx, name, type, def.body);
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
