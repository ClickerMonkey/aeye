import { z } from 'zod';
import { ai } from '../ai';

export const webSearch = ai.tool({
  name: 'web_search',
  description: 'Search the web using Tavily. Returns titles, URLs, and content snippets.',
  instructions: 'Search the web. Returns JSON array of results with title, url, content.',
  schema: z.object({
    query: z.string().describe('Search query'),
    maxResults: z.number().optional().default(5).describe('Max results (default 5)'),
  }),
  call: async (input: { query: string; maxResults?: number }) => {
    try {
      const { tavily } = await import('@tavily/core');
      const client = tavily({ apiKey: process.env['TAVILY_API_KEY']! });
      const resp = await client.search(
        input.query,
        { maxResults: input.maxResults ?? 5 },
      );
      const results = resp.results ?? resp;
      return JSON.stringify(results);
    } catch (e: unknown) {
      return `Search error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  applicable: (ctx) => !!ctx.features?.webSearch,
});
