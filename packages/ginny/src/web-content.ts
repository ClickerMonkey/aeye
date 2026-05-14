/**
 * Fetch a URL and convert its content to indexable text/markdown.
 * Mirrors the pipeline in agi/packages/server/src/ai/prompts/research.ts:
 *
 * - HTML/XHTML → headless browser (Puppeteer) → markdown via
 *   node-html-markdown (so SPA-rendered pages don't return empty bodies).
 * - JSON / CSV / XML / Markdown / source code → text-side conversion.
 * - PDF / DOCX / XLSX → buffer-side conversion via pdf-parse / mammoth /
 *   xlsx libraries → markdown.
 * - Anything else → raw text.
 *
 * The companion `web_get_page` tool wraps `fetchAndConvert`; consumers
 * outside of that tool can use the same entry point.
 */
// puppeteer is loaded lazily — see `fetchHtmlWithPuppeteer`. Keeping
// it out of the top-level import surface lets us declare it as an
// `optionalDependency` so a global install of ginny doesn't force every
// user to download Chromium (~170 MB) just to run non-web flows.
import { NodeHtmlMarkdown } from 'node-html-markdown';
import pdfParse from 'pdf-parse';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

// ---------------------------------------------------------------------------
// Content type detection — header-first, URL-extension fallback.
// ---------------------------------------------------------------------------

export type ContentType =
  | 'html' | 'json' | 'csv' | 'markdown' | 'pdf' | 'xml'
  | 'docx' | 'xlsx' | 'code' | 'text';

export const BINARY_TYPES: ReadonlySet<ContentType> = new Set(['pdf', 'docx', 'xlsx']);

export function detectContentType(contentType: string, url: string): ContentType {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return 'html';
  if (ct.includes('application/json')) return 'json';
  if (ct.includes('text/csv')) return 'csv';
  if (ct.includes('text/markdown')) return 'markdown';
  if (ct.includes('application/pdf')) return 'pdf';
  if (ct.includes('text/xml') || ct.includes('application/xml')) return 'xml';
  if (ct.includes('application/vnd.openxmlformats-officedocument.wordprocessingml')) return 'docx';
  if (ct.includes('application/vnd.openxmlformats-officedocument.spreadsheetml') ||
      ct.includes('application/vnd.ms-excel')) return 'xlsx';

  const ext = url.split('?')[0]?.split('#')[0]?.split('.').pop()?.toLowerCase();
  const extMap: Record<string, ContentType> = {
    json: 'json', csv: 'csv', md: 'markdown', markdown: 'markdown',
    pdf: 'pdf', xml: 'xml', html: 'html', htm: 'html',
    docx: 'docx', doc: 'docx', xlsx: 'xlsx', xls: 'xlsx',
    js: 'code', ts: 'code', jsx: 'code', tsx: 'code', py: 'code',
    java: 'code', cpp: 'code', c: 'code', go: 'code', rs: 'code',
    rb: 'code', php: 'code', swift: 'code', kt: 'code', scala: 'code',
    sql: 'code', sh: 'code', yaml: 'code', yml: 'code', toml: 'code',
  };
  return extMap[ext ?? ''] ?? 'text';
}

// ---------------------------------------------------------------------------
// Puppeteer HTML fetching — survives JS-rendered SPA content.
// ---------------------------------------------------------------------------

/**
 * Fetch + render an HTML page through a headless browser.
 *
 * Most modern sites are client-rendered, so we ask puppeteer to wait
 * for `networkidle2` (≤2 in-flight requests) — that's the signal a
 * SPA has actually painted content. But many real-world pages keep
 * connections open indefinitely (analytics, long-polling, websockets,
 * tracking pixels) and never reach networkidle2. The trick is to give
 * the wait a bounded budget and, IF it times out, scrape whatever's
 * rendered AT THAT MOMENT instead of failing — for most pages the
 * primary content is on screen well before the trailing connections
 * settle.
 *
 * Layered protections:
 *
 * 1. **Soft `goto` timeout** — 15s, with `networkidle2`. On timeout
 *    we DO NOT throw; we proceed to `page.content()` so the partial
 *    render is captured. This is the load-bearing change vs the
 *    previous "domcontentloaded only" version.
 * 2. **Hard wall-clock cap** — 30s for the whole function. If any
 *    step (launch, goto-after-timeout, content, close) is still
 *    stuck after that, the cap force-closes the browser so we don't
 *    let one URL leak into a multi-minute hang.
 * 3. **Signal-driven cancel** — when `signal` fires (ESC), we kick
 *    `browser.close()` so in-flight ops unwind immediately.
 */
