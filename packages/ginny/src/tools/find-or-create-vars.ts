import { z } from 'zod';
import { ai } from '../ai';
import type { FullCtx } from '../context';
import { loadVarInto, refreshVarsGlobal } from '../vars-global';

interface DbaResult {
  use: string[];
  created: string[];
}

export const findOrCreateVars = ai.tool({
  name: 'find_or_create_vars',
  description: 'Locate or create named typed vars. Returns their type signatures.',
  instructions: 'Delegates to the dba. Provide a description of the vars needed.',
  schema: z.object({
    description: z.string().describe('What vars are needed and why'),
  }),
  call: async (input: { description: string }, _refs, ctx: FullCtx) => {
    const { dba } = await import('../prompts/dba');
    const result = (await dba.get('result', { description: input.description }, ctx)) as
      | DbaResult
      | undefined;
    if (!result) return 'DBA returned no result.';

    const { use = [], created = [] } = result;
    const lines: string[] = [];

    for (const name of [...use, ...created]) {
      if (!ctx.loadedVars.has(name)) {
        try {
          loadVarInto(ctx, name);
        } catch (e: unknown) {
          lines.push(`// Could not load var '${name}': ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
      }
      const entry = ctx.loadedVars.get(name);
      if (entry) {
        lines.push(`var ${name}: ${entry.type.toCode()}${entry.docs ? ` // ${entry.docs}` : ''}`);
      }
    }

    refreshVarsGlobal(ctx);
    return lines.join('\n') || 'No vars loaded.';
  },
});
