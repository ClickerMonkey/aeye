import { z } from 'zod';
import { ai } from '../ai';

/**
 * Enumerate / keyword-search the saved-function catalog on disk
 * (`./fns/*.json`). With no keywords supplied, returns every fn up
 * to `limit` — that's how the programmer answers "what fns are
 * available?" without spawning the designer.
 *
 * The store's `searchFns` already does both:
 *   - empty keywords or fewer than `THRESHOLD` (default 20) saved fns
 *     → return everything up to `limit`.
 *   - otherwise → score by keyword match, return top `limit`.
 *
 * Combine with `print_fn(name)` to inspect a specific fn's body.
 */
export const searchFns = ai.tool({
  name: 'search_fns',
  description: 'List or keyword-search saved functions in the catalog (./fns/*.json).',
  instructions:
    'Pass an empty `keywords` array to enumerate every saved fn (up to `limit`). '
    + 'Pass keywords to score-rank when the catalog grows beyond ~20 entries. '
    + 'Returns one line per fn — `name: <one-line summary>`. Use `print_fn(name)` for the full signature + body.',
  schema: z.object({
    keywords: z.array(z.string()).default([]),
    limit: z.number().optional().default(20),
  }),
  call: async (input: { keywords: string[]; limit?: number }, _refs, ctx) => {
    const results = ctx.store.searchFns({ keywords: input.keywords, limit: input.limit });
    if (results.length === 0) {
      return input.keywords.length === 0
        ? 'No saved functions yet. Call `find_or_create_functions` to author one.'
        : `No functions matched [${input.keywords.join(', ')}].`;
    }
    // Surfacing a fn to the model is also a signal it may be used —
    // load each result into the engine's global scope so the model can
    // call it directly without an extra `find_or_create_functions`
    // round-trip. Idempotent: `loadedFns` guards against re-parsing.
    for (const r of results) {
      if (ctx.loadedFns.has(r.name)) continue;
      try {
        const typeDef = ctx.store.readFn(r.name);
        const fnType = ctx.registry.parse(typeDef);
        ctx.engine.registerGlobal(r.name, { type: fnType, value: null });
        ctx.loadedFns.add(r.name);
      } catch {
        // Bad/missing file — skip; the fn won't appear callable but
        // the listing still surfaces its name for diagnostic value.
      }
    }
    return results.map((r) => `${r.name}: ${r.summary}`).join('\n');
  },
});
