import { z } from 'zod';
import { ai } from '../ai';
import { runSubagent } from '../progress';
import { registerFnAsGlobal } from '../fns-global';
import { MAX_PROGRAMMER_DEPTH } from '../context';

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
  // The engineer's `create_new_fn` recursively spawns another programmer.
  // Past the depth cap, exposing this tool lets the agent loop forever
  // (programmer → engineer → programmer → engineer → ...). Withholding
  // it forces the deepest programmer to author the function inline via
  // write/test/finish, which is what the user actually wants.
  applicable: (ctx) => (ctx.programmerDepth ?? 0) < MAX_PROGRAMMER_DEPTH - 1,
  call: async (input: { description: string }, _refs, ctx) => {
    const { engineer } = await import('../prompts/engineer');
    const result = await runSubagent(
      `engineer: ${input.description}`,
      () => engineer.get('stream', { description: input.description }, ctx),
      ctx.signal,
    );
    if (!result) return 'Engineer returned no result.';

    const { use = [], created = [] } = result;
    const loaded: string[] = [];
    const ghosts: string[] = [];

    for (const name of [...use, ...created]) {
      if (!ctx.loadedFns.has(name)) {
        try {
          const def = ctx.store.readFn(name);
          const type = ctx.registry.parse(def.type);
          ctx.registry.register(type);
          // Wire as a runtime callable so programs can invoke it.
          // Without this the fn is only typed-known, not executable.
          registerFnAsGlobal(ctx.engine, name, type, def.body);
          ctx.loadedFns.add(name);
        } catch {
          // The engineer claimed this function exists but there's no
          // file on disk. This happens when the engineer hallucinates a
          // success in its structured output even though create_new_fn
          // didn't actually write anything (e.g. inner programmer
          // failed). Drop the ghost and surface it so the caller knows
          // not to trust the engineer's claim.
          ghosts.push(name);
          continue;
        }
      }
      try {
        const def = ctx.store.readFn(name);
        const type = ctx.registry.parse(def.type);
        loaded.push(`fn ${name}: ${type.toCode()}`);
      } catch {
        loaded.push(`fn ${name}`);
      }
    }

    if (loaded.length === 0 && ghosts.length === 0) {
      return 'No functions loaded.';
    }
    const parts: string[] = [];
    if (loaded.length > 0) parts.push(loaded.join('\n'));
    if (ghosts.length > 0) {
      parts.push(
        `// Engineer claimed these were created but no file was written: ${ghosts.join(', ')}.\n` +
        `// Treat them as NOT available — write your program inline or retry find_or_create_functions with a clearer description.`,
      );
    }
    return parts.join('\n\n');
  },
});
