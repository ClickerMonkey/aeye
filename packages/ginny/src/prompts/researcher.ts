import { z } from 'zod';
import { ai } from '../ai';
import { modelFor } from '../model-selection';
import { webSearch } from '../tools/web-search';
import { webGetPage } from '../tools/web-get-page';
import { ask } from '../tools/ask';

/**
 * Researcher — a sub-agent that answers factual questions by searching the
 * web and reading pages. Iterates over its tools until it has enough
 * information, then returns a structured `{ answer, sources }` result.
 *
 * Only wired into the programmer when `ctx.features.webSearch` is true —
 * without a search provider there's no starting point for research.
 */
export const researcher = ai.prompt({
  name: 'researcher',
  description: 'Answer a factual question by searching the web and reading pages.',
  metadata: modelFor('researcher') as any,
  content: `You are a research assistant. Given a question, use the available web
tools to find an answer, then respond with your finding.

Tools:
- web_search(query, maxResults?) — search the web; returns title/url/content per result.
- web_get_page(url) — fetch plain text from a specific URL (HTML tags stripped).

Workflow:
1. Start with web_search to find relevant pages.
2. Use web_get_page on the most promising URLs to read more detail.
3. Once confident, return { answer, sources: [urls you actually used] }.
4. If the question can't be reliably answered, return a best-effort answer
   plus a note in \`answer\` about what remains uncertain.

Keep answers concise and factual. Cite source URLs.

Question: {{question}}`,
  input: (input: { question: string }) => ({ question: input.question }),
  tools: [webSearch, webGetPage, ask],
  toolIterations: 10,
  schema: z.object({
    answer: z.string().describe('The researched answer, concise and factual.'),
    sources: z.array(z.string()).default([]).describe('URLs actually consulted.'),
  }),
});
