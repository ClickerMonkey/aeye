import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { ResourceRegistry } from "../registry";
import { createDefaultResourceRegistry } from "../default";
import type { ResourceParser, ResourceSlicer } from "../types";

const registry = createDefaultResourceRegistry();

describe("default resource registry", () => {
  it("reports support for built-in types", async () => {
    await expect(registry.isTypeSupported("markdown")).resolves.toBe(true);
    await expect(registry.isTypeSupported("typescript")).resolves.toBe(true);
    await expect(registry.isTypeSupported("image")).resolves.toBe(true);
    await expect(registry.isTypeSupported("pdf")).resolves.toBe(false);
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
});
