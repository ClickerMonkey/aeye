import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { ResourceRegistry } from "../registry";
import { createDefaultResourceRegistry } from "../default";
import { createPopplerRenderer, isPopplerAvailable, orderRenderedPages } from "../renderers";
import { buildResourceGraph } from "../graph";
import { createLangchainSegmenter, defaultTextSegmenter, isLangchainSplittersAvailable } from "../segmenters";
import { buildZipEntryLocation, inferLocationScheme, isSelfContainedLocation, resolveZipEntryName } from "../utils";
import type { ParsedResource, ResourceParser, ResourceSlicer } from "../types";

const registry = createDefaultResourceRegistry();

describe("default resource registry", () => {
  it("reports support for built-in types", async () => {
    await expect(registry.isTypeSupported("markdown")).resolves.toBe(true);
    await expect(registry.isTypeSupported("typescript")).resolves.toBe(true);
    await expect(registry.isTypeSupported("image")).resolves.toBe(true);
    // pdf/excel/docx support depends on optional peer deps being installed
    const pdfSupported = await registry.isTypeSupported("pdf");
    expect(typeof pdfSupported).toBe("boolean");
  });

  it("parses and slices markdown with heading context and preserved text", async () => {
    const source = {
      location: "/virtual/readme.md",
      type: "markdown",
      input: "# Intro\n\nHello world.\n\n## Details\n\nVisit [docs](./docs.md)."
    };

    const { resource, slices } = await registry.load(source, { maxChars: 32, minChars: 10 });

    expect(resource.defaultSlicer).toBe("markdown");
    expect(slices.map((slice) => slice.text).join("")).toBe(resource.parts[0].text);
    expect(slices.some((slice) => slice.embedText.includes("Headings: Intro > Details"))).toBe(true);
    expect(resource.links.map((link) => link.value)).toContain("./docs.md");
  });

  it("parses and slices code with import links and declaration context", async () => {
    const source = {
      location: "/virtual/example.ts",
      type: "typescript",
      input: "import { thing } from './dep';\n\nexport function greet(name: string) {\n  return `hi ${name}`;\n}\n"
    };

    const { slices } = await registry.load(source, { maxChars: 80, minChars: 20 });

    expect(slices.length).toBeGreaterThan(0);
    expect(slices[0].embedText).toContain("Declaration: export function greet");
    expect(slices[0].links.map((link) => link.value)).toContain("./dep");
  });

  it("extracts href/src references from svg markup", async () => {
    const source = {
      location: "/virtual/diagram.svg",
      type: "svg",
      input: "<svg xmlns=\"http://www.w3.org/2000/svg\"><image href=\"./logo.png\"/><a href=\"https://example.com\"><text>x</text></a></svg>"
    };

    const { resource } = await registry.parse(source);
    const values = resource.links.map((link) => link.value);
    // The relative href is only discoverable via tag/attribute extraction (not the plain-URL scraper).
    expect(values).toContain("./logo.png");
    expect(values).toContain("https://example.com");
    const logo = resource.links.find((link) => link.value === "./logo.png");
    expect(logo?.kind).toBe("resource");
  });

  it("resolves relative file links", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "resources-"));
    const root = path.join(tempDir, "root.md");
    const child = path.join(tempDir, "child.md");

    try {
      await writeFile(root, "# Root\n\nSee [child](./child.md)");
      await writeFile(child, "# Child\n\nHello");

      const rootLoaded = await registry.load(root, { maxChars: 80, minChars: 10 });
      const childLoaded = await registry.load(rootLoaded.resource.links[0].value, {
        baseLocation: rootLoaded.source.location,
        maxChars: 80,
        minChars: 10
      });

      expect(childLoaded.source.location).toBe(child);
      expect(childLoaded.resource.type).toBe("markdown");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves relative and root-relative links against a URL base", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/docs/index.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<p>See <a href=\"page2.html\">two</a> and <a href=\"/root.html\">root</a></p>");
      } else if (req.url === "/docs/page2.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<h1>Page Two</h1>");
      } else if (req.url === "/root.html") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end("<h1>Root</h1>");
      } else {
        res.statusCode = 404;
        res.end("not found");
      }
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine test server port");
    }

    const base = `http://127.0.0.1:${address.port}/docs/index.html`;

    try {
      const root = await registry.load(base, { maxChars: 120, minChars: 20 });
      const values = root.resource.links.map((link) => link.value);
      expect(values).toContain("page2.html");
      expect(values).toContain("/root.html");

      // Relative link resolves against the directory of the URL base.
      const page2 = await registry.load("page2.html", { baseLocation: base, maxChars: 120, minChars: 20 });
      expect(page2.source.location).toBe(`http://127.0.0.1:${address.port}/docs/page2.html`);
      expect(page2.resource.parts[0].text).toContain("# Page Two");

      // Root-relative link resolves against the URL host.
      const rootLink = await registry.load("/root.html", { baseLocation: base, maxChars: 120, minChars: 20 });
      expect(rootLink.source.location).toBe(`http://127.0.0.1:${address.port}/root.html`);
      expect(rootLink.resource.parts[0].text).toContain("# Root");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("resolves url resources using the default registry", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<h1>Home</h1><p>Visit <a href=\"/next\">next</a></p>");
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine test server port");
    }

    const url = `http://127.0.0.1:${address.port}/index.html`;

    try {
      const loaded = await registry.load(url, { maxChars: 120, minChars: 20 });
      expect(loaded.resource.type).toBe("html");
      expect(loaded.resource.parts[0].text).toContain("# Home");
      expect(loaded.resource.links.map((link) => link.value)).toContain("/next");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("resource registry extensibility", () => {
  it("allows registering custom parsers and slicers", async () => {
    const customRegistry = new ResourceRegistry();

    const parser: ResourceParser = {
      id: "custom-parser",
      supportedTypes: ["custom"],
      defaultSlicer: "custom-slicer",
      async parse(source) {
        return {
          id: `${source.location}::custom`,
          location: source.location,
          type: "custom",
          name: source.name ?? "custom",
          defaultSlicer: "custom-slicer",
          parts: [
            {
              id: `${source.location}::part/0`,
              location: `${source.location}#part/0`,
              kind: "text",
              text: String(source.input)
            }
          ],
          links: []
        };
      }
    };

    const slicer: ResourceSlicer = {
      id: "custom-slicer",
      supportedTypes: ["custom"],
      async slice(resource) {
        return [
          {
            id: `${resource.id}::slice/0`,
            resourceId: resource.id,
            partId: resource.parts[0].id,
            location: `${resource.parts[0].location}#slice/0`,
            text: resource.parts[0].text ?? "",
            embedText: `Custom: ${resource.parts[0].text ?? ""}`,
            start: 0,
            end: (resource.parts[0].text ?? "").length,
            links: []
          }
        ];
      }
    };

    customRegistry.registerParser(parser).registerSlicer(slicer);
    const loaded = await customRegistry.load({ location: "/virtual/custom.txt", type: "custom", input: "hello" });

    expect(loaded.slices[0].embedText).toBe("Custom: hello");
    await expect(customRegistry.isTypeSupported("custom")).resolves.toBe(true);
  });

  it("stacks parsers and falls back when a higher-priority parser declines or throws", async () => {
    const registry = new ResourceRegistry();
    const calls: string[] = [];

    const makeParser = (id: string, priority: number, behavior: "decline" | "throw" | "ok"): ResourceParser => ({
      id,
      supportedTypes: ["stack"],
      defaultSlicer: "text",
      priority,
      async parse(source) {
        calls.push(id);
        if (behavior === "decline") return undefined;
        if (behavior === "throw") throw new Error(`${id} failed`);
        return {
          id: `${source.location}::${id}`,
          location: source.location,
          type: "stack",
          name: id,
          defaultSlicer: "text",
          parts: [{ id: `${source.location}#part/0`, location: `${source.location}#part/0`, kind: "text", text: id }],
          links: []
        };
      }
    });

    registry
      .registerParser(makeParser("low", 0, "ok"))
      .registerParser(makeParser("high", 10, "throw"))
      .registerParser(makeParser("mid", 5, "decline"));

    const { resource } = await registry.parse({ location: "/virtual/x.stack", type: "stack", input: "" });

    // Attempted highest-first: high (throws) -> mid (declines) -> low (succeeds).
    expect(calls).toEqual(["high", "mid", "low"]);
    expect(resource.parts[0].text).toBe("low");
  });

  it("lets a later-registered parser of equal priority override an earlier one", async () => {
    const registry = new ResourceRegistry();

    const makeParser = (id: string): ResourceParser => ({
      id,
      supportedTypes: ["dup"],
      defaultSlicer: "text",
      async parse(source) {
        return {
          id: `${source.location}::${id}`,
          location: source.location,
          type: "dup",
          name: id,
          defaultSlicer: "text",
          parts: [{ id: `${source.location}#part/0`, location: `${source.location}#part/0`, kind: "text", text: id }],
          links: []
        };
      }
    });

    registry.registerParser(makeParser("first")).registerParser(makeParser("second"));
    const { resource } = await registry.parse({ location: "/virtual/x.dup", type: "dup", input: "" });

    // Same priority — the most recently registered parser wins.
    expect(resource.parts[0].text).toBe("second");
  });

  it("applies per-type config registered on the registry under per-call options", async () => {
    const registry = new ResourceRegistry();
    let observed: { dpi?: number; render?: boolean } = {};

    const parser: ResourceParser = {
      id: "config-parser",
      supportedTypes: ["cfg"],
      defaultSlicer: "text",
      async parse(source, context) {
        observed = { dpi: context.options.pdf?.renderDpi, render: context.options.pdf?.renderPages };
        return {
          id: `${source.location}::cfg`,
          location: source.location,
          type: "cfg",
          name: "cfg",
          defaultSlicer: "text",
          parts: [{ id: `${source.location}#part/0`, location: `${source.location}#part/0`, kind: "text", text: "cfg" }],
          links: []
        };
      }
    };

    registry.registerParser(parser);
    registry.configureType("cfg", { pdf: { renderPages: true, renderDpi: 150 } });

    // Registry config provides defaults; per-call options override individual fields (shallow-merged).
    await registry.parse({ location: "/virtual/x.cfg", type: "cfg", input: "" }, { pdf: { renderDpi: 300 } });

    expect(observed).toEqual({ render: true, dpi: 300 });
    expect(registry.getTypeConfig("cfg")).toEqual({ pdf: { renderPages: true, renderDpi: 150 } });
  });
});

describe("poppler renderer", () => {
  it("orders rendered page files numerically and ignores non-matching files", () => {
    const pages = orderRenderedPages(
      ["page-10.png", "page-2.png", "page-1.png", "notes.txt", "page-1.jpg"],
      "/out"
    );

    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 10]);
    expect(pages.map((p) => p.filePath)).toEqual([
      path.join("/out", "page-1.png"),
      path.join("/out", "page-2.png"),
      path.join("/out", "page-10.png"),
    ]);
    expect(pages.every((p) => p.mimeType === "image/png")).toBe(true);
  });

  it("honors the requested image format", () => {
    const pages = orderRenderedPages(["page-1.jpg", "page-2.jpg"], "/out", "jpeg");
    expect(pages.map((p) => p.mimeType)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
  });

  it("exposes a render factory and availability check", async () => {
    expect(typeof createPopplerRenderer()).toBe("function");
    await expect(isPopplerAvailable()).resolves.toEqual(expect.any(Boolean));
  });
});

