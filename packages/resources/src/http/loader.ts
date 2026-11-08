/**
 * Fetching http(s) URLs into resources. A fetch follows redirects, is bounded by a timeout and a byte limit, works out
 * the content's type (magic numbers first, then the declared mime type, the URL's extension and a look at the text),
 * decodes text from its charset to utf-8, and, for html pages that are built by scripts, hands the page to a
 * pluggable {@link PageRenderer} (a headless browser) for the html after the scripts ran.
 */
import { Buffer } from "node:buffer";
import { htmlVisibleTextLength } from "../html/markdown";
import type { FetchFn, PageRenderer, RenderMode, ResolveOptions, ResourceRegistryLike, ResourceSource, ResourceStat, ResourceType } from "../types";
import { assertNotAborted, basenameFromLocation, isAbortError } from "../utils";
import { type ContentType, decodeText, isGenericMimeType, isUtf8Charset, looksBinary, parseContentType, sniffMagic, sniffText } from "./sniff";

/** Default URL fetch timeout (headers and body), in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Default maximum bytes downloaded per URL. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** How a fetched resource's type was worked out. */
export type DetectedBy = "content" | "header" | "extension" | "text" | "default";

/** What type detection needs from a registry. */
export type TypeInference = Pick<ResourceRegistryLike, "inferType">;

/** Options for one fetch: those of {@link ResolveOptions} that apply to http. */
export type HttpFetchOptions = Pick<ResolveOptions, "signal" | "headers" | "timeoutMs" | "maxBytes" | "fetch" | "renderer" | "render">;

/** A fetched URL as a resource source, with what the fetch found out. */
export interface HttpResource {
  /** The resource: located at the final URL, its input the body's bytes (utf-8 for text), its type detected. */
  source: ResourceSource & { input: Uint8Array };
  /** The URL that was asked for. */
  requestedUrl: string;
  /** The URL the content came from, after redirects (and after a renderer's navigation). */
  url: string;
  /** The response's status. */
  status: number;
  /** The content type the server declared. */
  declared?: ContentType;
  /** How the type was worked out. */
  detectedBy: DetectedBy;
  /** The charset text was decoded from, for text. */
  charset?: string;
  /** The renderer that ran the page, when one did. */
  renderedBy?: string;
  /** Why rendering failed, when it was tried in `auto` mode and failed (the fetched html is kept). */
  renderError?: string;
}

/**
 * Combines the caller's signal with a timeout. The timer is unref'd and never cleared, so it also covers reading the
 * body after the headers arrive.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Reads a response body, failing once it passes `maxBytes` (0 for no limit). */
async function readBody(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxBytes > 0 && total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Resource at ${url} is over the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function parseLastModified(value: string | null): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const size = Number.parseInt(value, 10);
  return Number.isNaN(size) ? undefined : size;
}

/** A type and mime type, and how they were found. */
interface Detection {
  readonly type: ResourceType | undefined;
  readonly mimeType: string | undefined;
  readonly detectedBy: DetectedBy;
  /** True for binary content, which is kept as it is; text is decoded (and transcoded to utf-8). */
  readonly binary: boolean;
}

/**
 * Works out the type of fetched bytes. Magic numbers win (a pdf served as `application/octet-stream` is a pdf); then
 * a specific declared mime type; then the URL's extension; then how the text starts; then plain text, or nothing for
 * bytes that look binary.
 */
export function detectType(registry: TypeInference, url: string, bytes: Uint8Array, declared: ContentType | undefined): Detection {
  const magic = sniffMagic(bytes);
  if (magic) {
    // A declared or named office type refines a plain zip (old xls/doc files are not zips at all).
    const named = magic.type === "zip" ? registry.inferType(url, declared?.mimeType) : undefined;
    return named === "docx" || named === "excel"
      ? { type: named, mimeType: declared?.mimeType, detectedBy: "header", binary: true }
      : { type: magic.type, mimeType: magic.mimeType, detectedBy: "content", binary: true };
  }
  const binary = looksBinary(bytes);
  if (declared && !isGenericMimeType(declared.mimeType)) {
    const type = registry.inferType("", declared.mimeType);
    if (type !== undefined) return { type, mimeType: declared.mimeType, detectedBy: "header", binary };
  }
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  const byExtension = registry.inferType(path);
  if (byExtension !== undefined) return { type: byExtension, mimeType: declared?.mimeType, detectedBy: "extension", binary };
  if (binary) return { type: undefined, mimeType: declared?.mimeType, detectedBy: "default", binary };
  const text = sniffText(Buffer.from(bytes.subarray(0, 256 * 1024)).toString("utf8"));
  if (text) return { type: text.type, mimeType: text.mimeType, detectedBy: "text", binary };
  return { type: "text", mimeType: declared?.mimeType ?? "text/plain", detectedBy: "default", binary };
}

