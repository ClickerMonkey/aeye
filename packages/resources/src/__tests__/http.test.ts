import { describe, expect, it } from "@jest/globals";
import { Buffer } from "node:buffer";
import { createDefaultResourceRegistry } from "../default";
import { detectType, fetchResource, looksScriptRendered, statUrl } from "../http/loader";
import { decodeText, looksBinary, parseContentType, sniffMagic, sniffText } from "../http/sniff";
import type { FetchFn, PageRenderer } from "../types";

const registry = createDefaultResourceRegistry();

/** A response with a body, headers and (when redirected) a final URL. */
function respond(body: string | Uint8Array, init: { status?: number; headers?: Record<string, string>; url?: string } = {}): Response {
  const response = new Response(typeof body === "string" ? body : Buffer.from(body), { status: init.status ?? 200, headers: init.headers });
  if (init.url !== undefined) Object.defineProperty(response, "url", { value: init.url });
  return response;
}

/** A fetch that answers every request with the response the handler makes, recording requests. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response): { fetch: FetchFn; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

/** A renderer that records what it was asked and answers with fixed html. */
function fakeRenderer(html: string, fail = false): PageRenderer & { asked: string[] } {
  const asked: string[] = [];
  return {
    id: "fake-browser",
    asked,
    async render(request) {
      asked.push(request.url);
      if (fail) throw new Error("browser crashed");
      return { html, url: `${request.url}#rendered` };
    },
  };
}

