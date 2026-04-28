import { z } from 'zod';
import { ai } from '../ai';
import { fetchAndConvert } from '../web-content';

const PREVIEW_LIMIT = 16000;

/**
 * Fetch a web resource and return it as searchable text/markdown.
 *
 * Unlike a naive `fetch + strip-tags`, this uses the same pipeline as
 * the agi project's research prompt:
 *
 *   - HTML is rendered headless (Puppeteer) so SPA pages aren't empty.
 *   - PDFs / DOCX / XLSX go through pdf-parse / mammoth / xlsx and come
 *     back as markdown.
 *   - JSON / CSV / XML / source code get format-specific conversion.
 *
 * The returned string is capped to keep tool results bounded.
 */
export const webGetPage = ai.tool({
  name: 'web_get_page',
  description: 'Fetch a web resource (HTML, PDF, DOCX, XLSX, JSON, CSV, XML, source) and return it as searchable text/markdown.',
  instructions:
    'Provide a URL. HTML is rendered with a headless browser, so SPA pages work. ' +
    'PDF/DOCX/XLSX are parsed to markdown. Output is truncated to ~16k chars; ask narrower follow-up questions if more detail is needed.',
  schema: z.object({
    url: z.string().describe('URL to fetch'),
  }),
  applicable: (ctx) => !!ctx.features?.webSearch,
  call: async (input: { url: string }) => {
    const result = await fetchAndConvert(input.url);
    if (!result.ok) {
      return `Error fetching ${input.url}: ${result.error}`;
    }
    const { contentType, content } = result;
    const head = `[content-type: ${contentType}]\n`;
    if (content.length <= PREVIEW_LIMIT) return head + content;
    return `${head}${content.slice(0, PREVIEW_LIMIT)}\n\n[... truncated, original length ${content.length} chars ...]`;
  },
});