export async function fetchHtmlWithPuppeteer(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  // Dynamic import + try/catch so an install where puppeteer (or its
  // Chromium download) was skipped surfaces a friendly error pointing
  // at the fix, instead of crashing the whole module's import graph.
  let puppeteer: typeof import('puppeteer').default;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `puppeteer is not available (${msg}). ` +
      `Install it to enable JS-rendered HTML fetching: \`npm i -g puppeteer\` ` +
      `(this also downloads a bundled Chromium).`,
    );
  }

  const HARD_CAP_MS = 30_000;
  const GOTO_MS = 15_000;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // Wire abort + hard cap to a single "kill the browser" path so any
  // stuck puppeteer call rejects and lets `finally` close cleanly.
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    browser.close().catch(() => { /* already closing */ });
  };
  const onAbort = () => kill();
  signal?.addEventListener('abort', onAbort);
  const hardCap = setTimeout(kill, HARD_CAP_MS);

  try {
    if (signal?.aborted) throw new Error('aborted');
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    // Wait for the SPA to settle if it can (`networkidle2` = ≤2
    // in-flight requests). On timeout / nav error, swallow and fall
    // through to `page.content()` — the primary content is usually
    // already painted; whatever's blocking networkidle2 is the
    // tracking-pixel / long-poll tail we don't actually need.
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: GOTO_MS });
    } catch {
      // Swallowed by design — see comment above.
    }
    return await page.content();
  } finally {
    clearTimeout(hardCap);
    signal?.removeEventListener('abort', onAbort);
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Per-format converters → markdown/plaintext.
// ---------------------------------------------------------------------------

function htmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html);
}

function jsonToMarkdown(raw: string): string {
  try {
    return '```json\n' + JSON.stringify(JSON.parse(raw), null, 2) + '\n```';
  } catch {
    return raw;
  }
}

function csvToMarkdown(raw: string): string {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return raw;
  const cols = lines[0]!.split(',').map(c => c.trim());
  const header = '| ' + cols.join(' | ') + ' |';
  const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
  const rows = lines.slice(1).map(r => '| ' + r.split(',').map(c => c.trim()).join(' | ') + ' |');
  return [header, sep, ...rows].join('\n');
}

function xmlToText(raw: string): string {
  return raw.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (_, tag) => `[${tag}] `).replace(/\s+/g, ' ').trim();
}

async function pdfToText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  return data.text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

async function docxToMarkdown(buffer: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer });
  if (!result.value || result.value.trim().length === 0) return '';
  return NodeHtmlMarkdown.translate(result.value);
}

function xlsxToMarkdown(buffer: Buffer): string {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sections: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const jsonData = XLSX.utils.sheet_to_json<string[]>(worksheet, { header: 1, defval: '', raw: false });
    if (jsonData.length === 0) continue;

    const headers = jsonData[0];
    if (!headers || headers.length === 0) continue;

    sections.push(`## Sheet: ${sheetName}\n`);
    sections.push('| ' + headers.join(' | ') + ' |');
    sections.push('| ' + headers.map(() => '---').join(' | ') + ' |');

    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || row.every(cell => !cell || cell.toString().trim() === '')) continue;
      sections.push('| ' + row.map(c => (c ?? '').toString().trim()).join(' | ') + ' |');
    }
    sections.push('');
  }

  return sections.join('\n');
}

/** Dispatch based on the detected content type. */
export async function contentToMarkdown(raw: string | Buffer, contentType: ContentType): Promise<string> {
  switch (contentType) {
    case 'html':     return htmlToMarkdown(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    case 'json':     return jsonToMarkdown(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    case 'csv':      return csvToMarkdown(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    case 'xml':      return xmlToText(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    case 'markdown': return typeof raw === 'string' ? raw : raw.toString('utf-8');
    case 'pdf':      return pdfToText(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    case 'docx':     return docxToMarkdown(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    case 'xlsx':     return xlsxToMarkdown(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    case 'code':     return '```\n' + (typeof raw === 'string' ? raw : raw.toString('utf-8')) + '\n```';
    default:         return typeof raw === 'string' ? raw : raw.toString('utf-8');
  }
}

// ---------------------------------------------------------------------------
// Top-level: fetch a URL and return its converted content + metadata.
// ---------------------------------------------------------------------------

export interface FetchResult {
  ok: true;
  url: string;
  contentType: ContentType;
  content: string;
}

export interface FetchError {
  ok: false;
  url: string;
  error: string;
}

export async function fetchAndConvert(
  url: string,
  signal?: AbortSignal,
): Promise<FetchResult | FetchError> {
  let rawContent: string | Buffer;
  let contentType: ContentType;

  try {
    const response = await globalThis.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GinBot/1.0)' },
      signal,
    });
    if (!response.ok) {
      return { ok: false, url, error: `HTTP ${response.status} ${response.statusText}` };
    }
    const ct = response.headers.get('content-type') ?? '';
    contentType = detectContentType(ct, url);

    if (contentType === 'html') {
      rawContent = await fetchHtmlWithPuppeteer(url, signal);
    } else if (BINARY_TYPES.has(contentType)) {
      rawContent = Buffer.from(await response.arrayBuffer());
    } else {
      rawContent = await response.text();
    }
  } catch (err) {
    return { ok: false, url, error: `Failed to fetch: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const content = await contentToMarkdown(rawContent, contentType);
    return { ok: true, url, contentType, content };
  } catch (err) {
    return { ok: false, url, error: `Failed to convert ${contentType}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
