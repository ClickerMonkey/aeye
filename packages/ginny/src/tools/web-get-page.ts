import { z } from 'zod';
import { ai } from '../ai';

export const webGetPage = ai.tool({
  name: 'web_get_page',
  description: 'Fetch the text content of a web page.',
  instructions: 'Fetch plain text from a URL. Strips HTML tags.',
  schema: z.object({
    url: z.string().describe('URL to fetch'),
  }),
  call: async (input: { url: string }) => {
    try {
      const resp = await globalThis.fetch(input.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GinBot/1.0)' },
      });
      const html = await resp.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      return text.slice(0, 8000);
    } catch (e: unknown) {
      return `Error fetching page: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});