/** Patterns of pages whose content is built by scripts. */
const APP_ROOT = /<(div|main|section|app-root)\b[^>]*\bid\s*=\s*["']?(?:root|app|__next|__nuxt|svelte|ember-app|q-app|main-app)\b[^>]*>\s*<\/\1>/i;
const NOSCRIPT_NEEDS_JS = /<noscript\b[^>]*>[\s\S]{0,500}?\b(?:enable|requires?|turn on|need)\b[\s\S]{0,40}?javascript/i;

/**
 * True when an html page looks built by scripts, so its fetched html holds little of what a browser shows: an empty
 * app root (`<div id="root"></div>`), a `<noscript>` asking for JavaScript, or scripts with almost no visible text.
 */
export function looksScriptRendered(html: string): boolean {
  const visible = htmlVisibleTextLength(html);
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  if (APP_ROOT.test(html) && visible < 1000) return true;
  if (NOSCRIPT_NEEDS_JS.test(html) && visible < 1000) return true;
  return scripts > 0 && visible < 200;
}

/** Whether a fetched html page goes through the renderer. */
function shouldRender(mode: RenderMode, html: string): boolean {
  return mode === "always" || (mode === "auto" && looksScriptRendered(html));
}

/** The message of an error, for metadata. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a page through the renderer when the mode says so. */
async function render(
  renderer: PageRenderer,
  mode: RenderMode,
  page: { url: string; html: string },
  options: HttpFetchOptions,
): Promise<{ html: string; url: string; renderedBy?: string; renderError?: string }> {
  if (!shouldRender(mode, page.html)) return page;
  try {
    const rendered = await renderer.render({ url: page.url, html: page.html, ...(options.headers ? { headers: options.headers } : {}), ...(options.signal ? { signal: options.signal } : {}) });
    return { html: rendered.html, url: rendered.url ?? page.url, renderedBy: renderer.id };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted || mode === "always") throw error;
    return { ...page, renderError: message(error) };
  }
}

/**
 * Fetches a URL into a resource: the body's bytes with the type worked out (see {@link detectType}), text transcoded
 * to utf-8, and html run through `options.renderer` when `options.render` (default `auto`) says so. Throws on a
 * non-2xx status, a timeout, or a body over the byte limit.
 */
export async function fetchResource(url: string, registry: TypeInference, options: HttpFetchOptions = {}): Promise<HttpResource> {
  assertNotAborted(options.signal);
  const doFetch: FetchFn = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const response = await doFetch(url, { redirect: "follow", ...(options.headers ? { headers: options.headers } : {}), ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  const declaredSize = parseContentLength(response.headers.get("content-length"));
  if (maxBytes > 0 && declaredSize !== undefined && declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Resource at ${url} is ${declaredSize} bytes, over the ${maxBytes}-byte limit`);
  }

  const finalUrl = response.url || url;
  let bytes = await readBody(response, maxBytes, finalUrl);
  const declared = parseContentType(response.headers.get("content-type"));
  const detection = detectType(registry, finalUrl, bytes, declared);
  const result: HttpResource = {
    requestedUrl: url,
    url: finalUrl,
    status: response.status,
    detectedBy: detection.detectedBy,
    source: { location: finalUrl, input: bytes },
    ...(declared ? { declared } : {}),
  };

  if (!detection.binary) {
    const decoded = decodeText(bytes, declared?.charset, detection.type === "html");
    result.charset = decoded.charset;
    let text = decoded.text;
    if (detection.type === "html" && options.renderer) {
      const page = await render(options.renderer, options.render ?? "auto", { url: finalUrl, html: text }, options);
      text = page.html;
      result.url = page.url;
      if (page.renderedBy !== undefined) result.renderedBy = page.renderedBy;
      if (page.renderError !== undefined) result.renderError = page.renderError;
    }
    if (!isUtf8Charset(decoded.charset) || result.renderedBy !== undefined) bytes = Buffer.from(text, "utf8");
  }

  const modifiedAt = parseLastModified(response.headers.get("last-modified"));
  const metadata: Record<string, unknown> = { status: response.status, detectedBy: detection.detectedBy };
  if (url !== result.url) metadata.requestedUrl = url;
  if (result.charset !== undefined) metadata.charset = result.charset;
  if (result.renderedBy !== undefined) metadata.renderedBy = result.renderedBy;
  if (result.renderError !== undefined) metadata.renderError = result.renderError;
  const etag = response.headers.get("etag");
  if (etag) metadata.etag = etag;

  result.source = {
    location: result.url,
    input: bytes,
    name: basenameFromLocation(result.url),
    size: bytes.byteLength,
    metadata,
    ...(detection.type !== undefined ? { type: detection.type } : {}),
    ...(detection.mimeType !== undefined ? { mimeType: detection.mimeType } : {}),
    ...(modifiedAt !== undefined ? { modifiedAt } : {}),
  };
  return result;
}

/**
 * Probes a URL with a HEAD request for its type, size and modified time without downloading it. Servers that reject
 * HEAD, and network failures, still give the URL itself, so callers can de-duplicate.
 */
export async function statUrl(url: string, registry: TypeInference, options: HttpFetchOptions = {}): Promise<ResourceStat> {
  assertNotAborted(options.signal);
  const doFetch: FetchFn = options.fetch ?? fetch;
  const signal = withTimeout(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(url, { method: "HEAD", redirect: "follow", ...(options.headers ? { headers: options.headers } : {}), ...(signal ? { signal } : {}) });
    const location = response.url || url;
    if (!response.ok) return { location };
    const declared = parseContentType(response.headers.get("content-type"));
    const type = declared && !isGenericMimeType(declared.mimeType) ? registry.inferType(location, declared.mimeType) : registry.inferType(location);
    const stat: ResourceStat = { location };
    if (declared) stat.mimeType = declared.mimeType;
    if (type !== undefined) stat.type = type;
    const modifiedAt = parseLastModified(response.headers.get("last-modified"));
    if (modifiedAt !== undefined) stat.modifiedAt = modifiedAt;
    const size = parseContentLength(response.headers.get("content-length"));
    if (size !== undefined) stat.size = size;
    return stat;
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    return { location: url };
  }
}
