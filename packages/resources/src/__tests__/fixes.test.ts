import { describe, expect, it } from "@jest/globals";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createDefaultResourceRegistry } from "../default";
import { buildResourceGraph, DEFAULT_GRAPH_MAX_RESOURCES } from "../graph";
import { ResourceRegistry, createParsedResource } from "../registry";
import { textSlicer } from "../slicers";
import { collectInput, extractLinksFromText } from "../utils";
import type { RenderPdfPagesFn, ResourceParser, ResourceResolver, SummaryRequest } from "../types";

const registry = createDefaultResourceRegistry();

async function withServer(
  handler: http.RequestListener,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    await run(address.port);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Builds a minimal one-page PDF containing `text`. */
function makePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("code slicer", () => {
  it("keeps text before the first declaration and covers the whole file", async () => {
    const input = "// License: MIT\nimport { a } from './a';\n\nexport function one() {\n  return a;\n}\n";
    const { resource, slices } = await registry.load({ location: "/virtual/one.ts", type: "typescript", input }, { maxChars: 2000 });
    expect(slices.map((slice) => slice.text).join("")).toBe(resource.parts[0].text);
    expect(slices[0].text).toContain("License: MIT");
    expect(slices[0].context?.declaration).toBeUndefined();
  });

  it("splits only on top-level declarations and keeps doc comments with them", async () => {
    const input = [
      "/** Adds. */",
      "export function add(a: number, b: number) {",
      "  const sum = a + b;",
      "  return sum;",
      "}",
      "",
      "export const two = 2;",
      "",
    ].join("\n");
    const { slices } = await registry.load({ location: "/virtual/add.ts", type: "typescript", input }, { maxChars: 2000 });
    const sections = new Set(slices.map((slice) => slice.sectionId));
    expect(sections.size).toBe(2);
    expect(slices[0].text.startsWith("/** Adds. */")).toBe(true);
    expect(slices[0].text).toContain("const sum");
    expect(slices[0].context?.declaration).toBe("export function add(a: number, b: number) {");
  });

  it("uses language patterns for python, keeping decorators with the def", async () => {
    const input = "import os\n\n@cache\ndef first():\n    x = 1\n    return x\n\nclass Second:\n    def method(self):\n        pass\n";
    const { slices } = await registry.load({ location: "/virtual/mod.py", type: "python", input }, { maxChars: 2000 });
    const declarations = slices.map((slice) => slice.context?.declaration);
    expect(declarations).toEqual([undefined, "def first():", "class Second:"]);
    expect(slices[1].text.startsWith("@cache")).toBe(true);
  });

  it("only attaches links that appear in each slice", async () => {
    const input = "import { a } from './a';\n\nexport function one() {\n  return 'https://one.example.com/x';\n}\n";
    const { slices } = await registry.load({ location: "/virtual/links.ts", type: "typescript", input }, { maxChars: 2000 });
    const fn = slices.find((slice) => slice.context?.declaration?.includes("one"))!;
    expect(fn.links.map((link) => link.value)).toEqual(["https://one.example.com/x"]);
    expect(slices[0].links.map((link) => link.value)).toEqual(["./a"]);
  });
});

describe("markdown slicer", () => {
  it("keeps text before the first heading and ignores # lines in code fences", async () => {
    const input = "Intro paragraph.\n\n# Setup\n\n```sh\n# install deps\nnpm i\n```\n\n## Usage\n\nRun it.\n";
    const { resource, slices } = await registry.load({ location: "/virtual/guide.md", type: "markdown", input }, { maxChars: 2000 });
    expect(slices.map((slice) => slice.text).join("")).toBe(resource.parts[0].text);
    expect(slices[0].text).toBe("Intro paragraph.\n\n");
    expect(slices[0].context).toBeUndefined();
    const headingPaths = slices.map((slice) => slice.context?.headings?.join(" > "));
    expect(headingPaths).toEqual([undefined, "Setup", "Setup > Usage"]);
  });
});

describe("text slicer links", () => {
  it("only attaches links that appear in each slice", async () => {
    const filler = "word ".repeat(60);
    const input = `First https://a.example.com/one ${filler}\n\nSecond https://b.example.com/two ${filler}`;
    const { slices } = await registry.load({ location: "/virtual/notes.txt", type: "text", input }, { maxChars: 400, minChars: 50 });
    expect(slices.length).toBeGreaterThan(1);
    for (const slice of slices) {
      for (const link of slice.links) {
        expect(slice.text).toContain(link.value);
      }
    }
  });
});

describe("link extraction", () => {
  it("drops sentence punctuation after bare URLs", () => {
    const values = extractLinksFromText("See https://x.com/a. Or (https://y.com/b), then https://z.com!", "loc").map((l) => l.value);
    expect(values).toEqual(["https://x.com/a", "https://y.com/b", "https://z.com"]);
  });
});

describe("aborts", () => {
  it("throw an AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(registry.parse({ location: "/virtual/a.md", type: "markdown", input: "# A" }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("parser fallback with one-shot input", () => {
  it("gives the next parser the full input after one consumed a stream and threw", async () => {
    const reg = new ResourceRegistry().registerSlicer(textSlicer);
    const reader = (id: string, priority: number, fail: boolean): ResourceParser => ({
      id,
      priority,
      supportedTypes: ["once"],
      defaultSlicer: "text",
      async parse(source) {
        const text = Buffer.from(await collectInput(source.input)).toString("utf8");
        if (fail) throw new Error("nope");
        const resource = createParsedResource(source);
        resource.parts.push({ id: "p", location: `${source.location}#part/0`, kind: "text", text });
        return resource;
      },
    });
    reg.registerParser(reader("low", 0, false)).registerParser(reader("high", 10, true));
    const { resource } = await reg.parse({ location: "/virtual/x.once", type: "once", input: Readable.from(["hello ", "world"]) });
    expect(resource.parts[0].text).toBe("hello world");
  });
});

describe("pdf parsing from non-file sources", () => {
  it("extracts text from an in-memory PDF", async () => {
    if (!(await registry.isTypeSupported("pdf"))) return;
    const { resource } = await registry.parse({ location: "/virtual/missing.pdf", type: "pdf", input: makePdf("Hello PDF") });
    expect(resource.parts[0].text).toContain("Hello PDF");
  });

  it("renders an in-memory PDF via a temp file, keeps page bytes, and deletes temp folders", async () => {
    const seen: { pdfIsFile?: boolean; outputDir?: string } = {};
    const render: RenderPdfPagesFn = async (pdfFilePath, outputDir) => {
      seen.pdfIsFile = (await stat(pdfFilePath)).isFile();
      seen.outputDir = outputDir;
      const filePath = path.join(outputDir, "page-1.png");
      await writeFile(filePath, Buffer.from([1, 2, 3]));
      return [{ filePath, pageNumber: 1, mimeType: "image/png" }];
    };
    const { resource } = await registry.parse(
      { location: "https://example.com/doc.pdf", type: "pdf", input: makePdf("x") },
      { renderPdfPages: render, pdf: { renderPages: true, transcribePages: true }, transcribeImage: async () => "Page one" },
    );
    expect(seen.pdfIsFile).toBe(true);
    expect(resource.parts.map((part) => part.text)).toEqual(["Page one"]);
    const image = resource.children![0].parts[0];
    expect(Array.from(image.data ?? [])).toEqual([1, 2, 3]);
    expect(existsSync(seen.outputDir!)).toBe(false);
  });

  it("keeps rendered pages in pageOutputDir when given", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pages-"));
    try {
      const render: RenderPdfPagesFn = async (_pdf, outputDir) => {
        const filePath = path.join(outputDir, "page-1.png");
        await writeFile(filePath, Buffer.from([9]));
        return [{ filePath, pageNumber: 1, mimeType: "image/png" }];
      };
      const { resource } = await registry.parse(
        { location: "/virtual/doc.pdf", type: "pdf", input: makePdf("x") },
        { renderPdfPages: render, pdf: { renderPages: true, transcribePages: true, pageOutputDir: dir }, transcribeImage: async () => "Kept" },
      );
      expect(await readdir(dir)).toEqual(["page-1.png"]);
      expect(resource.children![0].parts[0].metadata?.filePath).toBe(path.join(dir, "page-1.png"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("zip parsing from non-file sources", () => {
  it("parses an in-memory zip and follows links between its entries", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("index.md", "# Index\n[next](./next.md)");
    zip.file("next.md", "# Next");
    const buffer = await zip.generateAsync({ type: "uint8array" });

    const source = { location: "/virtual/memory-bundle.zip", type: "zip", input: buffer };
    const { resource } = await registry.parse(source);
    expect(resource.children?.map((child) => child.name).sort()).toEqual(["index.md", "next.md"]);

    const graph = await buildResourceGraph(registry, source);
    const index = [...graph.nodes.values()].find((node) => node.resource.name === "index.md")!;
    expect(index.edges[0]).toMatchObject({ loaded: true });
  });
});

describe("url resolver limits", () => {
  it("rejects responses over maxBytes", async () => {
    await withServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("x".repeat(5000));
    }, async (port) => {
      await expect(registry.parse(`http://127.0.0.1:${port}/big.txt`, { maxBytes: 100 })).rejects.toThrow(/limit/);
    });
  });

  it("times out slow responses", async () => {
    await withServer(() => {
      // Never respond.
    }, async (port) => {
      await expect(registry.parse(`http://127.0.0.1:${port}/slow.txt`, { timeoutMs: 200 })).rejects.toThrow();
    });
  });
});

describe("graph safety defaults", () => {
  it("does not follow external links unless asked, and caps size by default", async () => {
    expect(DEFAULT_GRAPH_MAX_RESOURCES).toBe(1000);
    const graph = await buildResourceGraph(registry, { location: "/virtual/root.md", type: "markdown", input: "[x](https://example.com/x)" });
    expect(graph.nodes.size).toBe(1);
    expect([...graph.nodes.values()][0].edges[0].reason).toBe("external");
  });

  it("keeps web crawls on the same origin", async () => {
    await withServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/index.html") {
        const port = (req.socket.localPort ?? 0);
        res.end(`<a href="http://127.0.0.1:${port}/same.html">same</a><a href="http://localhost:${port}/other.html">other</a>`);
      } else {
        res.end("<p>leaf</p>");
      }
    }, async (port) => {
      const root = `http://127.0.0.1:${port}/index.html`;
      const reasonFor = (graph: Awaited<ReturnType<typeof buildResourceGraph>>, needle: string) =>
        graph.nodes.get(root)!.edges.find((edge) => edge.link.value.includes(needle));

      const byDefault = await buildResourceGraph(registry, root);
      expect(reasonFor(byDefault, "same.html")?.loaded).toBe(true);
      expect(reasonFor(byDefault, "other.html")?.reason).toBe("external");

      const external = await buildResourceGraph(registry, root, { followExternal: true });
      expect(reasonFor(external, "other.html")?.reason).toBe("cross-origin");

      const anywhere = await buildResourceGraph(registry, root, { followExternal: true, sameOrigin: false });
      expect(reasonFor(anywhere, "other.html")?.loaded).toBe(true);
    });
  });
});

describe("graph concurrency", () => {
  function memRegistry(delayMs: number) {
    const stats = { active: 0, maxActive: 0, parses: new Map<string, number>() };
    const docs: Record<string, string> = {
      "mem:root": "mem:a mem:b mem:c mem:d mem:e mem:f",
      "mem:a": "mem:deep",
      "mem:b": "mem:deep",
    };
    const resolver: ResourceResolver = {
      id: "mem",
      canResolve: (link) => link.startsWith("mem:"),
      async resolve(link) {
        return { location: link, type: "mem", input: docs[link] ?? "" };
      },
      async stat(link) {
        return { location: link };
      },
    };
    const parser: ResourceParser = {
      id: "mem-parser",
      supportedTypes: ["mem"],
      defaultSlicer: "text",
      async parse(source) {
        stats.active++;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        stats.parses.set(source.location, (stats.parses.get(source.location) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        stats.active--;
        const resource = createParsedResource(source);
        const text = String(source.input);
        resource.links = text.split(/\s+/).filter(Boolean).map((value, index) => ({
          id: `${source.location}::${index}`,
          value,
          location: source.location,
          kind: "resource" as const,
        }));
        return resource;
      },
    };
    const reg = new ResourceRegistry().registerResolver(resolver).registerParser(parser).registerSlicer(textSlicer);
    return { reg, stats };
  }

  it("loads link targets concurrently, once each, with true BFS depths", async () => {
    const { reg, stats } = memRegistry(30);
    const graph = await buildResourceGraph(reg, "mem:root", { concurrency: 3 });
    expect(graph.nodes.size).toBe(8);
    expect(stats.maxActive).toBeGreaterThan(1);
    expect(stats.maxActive).toBeLessThanOrEqual(3);
    expect([...stats.parses.values()].every((count) => count === 1)).toBe(true);
    expect(graph.nodes.get("mem:deep")!.depth).toBe(2);
    expect(graph.nodes.get("mem:deep")!.parents.sort()).toEqual(["mem:a", "mem:b"]);
    // Edges stay in link order.
    expect(graph.nodes.get("mem:root")!.edges.map((edge) => edge.link.value)).toEqual(
      ["mem:a", "mem:b", "mem:c", "mem:d", "mem:e", "mem:f"],
    );
  });

  it("never exceeds maxResources while loading concurrently", async () => {
    const { reg } = memRegistry(10);
    const graph = await buildResourceGraph(reg, "mem:root", { concurrency: 8, maxResources: 4 });
    expect(graph.nodes.size).toBe(4);
  });
});

describe("summaries", () => {
  const doc = "# One\n\nFirst section text.\n\n# Two\n\nSecond section text.\n";

  it("adds resource and section summaries to slices and caches them", async () => {
    const calls: SummaryRequest[] = [];
    const summarize = async (request: SummaryRequest) => {
      calls.push(request);
      return request.scope === "resource" ? "About numbers." : `About ${request.headings?.join("/")}.`;
    };
    const { resource, slices } = await registry.load(
      { location: "/virtual/sum.md", type: "markdown", input: doc },
      { summarize, summaryScope: "both" },
    );
    expect(calls.map((call) => call.scope).sort()).toEqual(["resource", "section", "section"]);
    expect(slices[0].context).toMatchObject({ summary: "About numbers.", sectionSummary: "About One." });
    expect(slices[1].embedText).toContain("Summary: About numbers.");
    expect(slices[1].embedText).toContain("Section summary: About Two.");

    // Slicing again reuses the cached summaries.
    await registry.slice(resource, { summarize, summaryScope: "both" });
    expect(calls.length).toBe(3);
  });

  it("summarizes only the resource by default and skips sections that equal the resource", async () => {
    const calls: string[] = [];
    const summarize = async (request: SummaryRequest) => {
      calls.push(request.scope);
      return "S";
    };
    await registry.load({ location: "/virtual/one.txt", type: "text", input: "Just one part." }, { summarize, summaryScope: "both" });
    expect(calls).toEqual(["resource"]);

    calls.length = 0;
    await registry.load({ location: "/virtual/sum2.md", type: "markdown", input: doc }, { summarize });
    expect(calls).toEqual(["resource"]);
  });
});
