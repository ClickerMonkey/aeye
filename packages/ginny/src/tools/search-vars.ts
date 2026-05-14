import { z } from 'zod';
import { ai } from '../ai';

/**
 * Enumerate / keyword-search the saved-vars catalog on disk
 * (`./vars/*.json`). Companion to `search_fns` for the data side —
 * answers "what `vars.*` are available?" without spawning the dba.
 *
 * Pair with reading `vars.<name>` directly in a program (the runtime
 * makes every saved var available under the `vars` global).
 */
export const searchVars = ai.tool({
  name: 'search_vars',
  description: 'List or keyword-search saved vars in the catalog (./vars/*.json).',
  instructions:
    'Pass an empty `keywords` array to enumerate every saved var (up to `limit`). '
    + 'Pass keywords to score-rank when the catalog grows large. Returns one '
    + 'line per var — `name: <docs or fallback>`. Read a var\'s value via '
    + '`vars.<name>` in a program.',
  schema: z.object({
    keywords: z.array(z.string()).default([]),
    limit: z.number().optional().default(20),
  }),
  call: async (input: { keywords: string[]; limit?: number }, _refs, ctx) => {
    const results = ctx.store.searchVars({ keywords: input.keywords, limit: input.limit });
    if (results.length === 0) {
      return input.keywords.length === 0
        ? 'No saved vars yet. Call `find_or_create_vars` to declare one.'
        : `No vars matched [${input.keywords.join(', ')}].`;
    }
    return results.map((r) => `${r.name}: ${r.summary}`).join('\n');
  },
});
