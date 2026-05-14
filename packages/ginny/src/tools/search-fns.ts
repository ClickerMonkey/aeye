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
    + 'Each result is a top-level global — invoke it as `<name>({args})` (a path with the fn name as the first prop step), '
    + 'NOT `fns.<name>({args})`. The `fns.*` namespace is reserved for built-in natives (fetch, llm, log, ask).',
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
    // The Type instance is captured here so we can render the full
    // signature in the result, saving the model a `print_fn` round-
    // trip just to figure out what args to pass.
    const lines: string[] = [
      '# Saved functions',
      '',
      'These are TOP-LEVEL globals — invoke each as `<name>({args})`, NOT `fns.<name>(...)`.',
      'The `fns.*` namespace is reserved for the built-in natives (fetch, llm, log, ask).',
      '',
    ];
    for (const r of results) {
      let signature = '';
      try {
        const typeDef = ctx.store.readFn(r.name);
        const fnType = ctx.registry.parse(typeDef);
        if (!ctx.loadedFns.has(r.name)) {
          ctx.engine.registerGlobal(r.name, { type: fnType, value: null });
          ctx.loadedFns.add(r.name);
        }
        signature = fnType.toCode();
      } catch {
        // Bad/missing file — fall back to the on-disk summary so the
        // listing still surfaces the name as diagnostic.
        signature = '<unparseable>';
      }
      const summary = r.summary ? ` — ${r.summary.replace(`${r.name}: `, '').replace(`${r.name} — `, '').replace(`${r.name}`, '').trim()}` : '';
      lines.push(`- \`${r.name}\`: ${signature}${summary}`);
    }
    return lines.join('\n');
  },
});
