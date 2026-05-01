import { z } from 'zod';
import { tavily } from '@tavily/core';
import { ai } from '../ai';
import { throwIfAborted, withAbortRace } from '../signal-utils';

export const webSearch = ai.tool({
  name: 'web_search',
  description: 'Search the web using Tavily. Returns titles, URLs, and content snippets.',
  instructions: 'Search the web. Returns JSON array of results with title, url, content.',
  schema: z.object({
    query: z.string().describe('Search query'),
    maxResults: z.number().optional().default(5).describe('Max results (default 5)'),
  }),
  call: async (input: { query: string; maxResults?: number }, _refs, ctx) => {
    throwIfAborted(ctx.signal);
    try {
      const client = tavily({ apiKey: process.env['TAVILY_API_KEY']! });
      // Tavily's SDK doesn't expose an AbortSignal — race the request
      // against the abort signal so an ESC during the search unwinds
      // cleanly instead of waiting for the network round-trip.
      const resp = await withAbortRace(
        client.search(input.query, { maxResults: input.maxResults ?? 5 }),
        ctx.signal,
      );
      const results = resp.results ?? resp;
      return JSON.stringify(results);
    } catch (e: unknown) {
      return `Search error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  applicable: (ctx) => !!ctx.features?.webSearch,
});
