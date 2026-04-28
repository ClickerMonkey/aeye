import { z } from 'zod';
import { ai } from '../ai';
import { runSubagent } from '../progress';

interface ResearchResult {
  answer: string;
  sources?: string[];
}

/**
 * Thin wrapper that delegates the question to the researcher sub-agent and
 * formats the result. Only applicable when a web-search provider (Tavily)
 * is configured — without it there's no useful research to do, so we
 * bundle `web_get_page` with `web_search` as a pair rather than expose
 * a crippled subset.
 */
export const research = ai.tool({
  name: 'research',
  description: 'Ask a factual question; the researcher searches the web and reads pages to answer.',
  instructions: 'Pose a natural-language question. Returns an answer plus the URLs consulted.',
  schema: z.object({
    question: z.string().describe('The factual question to research'),
  }),
  call: async (input: { question: string }, _refs, ctx) => {
    const { researcher } = await import('../prompts/researcher');
    const result = await runSubagent(
      `researcher: ${input.question}`,
      () => researcher.get('stream', { question: input.question }, ctx),
      ctx.signal,
    );
    if (!result) return 'Researcher returned no result.';

    const { answer, sources = [] } = result;
    if (sources.length === 0) return answer;
    return `${answer}\n\nSources:\n${sources.map((s) => `  - ${s}`).join('\n')}`;
  },
  applicable: (ctx) => !!ctx.features?.webSearch,
});