describe("resource graph", () => {
  it("builds a de-duplicated graph across cyclic links with modified times", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graph-"));
    try {
      await writeFile(path.join(dir, "a.md"), "# A\n[b](./b.md) and [ext](https://example.com/x)");
      await writeFile(path.join(dir, "b.md"), "# B\n[back to a](./a.md) and [c](./c.md)");
      await writeFile(path.join(dir, "c.md"), "# C\nleaf");

      const graph = await buildResourceGraph(registry, path.join(dir, "a.md"), { followExternal: false });

      // a, b, c — the cycle (a -> b -> a) does not cause re-loading or infinite traversal.
      expect(graph.nodes.size).toBe(3);
      expect(graph.roots).toEqual([path.join(dir, "a.md")]);

      const a = graph.nodes.get(path.join(dir, "a.md"))!;
      const b = graph.nodes.get(path.join(dir, "b.md"))!;
      const c = graph.nodes.get(path.join(dir, "c.md"))!;

      // Every node carries an estimated edit time from the file system.
      expect(typeof a.modifiedAt).toBe("number");
      expect(typeof c.modifiedAt).toBe("number");

      // a -> b is loaded; a -> external is skipped because followExternal is false.
      const externalEdge = a.edges.find((edge) => edge.link.value === "https://example.com/x");
      expect(externalEdge?.loaded).toBe(false);
      expect(externalEdge?.reason).toBe("external");

      // b links back to a (already loaded) and forward to c.
      expect(b.edges.find((edge) => edge.targetLocation === a.location)?.loaded).toBe(true);
      expect(b.children).toEqual([]);
      expect(a.parents).toContain(b.location); // discovered via the back-link
      expect(c.parents).toContain(b.location);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects maxResources and supports incremental reuse via getCached", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "graph-inc-"));
    try {
      await writeFile(path.join(dir, "a.md"), "# A\n[b](./b.md)");
      await writeFile(path.join(dir, "b.md"), "# B\n[c](./c.md)");
      await writeFile(path.join(dir, "c.md"), "# C\nleaf");

      const first = await buildResourceGraph(registry, path.join(dir, "a.md"));
      expect(first.nodes.size).toBe(3);

      // Incremental rebuild: treat everything as unchanged, reusing cached resources for link targets.
      const cache = new Map<string, ParsedResource>();
      for (const node of first.nodes.values()) cache.set(node.location, node.resource);

      const reusedLocations: string[] = [];
      const second = await buildResourceGraph(registry, path.join(dir, "a.md"), {
        shouldLoad: () => false,
        getCached: (location) => cache.get(location),
      });
      for (const node of second.nodes.values()) if (node.reused) reusedLocations.push(node.location);

      expect(second.nodes.size).toBe(3);
      // The root always parses fresh; b and c are reused from cache.
      expect(second.nodes.get(path.join(dir, "a.md"))!.reused).toBe(false);
      expect(reusedLocations.sort()).toEqual([path.join(dir, "b.md"), path.join(dir, "c.md")].sort());

      // maxResources caps how many nodes are loaded.
      const capped = await buildResourceGraph(registry, path.join(dir, "a.md"), { maxResources: 2 });
      expect(capped.nodes.size).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("parses zip entries into child resources with links and modified times", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("doc.md", "# Doc\nSee [other](./other.md) and https://example.com/z");
    zip.file("notes.txt", "plain notes");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const dir = await mkdtemp(path.join(tmpdir(), "graph-zip-"));
    try {
      const zipPath = path.join(dir, "bundle.zip");
      await writeFile(zipPath, buffer);

      const { resource } = await registry.parse(zipPath);
      const docChild = resource.children?.find((child) => child.name === "doc.md");

      expect(docChild?.type).toBe("markdown");
      // The markdown entry was parsed through the registry, so its links are extracted.
      expect(docChild?.links.map((link) => link.value)).toEqual(
        expect.arrayContaining(["./other.md", "https://example.com/z"])
      );
      // Entry carries an estimated edit time from the zip metadata.
      expect(typeof docChild?.modifiedAt).toBe("number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("follows relative links between entries inside a zip", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("docs/index.md", "# Index\n[next](./page.md) and [img](../assets/logo.png)");
    zip.file("docs/page.md", "# Page\n[home](./index.md)");
    zip.file("assets/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const dir = await mkdtemp(path.join(tmpdir(), "zip-graph-"));
    try {
      const zipPath = path.join(dir, "site.zip");
      await writeFile(zipPath, buffer);

      const graph = await buildResourceGraph(registry, zipPath, { followExternal: false });

      const indexLoc = buildZipEntryLocation(zipPath, "docs/index.md");
      const pageLoc = buildZipEntryLocation(zipPath, "docs/page.md");
      const logoLoc = buildZipEntryLocation(zipPath, "assets/logo.png");

      // All entries became nodes; the cross-entry relative links resolved to the existing entry nodes.
      expect(graph.nodes.has(indexLoc)).toBe(true);
      expect(graph.nodes.has(pageLoc)).toBe(true);
      expect(graph.nodes.has(logoLoc)).toBe(true);

      const index = graph.nodes.get(indexLoc)!;
      const nextEdge = index.edges.find((edge) => edge.link.value === "./page.md");
      const imgEdge = index.edges.find((edge) => edge.link.value === "../assets/logo.png");
      expect(nextEdge?.loaded).toBe(true);
      expect(nextEdge?.targetLocation).toBe(pageLoc);
      expect(imgEdge?.loaded).toBe(true);
      expect(imgEdge?.targetLocation).toBe(logoLoc);

      // The back-link from page.md connects to the already-loaded index entry (no duplication).
      const page = graph.nodes.get(pageLoc)!;
      expect(page.edges.find((edge) => edge.link.value === "./index.md")?.targetLocation).toBe(indexLoc);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a zip entry directly from its self-contained location", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("readme.md", "# Readme\nhello");
    const buffer = await zip.generateAsync({ type: "nodebuffer" });

    const dir = await mkdtemp(path.join(tmpdir(), "zip-locate-"));
    try {
      const zipPath = path.join(dir, "pkg.zip");
      await writeFile(zipPath, buffer);

      const entryLocation = buildZipEntryLocation(zipPath, "readme.md");
      const source = await registry.locate(entryLocation);
      expect(source.location).toBe(entryLocation);

      const { resource } = await registry.parse(entryLocation);
      expect(resource.type).toBe("markdown");
      expect(resource.parts[0].text).toContain("# Readme");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dynamic type & format configuration", () => {
  it("infers types from registry-registered extensions and mime patterns", () => {
    const r = createDefaultResourceRegistry();
    r.registerType({ type: "notebook", extensions: ["ipynb"], mimePatterns: [/^application\/x-ipynb\+json/i] });

    expect(r.inferType("/x/analysis.ipynb")).toBe("notebook");
    expect(r.inferType("/x/whatever", "application/x-ipynb+json")).toBe("notebook");
    // Built-in detection still works and does not leak into other registries.
    expect(r.inferType("/x/a.md")).toBe("markdown");
    expect(createDefaultResourceRegistry().inferType("/x/analysis.ipynb")).toBeUndefined();
  });

  it("infers compound extensions like .tar.gz", () => {
    const r = createDefaultResourceRegistry();
    expect(r.inferType("/x/archive.tar.gz")).toBe("zip");
    expect(r.inferType("/x/component.test.ts")).toBe("typescript");
  });

  it("applies per-type slice options configured on the registry", async () => {
    const r = createDefaultResourceRegistry();
    r.configureType("markdown", { maxChars: 24, minChars: 4 });

    const text = "# Title\n\n" + "word ".repeat(40);
    const { slices } = await r.load({ location: "/v/doc.md", type: "markdown", input: text });

    // Tight maxChars from registry config forces many small slices without passing options per call.
    expect(slices.length).toBeGreaterThan(3);
    expect(slices.every((slice) => slice.text.length <= 60)).toBe(true);
  });
});

describe("pluggable text segmenters", () => {
  it("defaults to the lossless, offset-exact segmenter", async () => {
    const segments = await defaultTextSegmenter("a".repeat(50) + "\n\n" + "b".repeat(50), { maxChars: 40, minChars: 10 });
    const text = "a".repeat(50) + "\n\n" + "b".repeat(50);
    // Contiguous, non-overlapping, reproduces the input exactly.
    expect(segments.map((s) => s.text).join("")).toBe(text);
    segments.forEach((s) => expect(text.slice(s.start, s.end)).toBe(s.text));
  });

  it("exposes a LangChain segmenter factory and availability check", async () => {
    expect(typeof createLangchainSegmenter()).toBe("function");
    await expect(isLangchainSplittersAvailable()).resolves.toEqual(expect.any(Boolean));
  });

  it("slices with a registry-configured LangChain segmenter (overlap + recovered offsets)", async () => {
    const r = createDefaultResourceRegistry();
    const body = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} has a few words.`).join(" ");
    const text = `# Title\n\n${body}`;

    r.configureType("markdown", {
      segmenter: createLangchainSegmenter({ chunkSize: 80, chunkOverlap: 25 }),
    });

    const { resource, slices } = await r.load({ location: "/v/doc.md", type: "markdown", input: text });
    const partText = resource.parts[0].text!;

    expect(slices.length).toBeGreaterThan(1);
    // Recovered offsets are exact: the recorded span reproduces the slice text.
    for (const slice of slices) {
      expect(partText.slice(slice.start, slice.end)).toBe(slice.text);
    }
    // Overlap means the concatenation is longer than the original (round-trip relaxed, as designed).
    expect(slices.map((s) => s.text).join("").length).toBeGreaterThan(partText.length);
  });

  it("supports token-based sizing when tiktoken is available", async () => {
    const segmenter = createLangchainSegmenter({ mode: "token", chunkSize: 16, chunkOverlap: 4 });
    let segments;
    try {
      segments = await segmenter("alpha beta gamma delta ".repeat(20), { maxChars: 100, minChars: 10 });
    } catch {
      return; // tiktoken encoding unavailable in this environment; skip
    }
    expect(segments.length).toBeGreaterThan(1);
  });
});

describe("resource location classification", () => {
  it("classifies how each location should be fetched", () => {
    expect(inferLocationScheme("https://example.com/a")).toBe("url");
    expect(inferLocationScheme(path.resolve("/abs/file.md"))).toBe("file");
    expect(inferLocationScheme("file:///abs/file.md")).toBe("file");
    expect(inferLocationScheme(buildZipEntryLocation(path.resolve("/abs/b.zip"), "x.md"))).toBe("zip-entry");
    expect(inferLocationScheme("./relative.md")).toBe("relative");
    // A zip whose archive path is itself relative is not self-contained.
    expect(inferLocationScheme(buildZipEntryLocation("rel/b.zip", "x.md"))).toBe("relative");
  });

  it("knows which locations can be fetched without a base, and rejects relative ones", async () => {
    expect(isSelfContainedLocation("https://example.com")).toBe(true);
    expect(isSelfContainedLocation("./relative.md")).toBe(false);
    await expect(registry.locate("./relative.md")).rejects.toThrow(/not self-contained/);
  });

  it("resolves entry names relative to a base entry", () => {
    expect(resolveZipEntryName("docs/index.md", "./page.md")).toBe("docs/page.md");
    expect(resolveZipEntryName("docs/index.md", "../assets/logo.png")).toBe("assets/logo.png");
    expect(resolveZipEntryName("docs/index.md", "/root.md")).toBe("root.md");
    expect(resolveZipEntryName("docs/index.md", "./page.md#section")).toBe("docs/page.md");
  });
});
