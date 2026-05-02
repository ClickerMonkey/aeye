import type { Registry, Value, Type } from '@aeye/gin';
import { val } from '@aeye/gin';
import { getRuntimeSignal } from '../runtime-signal';
import {
  detectContentType,
  contentToMarkdown,
  fetchHtmlWithPuppeteer,
  BINARY_TYPES,
} from '../web-content';

/**
 * Two distinct return shapes, both surfaced through one `output` arg:
 *
 *   - `output: typ<text>` — caller wants the body as text. Markdown
 *     conversion (`convert: "markdown"`, default) or raw passthrough
 *     (`convert: "raw"`) applies. Result is a `text` Value.
 *   - `output: typ<obj{...}>` (or list / etc.) — caller wants the
 *     JSON body parsed against a concrete shape. The body is
 *     `JSON.parse`d and then `outputType.parse`d. `convert` is
 *     irrelevant here.
 *
 * `output` is REQUIRED (vs. previously optional) — keeping it bound
 * means the fn's return type `R` is always concrete at the call
 * site, so `define x: text = fns.fetch(...)` doesn't trip the
 * "value type 'R' not compatible with declared 'text'" error the
 * model couldn't figure out.
 */
export function createFetchImpl(registry: Registry) {
  return async (argsValue: Value): Promise<Value> => {
    const args = argsValue.raw as Record<string, Value>;
    const url = (args['url']?.raw ?? '') as string;
    const method = ((args['method']?.raw as string | null) ?? 'get').toUpperCase();

    const headersRaw = args['headers']?.raw as Record<string, Value> | null | undefined;
    const headersObj: Record<string, string> = {};
    if (headersRaw && typeof headersRaw === 'object') {
      for (const [k, v] of Object.entries(headersRaw)) {
        headersObj[k] = (v instanceof Object && 'raw' in v ? (v as Value).raw : v) as string;
      }
    }

    const bodyRaw = args['body']?.raw;
    let bodyStr: string | undefined;
    if (bodyRaw !== undefined && bodyRaw !== null) {
      bodyStr = typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw);
    }

    const outputType = args['output']?.raw as Type;
    const convert = ((args['convert']?.raw as string | null) ?? 'markdown') as 'markdown' | 'raw';

    // Forward the entry-point's interrupt signal so an ESC during a
    // long fetch tears down the underlying HTTP request immediately.
    const signal = getRuntimeSignal();

    // Decide between text-shaped and structured-JSON modes by the
    // outputType's runtime class. `text` (and any TextType
    // refinement) routes through the markdown / raw text paths;
    // anything else is treated as structured JSON.
    const wantsText = outputType?.name === 'text';

    if (!wantsText) {
      // Structured JSON path: fetch raw body, JSON.parse, type-parse
      // against `outputType`. If JSON parse fails (caller hit a
      // non-JSON endpoint), fall through to a text Value of the raw
      // body so the model can see what came back.
      let bodyText = '';
      try {
        const resp = await globalThis.fetch(url, {
          method,
          headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
          body: bodyStr,
          signal,
        });
        bodyText = await resp.text();
      } catch (e: unknown) {
        bodyText = e instanceof Error ? e.message : String(e);
      }
      try {
        const bodyJson = JSON.parse(bodyText);
        return outputType.parse(bodyJson);
      } catch {
        return val(registry.text(), bodyText);
      }
    }

    // Text path: convert the body for readability (default), or
    // pass through raw for callers that want the literal source.
    try {
      const resp = await globalThis.fetch(url, {
        method,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GinBot/1.0)', ...headersObj },
        body: bodyStr,
        signal,
      });
      if (!resp.ok) {
        return val(registry.text(), `HTTP ${resp.status} ${resp.statusText}`);
      }

      if (convert === 'raw') {
        const raw = await resp.text();
        return val(registry.text(), raw);
      }

      const ct = resp.headers.get('content-type') ?? '';
      const contentType = detectContentType(ct, url);

      let raw: string | Buffer;
      if (contentType === 'html' && method === 'GET') {
        // Re-fetch via headless browser so JS-rendered SPA pages
        // aren't returned as empty <body> shells. Puppeteer is GET-
        // only — for non-GET HTML we fall back to the raw response.
        // The signal is plumbed in so an ESC during a slow render
        // kills the browser instead of letting it hang.
        raw = await fetchHtmlWithPuppeteer(url, signal);
      } else if (BINARY_TYPES.has(contentType)) {
        raw = Buffer.from(await resp.arrayBuffer());
      } else {
        raw = await resp.text();
      }

      const converted = await contentToMarkdown(raw, contentType);
      return val(registry.text(), converted);
    } catch (e: unknown) {
      return val(registry.text(), e instanceof Error ? e.message : String(e));
    }
  };
}

export function registerFetchType(registry: Registry) {
  const httpMethod = registry.enum(
    { get: 'get', post: 'post', put: 'put', patch: 'patch', delete: 'delete', head: 'head' },
    registry.text(),
  );
  const convertMode = registry.enum(
    { markdown: 'markdown', raw: 'raw' },
    registry.text(),
  );

  return registry.fn(
    registry.obj({
      url:     { type: registry.text(), docs: 'URL to fetch.' },
      method:  { type: registry.optional(httpMethod), docs: 'HTTP method (default GET).' },
      headers: { type: registry.optional(registry.map(registry.text(), registry.text())), docs: 'Optional request headers.' },
      body:    { type: registry.optional(registry.any()), docs: 'Optional request body. Objects are JSON.stringify-d before sending.' },
      convert: {
        type: registry.optional(convertMode),
        docs: 'Only meaningful when `output: typ<text>`. "markdown" (default) auto-converts HTML / PDF / DOCX / XLSX to markdown via a headless browser + parsers and wraps JSON / CSV / source in fenced text — the readable form, ideal for piping into `fns.llm`. "raw" returns the response body untouched, for callers that want the literal source. When `output` is a structured type (obj / list / etc.), `convert` is ignored — the body is always JSON-parsed.',
      },
      output:  {
        // REQUIRED — not optional. Keeping the generic R bound at every
        // call site means callers can write `define x: text = fns.fetch(...)`
        // without tripping a `define.var.type-mismatch` against the
        // unbound 'R'.
        type: registry.typ(registry.alias('R')),
        docs: 'REQUIRED. The gin Type the call site expects back. Two common shapes: `output: typ<text>` for free-form content (HTML pages, articles, PDFs, raw API responses) — pair with `convert: "markdown"` (default) or `convert: "raw"`. `output: typ<<some obj/list>>` for JSON APIs where the response shape is known — the body is JSON.parse-d and parsed against the type. Required so the fn\'s generic R is always bound; without it, declaring a return-type-annotated variable from the call site would mismatch.',
      },
    }),
    registry.alias('R'),
    undefined,
    { R: registry.any() },
  );
}
