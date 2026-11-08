import { describe, expect, it } from "@jest/globals";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pdfPageText } from "../converters/pdf.js";
import { formatSize } from "../converters/folder.js";
import { createDefaultResourceRegistry } from "../default.js";
import { parseHtml, textContent } from "../html/dom.js";
import { htmlToCleanMarkdown } from "../html/markdown.js";
import { decodeText, isGenericMimeType, sniffMagic } from "../http/sniff.js";
import { optionalModule } from "../optional.js";
import { ResourceRegistry } from "../registry.js";
import { TypeStack, runStack } from "../stack.js";
import { htmlToMarkdown, mergeOptions } from "../utils.js";

/** A fake pdf.js page holding text items. */
const page = (items: unknown[]) => ({ getTextContent: async () => ({ items }) });

describe("pdf page text", () => {
  it("joins items on a baseline, breaks lines where the baseline changes or an item ends one, and skips marked content", async () => {
    const text = await pdfPageText(page([
      { str: "Hello ", transform: [1, 0, 0, 1, 0, 700] },
      { str: "world", transform: [1, 0, 0, 1, 40, 700], hasEOL: true },
      { type: "beginMarkedContent" },
      { str: "Next", transform: [1, 0, 0, 1, 0, 700] },
      { str: "Lower  ", transform: [1, 0, 0, 1, 0, 680] },
    ]));
    expect(text).toBe("Hello world\nNext\nLower");
  });

  it("is empty for something that is not a page", async () => {
    expect(await pdfPageText({})).toBe("");
    expect(await pdfPageText(null)).toBe("");
  });
});

describe("converting through pdf", () => {
  it("parses docx and spreadsheets through convertToPdf when configured, keeping the original location", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aeye-topdf-"));
    try {
      const pdfPath = path.join(dir, "out.pdf");
      // A one-page pdf with the text "Converted".
      const content = "BT /F1 12 Tf 10 50 Td (Converted) Tj ET";
      const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
      let out = "%PDF-1.4\n";
      const offsets: number[] = [];
      objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
      const xref = out.length;
      out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
      await writeFile(pdfPath, Buffer.from(out, "latin1"));
      const seen: string[] = [];
      const registry = createDefaultResourceRegistry()
        .configureType("docx", { convertToPdf: async (file) => { seen.push(path.extname(file)); return pdfPath; } })
        .configureType("excel", { convertToPdf: async () => pdfPath, pdf: { renderPages: true } });
      expect(await registry.isTypeSupported("docx")).toBe(true);
      const docx = await registry.parse({ location: "/virtual/report.docx", type: "docx", name: "report.docx", input: "not really a docx" });
      expect(seen).toEqual([".docx"]);
      expect(docx.resource.location).toBe("/virtual/report.docx");
      expect(docx.resource.metadata).toMatchObject({ convertedFrom: "docx", pdfPath });
      expect(docx.resource.parts[0]?.text).toBe("Converted");
      const sheet = await registry.parse({ location: "/virtual/book.xlsx", type: "excel", input: "x" });
      expect(sheet.resource.version?.kind).toBe("pages");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("edges of the html tools", () => {
  it("keeps CDATA text and drops processing instructions and unclosed comments", () => {
    expect(textContent(parseHtml("<p><![CDATA[a < b]]></p><?php echo 1 ?>after<!-- never closed"))).toBe("a < bafter");
    expect(textContent(parseHtml("<![CDATA[open"))).toBe("open");
  });

  it("writes strikethrough, keyboard input, empty code and blocks inside inline content", () => {
    expect(htmlToMarkdown("<div><del>old</del> <kbd>Ctrl</kbd> <code> </code><a href='https://x.dev'><div>Card</div></a>wo<wbr>rd</div>")).toBe("~~old~~ `Ctrl` [Card](https://x.dev) word");
    expect(htmlToCleanMarkdown("<a href='http://[bad'>x</a>", { baseUrl: "https://a.dev/" }).markdown).toBe("[x](http://[bad)");
  });
});

describe("edges of sniffing", () => {
  it("knows utf-16 by its byte order mark, bmp and ico images, and generic mime types", () => {
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x61, 0x00])).text).toBe("a");
    expect(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x61])).charset).toBe("utf-16be");
    expect(sniffMagic(Buffer.from([0x42, 0x4d, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mimeType).toBe("image/bmp");
    expect(sniffMagic(Buffer.from([0, 0, 1, 0, 1, 0]))?.mimeType).toBe("image/x-icon");
    expect(isGenericMimeType("application/octet-stream")).toBe(true);
    expect(isGenericMimeType("text/html")).toBe(false);
  });
});

describe("edges of the plumbing", () => {
  it("loads optional modules once and gives undefined when missing", async () => {
    let loads = 0;
    const present = optionalModule(async () => ++loads);
    expect([await present(), await present()]).toEqual([1, 1]);
    const missing = optionalModule(async (): Promise<number> => { throw new Error("not installed"); });
    expect(await missing()).toBeUndefined();
  });

  it("stacks handlers by priority and reports declines, failures and aborts", async () => {
    const stack = new TypeStack<{ id: string; supportedTypes: string[]; priority?: number }>();
    stack.register({ id: "a", supportedTypes: ["t"] });
    stack.register({ id: "b", supportedTypes: ["t", "u"], priority: 1 });
    expect(stack.get("t").map((m) => m.id)).toEqual(["b", "a"]);
    expect(stack.has("u")).toBe(true);
    expect(stack.has("v")).toBe(false);
    expect(await runStack([1, 2], async () => undefined, undefined, "x")).toEqual({ status: "declined" });
    const controller = new AbortController();
    const abort = new DOMException("stop", "AbortError");
    await expect(runStack([1], async () => { throw abort; }, controller.signal, "x")).rejects.toBe(abort);
  });

  it("merges html and folder options per type under per-call ones", () => {
    expect(mergeOptions({ html: { links: false }, folder: { includeHidden: true } }, { html: { images: false } })).toEqual({ html: { links: false, images: false }, folder: { includeHidden: true } });
    const registry = new ResourceRegistry().configureType("html", { html: { content: "body" } });
    expect(registry.getTypeConfig("html")).toEqual({ html: { content: "body" } });
  });

  it("formats sizes", () => {
    expect([formatSize(0), formatSize(1023), formatSize(1536), formatSize(20 * 1024 * 1024), formatSize(3 * 1024 ** 5)]).toEqual(["0 B", "1023 B", "1.5 KB", "20 MB", "3072 TB"]);
  });
});
