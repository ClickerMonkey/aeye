import type { Registry, Value, Type } from '@aeye/gin';
import { val } from '@aeye/gin';
import { getRuntimeSignal } from '../runtime-signal';
import {
  detectContentType,
  contentToMarkdown,
  fetchHtmlWithPuppeteer,
  BINARY_TYPES,
} from '../web-content';

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

    const outputType = args['output']?.raw as Type | undefined;
    // 'markdown' (default): convert HTML/PDF/DOCX/XLSX to markdown,
    // wrap JSON/CSV/source in fenced text — the readable form.
    // 'raw': return the response body untouched, useful when the
    // caller wants the literal HTML/JSON/etc. for downstream parsing.
    // Ignored when `output` is set (typed-JSON path always JSON-parses
    // the raw body).
    const convert = ((args['convert']?.raw as string | null) ?? 'markdown') as 'markdown' | 'raw';

    // Forward the entry-point's interrupt signal so an ESC during a
    // long fetch tears down the underlying HTTP request immediately.
    const signal = getRuntimeSignal();

    // Output-typed branch: caller wants the JSON body parsed against a
    // specific gin Type (typed obj, list, etc.). Take the raw text,
    // JSON-parse it, type-parse it. Markdown conversion would mangle
    // the structure here, so it's deliberately skipped.
    if (outputType) {
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

    // Untyped branch: by default convert whatever the URL returned
    // to readable markdown / plaintext so the caller's program (or,
    // more often, an `fns.llm` summarization step downstream) gets
    // clean text instead of raw HTML / PDF bytes / spreadsheet
    // binary. `convert: "raw"` returns the response body untouched
    // — useful for downstream parsing or when you want the literal
    // HTML/CSS source.
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
        // Skip every conversion: return the body as-is. We still go
        // through `text()` so the caller gets a string regardless of
        // content-type; binary URLs (PDF, etc.) yield best-effort
        // utf-8. Use `convert: "markdown"` for those.
        const raw = await resp.text();
        return val(registry.text(), raw);
      }

      const ct = resp.headers.get('content-type') ?? '';
      const contentType = detectContentType(ct, url);

      let raw: string | Buffer;
      if (contentType === 'html' && method === 'GET') {
        // Re-fetch via headless browser so JS-rendered SPA pages
        // aren't returned as empty <body> shells. Puppeteer is GET-
        // only — for non-GET HTML (rare) we fall back to the raw
        // response body. The signal is plumbed in so an ESC during
        // a slow render kills the browser instead of letting it
        // hang for the full 30s wall-clock cap.
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
      url:     { type: registry.text(), docs: 'URL to fetch' },
      method:  { type: registry.optional(httpMethod) },
      headers: { type: registry.optional(registry.map(registry.text(), registry.text())) },
      body:    { type: registry.optional(registry.any()) },
      convert: {
        type: registry.optional(convertMode),
        docs: 'How to deliver the response body when `output` is NOT set. "markdown" (default) auto-converts HTML/PDF/DOCX/XLSX to markdown via headless browser + parsers, and wraps JSON/CSV/source in fenced text — the readable form, ideal for piping into `fns.llm`. "raw" returns the response body untouched as text, for callers that want literal HTML/JSON/etc. for their own parsing. Ignored when `output` is set (typed-JSON path always JSON-parses the raw body).',
      },
      output:  {
        type: registry.optional(registry.typ(registry.alias('R'))),
        docs: 'gin Type to parse the JSON response body through. ONLY set this for JSON APIs where you know the response shape — the body is JSON.parse-d and parsed against this type. WITHOUT this, fns.fetch returns a single text block (markdown by default, raw if `convert: "raw"`).',
      },
    }),
    registry.alias('R'),
    undefined,
    // Constraint on R, not a default. fetch is fully untyped from gin's
    // perspective — the response body is whatever the remote server
    // hands back, and `output:` parses it into any gin Type the caller
    // asks for. `any` reflects that.
    { R: registry.any() },
  );
}
