import { z } from 'zod';
import { ai } from '../ai';
import { designer } from '../prompts/designer';
import { runSubagent } from '../progress';
import { MAX_PROGRAMMER_DEPTH } from '../context';

interface DesignerResult {
  use: string[];
  created: string[];
}

export const findOrCreateFunctions = ai.tool({
  name: 'find_or_create_functions',
  description: 'Locate or author reusable functions. Returns their signatures.',
  instructions: 'Delegates to the designer. Provide a description of what is needed.',
  schema: z.object({
    description: z.string().describe('What functions are needed and why'),
  }),
  // Two reasons to withhold this tool:
  //  1. Past the depth cap, exposing it lets the agent loop forever
  //     (programmer → designer → programmer → designer → ...).
  //  2. When `targetFn` is set, the programmer's job IS to author that
  //     specific fn's body inline — delegating would just respawn a
  //     designer for the SAME description and recurse uncontrolled,
  //     exhausting heap before the depth cap kicks in (each level
  //     allocates fresh tool schemas, conversation messages, etc.).
  // In either case, force write/test/finish on the body directly.
  applicable: (ctx) =>
    !ctx.targetFn && (ctx.programmerDepth ?? 0) < MAX_PROGRAMMER_DEPTH - 1,
  call: async (input: { description: string }, _refs, ctx) => {
    const result = await runSubagent(
      `designer: ${input.description}`,
      () => designer.get('stream', { description: input.description }, ctx),
      ctx.signal,
    );
    if (!result) return 'Designer returned no result.';

    const { use = [], created = [] } = result;
    const loaded: string[] = [];
    const ghosts: string[] = [];

    for (const name of [...use, ...created]) {
      if (!ctx.loadedFns.has(name)) {
        try {
          // Saved fns are TypeDefs whose `call.get` IS the body. Parse
          // and register with `value: null` — gin's path walker handles
          // invocation, args binding, and recurse natively (see
          // `gin/src/path.ts:283-290`). No callable wrapping needed.
          const typeDef = ctx.store.readFn(name);
          const fnType = ctx.registry.parse(typeDef);
          ctx.engine.registerGlobal(name, { type: fnType, value: null });
          ctx.loadedFns.add(name);
        } catch {
          // The designer claimed this function exists but there's no
          // file on disk (or it failed to parse). Drop the ghost and
          // surface it so the caller knows not to trust the claim.
          ghosts.push(name);
          continue;
        }
      }
      try {
        const fnType = ctx.registry.parse(ctx.store.readFn(name));
        loaded.push(`fn ${name}: ${fnType.toCode()}`);
      } catch {
        loaded.push(`fn ${name}`);
      }
    }

    if (loaded.length === 0 && ghosts.length === 0) {
      return [
        '// FAILED: the designer could not create or find any function for that description.',
        '// Likely causes: the inner programmer never reached a passing test for the signature,',
        '// or no existing saved fn matched the keywords.',
        '//',
        '// DO NOT inline-define the function in your draft (no `define myFn = lambda(...)` workaround).',
        '// Instead: respond to the user that the function could not be created, briefly explain why',
        '// it might have failed, and ask them to either (a) clarify the signature, (b) simplify the',
        '// request, or (c) try a different approach. Then stop — do not call write/test.',
      ].join('\n');
    }
    const parts: string[] = [];
    if (loaded.length > 0) parts.push(loaded.join('\n'));
    if (ghosts.length > 0) {
      parts.push(
        `// Designer claimed these were created but no file was written: ${ghosts.join(', ')}.\n` +
        `// Treat them as NOT available — DO NOT inline-define them. Either retry find_or_create_functions\n` +
        `// with a clearer description, or report the failure to the user.`,
      );
    }
    return parts.join('\n\n');
  },
});