const PDF_BYTES = Buffer.from("%PDF-1.4\n%...", "latin1");
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("content sniffing", () => {
  it("parses content types", () => {
    expect(parseContentType("Text/HTML; Charset=\"ISO-8859-1\"")).toEqual({ mimeType: "text/html", charset: "iso-8859-1" });
    expect(parseContentType("application/json")).toEqual({ mimeType: "application/json" });
    expect(parseContentType("")).toBeUndefined();
    expect(parseContentType(null)).toBeUndefined();
  });

  it("knows binary formats by their magic numbers, telling office zips apart", () => {
    expect(sniffMagic(PDF_BYTES)?.type).toBe("pdf");
    expect(sniffMagic(PNG_BYTES)).toEqual({ type: "image", mimeType: "image/png" });
    expect(sniffMagic(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))?.mimeType).toBe("image/jpeg");
    expect(sniffMagic(Buffer.from("GIF89a"))?.mimeType).toBe("image/gif");
    expect(sniffMagic(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))?.mimeType).toBe("image/webp");
    const zip = (name: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`\0\0\0\0${name}`)]);
    expect(sniffMagic(zip("word/document.xml"))?.type).toBe("docx");
    expect(sniffMagic(zip("xl/workbook.xml"))?.type).toBe("excel");
    expect(sniffMagic(zip("readme.txt"))?.type).toBe("zip");
    expect(sniffMagic(Buffer.from("plain"))).toBeUndefined();
  });

  it("tells binary from text and text formats from how they start", () => {
    expect(looksBinary(Uint8Array.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(Buffer.from("hello\n\tworld"))).toBe(false);
    expect(sniffText("  <!DOCTYPE html><p>")?.type).toBe("html");
    expect(sniffText("<?xml version='1.0'?><svg></svg>")?.type).toBe("svg");
    expect(sniffText("<?xml version='1.0'?><feed/>")?.type).toBe("xml");
    expect(sniffText("{\"a\": 1}")?.type).toBe("json");
    expect(sniffText("{not json")).toBeUndefined();
    expect(sniffText("just words")).toBeUndefined();
  });

  it("decodes text by BOM, declared charset or meta charset", () => {
    expect(decodeText(Buffer.from([0xe9]), "iso-8859-1")).toEqual({ text: "é", charset: "iso-8859-1" });
    expect(decodeText(Buffer.from("<meta charset=windows-1252><p>\x93q\x94</p>", "latin1"), undefined, true).text).toContain("“q”");
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]), "iso-8859-1")).toEqual({ text: "a", charset: "utf-8" });
    expect(decodeText(Buffer.from("x"), "no-such-charset")).toEqual({ text: "x", charset: "utf-8" });
  });

  it("detects types: magic first, then a specific header, the extension, the text, else plain text", () => {
    const detect = (url: string, body: string | Uint8Array, contentType?: string) =>
      detectType(registry, url, typeof body === "string" ? Buffer.from(body) : body, parseContentType(contentType));
    expect(detect("https://a.dev/file", PDF_BYTES, "application/octet-stream")).toMatchObject({ type: "pdf", detectedBy: "content", binary: true });
    expect(detect("https://a.dev/x", "<p>", "text/html; charset=utf-8")).toMatchObject({ type: "html", mimeType: "text/html", detectedBy: "header" });
    expect(detect("https://a.dev/readme.md?raw=1", "# hi", "text/plain")).toMatchObject({ type: "markdown", detectedBy: "extension" });
    expect(detect("https://a.dev/api", "{\"a\":1}", "text/plain")).toMatchObject({ type: "json", detectedBy: "text" });
    expect(detect("https://a.dev/notes", "words", undefined)).toMatchObject({ type: "text", detectedBy: "default", binary: false });
    expect(detect("https://a.dev/blob", Uint8Array.from([1, 0, 2]), "application/octet-stream")).toMatchObject({ type: undefined, binary: true });
    const officeZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\0\0data")]);
    expect(detect("https://a.dev/report.xlsx", officeZip, "application/octet-stream")).toMatchObject({ type: "excel", detectedBy: "header" });
  });

  it("spots pages built by scripts", () => {
    expect(looksScriptRendered(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`)).toBe(true);
    expect(looksScriptRendered(`<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="x"></div></body>`)).toBe(true);
    expect(looksScriptRendered(`<body><script>boot()</script><p>Hi</p></body>`)).toBe(true);
    expect(looksScriptRendered(`<body><script>analytics()</script><article><p>${"Plenty of server-rendered text. ".repeat(20)}</p></article></body>`)).toBe(false);
    expect(looksScriptRendered(`<body><p>Short and static.</p></body>`)).toBe(false);
  });
});

describe("fetching URLs", () => {
  it("fetches a page into a source at its final URL, with what the fetch found", async () => {
    const { fetch, calls } = fakeFetch(() => respond("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8", "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT", etag: "\"v1\"" }, url: "https://a.dev/final" }));
    const result = await fetchResource("https://a.dev/start", registry, { fetch, headers: { "user-agent": "test" } });
    expect(calls[0]?.init.headers).toEqual({ "user-agent": "test" });
    expect(calls[0]?.init.redirect).toBe("follow");
    expect(result).toMatchObject({ requestedUrl: "https://a.dev/start", url: "https://a.dev/final", status: 200, detectedBy: "header", charset: "utf-8" });
    expect(result.source).toMatchObject({
      location: "https://a.dev/final", type: "html", mimeType: "text/html", name: "final", size: 9, modifiedAt: Date.parse("Wed, 21 Oct 2026 07:28:00 GMT"),
      metadata: { status: 200, detectedBy: "header", requestedUrl: "https://a.dev/start", charset: "utf-8", etag: "\"v1\"" },
    });
    expect(Buffer.from(result.source.input).toString("utf8")).toBe("<p>hi</p>");
  });

  it("transcodes text in other charsets to utf-8 and keeps binary bytes as they are", async () => {
    const latin = await fetchResource("https://a.dev/t.txt", registry, { fetch: async () => respond(Buffer.from("caf\xe9", "latin1"), { headers: { "content-type": "text/plain; charset=iso-8859-1" } }) });
    expect(Buffer.from(latin.source.input).toString("utf8")).toBe("café");
    expect(latin.source.metadata?.charset).toBe("iso-8859-1");
    const png = await fetchResource("https://a.dev/i", registry, { fetch: async () => respond(PNG_BYTES, { headers: { "content-type": "application/octet-stream" } }) });
    expect(png.source).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Array.from(png.source.input)).toEqual(Array.from(PNG_BYTES));
    expect(png.charset).toBeUndefined();
  });

  it("fails on error statuses and on bodies over the byte limit", async () => {
    await expect(fetchResource("https://a.dev/missing", registry, { fetch: async () => respond("no", { status: 404 }) })).rejects.toThrow("404");
    await expect(fetchResource("https://a.dev/big", registry, { maxBytes: 4, fetch: async () => respond("too long", { headers: { "content-length": "8" } }) })).rejects.toThrow("over the 4-byte limit");
    await expect(fetchResource("https://a.dev/big", registry, { maxBytes: 4, fetch: async () => respond("too long") })).rejects.toThrow("over the 4-byte limit");
  });

  it("passes an abort through and times out", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchResource("https://a.dev/", registry, { signal: controller.signal, fetch: async () => respond("x") })).rejects.toMatchObject({ name: "AbortError" });
    const hang: FetchFn = (_url, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    await expect(fetchResource("https://a.dev/slow", registry, { timeoutMs: 20, fetch: hang })).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("runs script-built pages through the renderer in auto mode, and only those", async () => {
    const shell = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    const renderer = fakeRenderer("<main><h1>Rendered</h1></main>");
    const rendered = await fetchResource("https://app.dev/", registry, { renderer, fetch: async () => respond(shell, { headers: { "content-type": "text/html" } }) });
    expect(renderer.asked).toEqual(["https://app.dev/"]);
    expect(rendered).toMatchObject({ renderedBy: "fake-browser", url: "https://app.dev/#rendered" });
    expect(Buffer.from(rendered.source.input).toString("utf8")).toBe("<main><h1>Rendered</h1></main>");
    expect(rendered.source.metadata?.renderedBy).toBe("fake-browser");

    const staticPage = `<article><p>${"Server text. ".repeat(40)}</p></article>`;
    const plain = await fetchResource("https://blog.dev/", registry, { renderer, fetch: async () => respond(staticPage, { headers: { "content-type": "text/html" } }) });
    expect(plain.renderedBy).toBeUndefined();
    expect(renderer.asked).toHaveLength(1);
  });

  it("renders always or never on request, and keeps the fetched html when auto rendering fails", async () => {
    const page = () => respond("<p>static</p>", { headers: { "content-type": "text/html" } });
    const always = fakeRenderer("<p>after</p>");
    expect((await fetchResource("https://a.dev/", registry, { renderer: always, render: "always", fetch: async () => page() })).renderedBy).toBe("fake-browser");
    const never = fakeRenderer("<p>after</p>");
    await fetchResource("https://a.dev/", registry, { renderer: never, render: "never", fetch: async () => respond("<div id='app'></div><script></script>", { headers: { "content-type": "text/html" } }) });
    expect(never.asked).toHaveLength(0);

    const broken = fakeRenderer("", true);
    const shell = () => respond("<div id='app'></div><script></script>", { headers: { "content-type": "text/html" } });
    const kept = await fetchResource("https://a.dev/", registry, { renderer: broken, fetch: async () => shell() });
    expect(kept.renderError).toBe("browser crashed");
    expect(Buffer.from(kept.source.input).toString("utf8")).toContain("id='app'");
    await expect(fetchResource("https://a.dev/", registry, { renderer: broken, render: "always", fetch: async () => shell() })).rejects.toThrow("browser crashed");
  });

  it("stats URLs with HEAD, falling back to the URL when the server says no", async () => {
    const head = fakeFetch(() => respond("", { headers: { "content-type": "application/pdf", "content-length": "1234", "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" } }));
    expect(await statUrl("https://a.dev/doc", registry, { fetch: head.fetch })).toEqual({ location: "https://a.dev/doc", mimeType: "application/pdf", type: "pdf", size: 1234, modifiedAt: Date.parse("Wed, 21 Oct 2026 07:28:00 GMT") });
    expect(head.calls[0]?.init.method).toBe("HEAD");
    expect(await statUrl("https://a.dev/x.md", registry, { fetch: async () => respond("", { headers: { "content-type": "text/plain" } }) })).toMatchObject({ type: "markdown" });
    expect(await statUrl("https://a.dev/no", registry, { fetch: async () => respond("", { status: 405 }) })).toEqual({ location: "https://a.dev/no" });
    expect(await statUrl("https://a.dev/down", registry, { fetch: async () => { throw new Error("offline"); } })).toEqual({ location: "https://a.dev/down" });
  });

  it("loads URLs through the registry with the fetch, renderer and relative links", async () => {
    const renderer = fakeRenderer("<main><h1>App</h1><a href='/next'>next</a></main>");
    const pages: Record<string, string> = {
      "https://app.dev/": "<div id='root'></div><script src='/a.js'></script>",
      "https://app.dev/next": "<h1>Next</h1>",
    };
    const fetch: FetchFn = async (url) => respond(pages[url] ?? "", { status: pages[url] === undefined ? 404 : 200, headers: { "content-type": "text/html" } });
    const root = await registry.load("https://app.dev/", { fetch, renderer });
    expect(root.resource.version).toMatchObject({ kind: "markdown", text: "# App\n\n[next](https://app.dev/next)" });
    expect(root.resource.location).toBe("https://app.dev/#rendered");
    const next = await registry.load("/next", { baseLocation: "https://app.dev/", fetch, renderer });
    expect(next.resource.parts[0]?.text).toBe("# Next");
    expect(await registry.statLink("https://app.dev/next", { fetch })).toMatchObject({ type: "html" });
  });
});
