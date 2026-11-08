import { describe, expect, it } from "@jest/globals";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDefaultResourceRegistry } from "../default.js";
import { buildResourceGraph } from "../graph.js";
import { diskIsFile, importCandidates, isRelativeSpecifier, isScriptType, resolveImportPath } from "../imports.js";
import { ROOT_SECTION_KEY, sectionKeys } from "../section-keys.js";
import { CODE_DECLARATION_PATTERNS, declarationName, splitCodeBlocks } from "../slicers/code.js";
import { splitMarkdownSections } from "../slicers/markdown.js";

const registry = createDefaultResourceRegistry();

describe("section keys", () => {
  it("joins paths, names the root and numbers repeats", () => {
    expect(sectionKeys([[], ["A"], ["A", "B"], ["A"], ["A"]])).toEqual([ROOT_SECTION_KEY, "A", "A > B", "A ~2", "A ~3"]);
  });
});

describe("markdown section keys", () => {
  it("come from the heading path and survive content moving", () => {
    const before = splitMarkdownSections("# A\none\n# B\ntwo\n").map((s) => s.key);
    const after = splitMarkdownSections("new intro\n# B\ntwo, longer\n# A\none\n").map((s) => s.key);
    expect(before).toEqual(["A", "B"]);
    expect(after).toEqual([ROOT_SECTION_KEY, "B", "A"]);
  });

  it("key nested and repeated headings, ignoring fenced ones", () => {
    const text = "intro\n# Guide\nhello\n```\n# not a heading\n```\n## Usage\nrun it\n# Guide\nagain\n";
    expect(splitMarkdownSections(text).map((s) => [s.key, text.slice(s.start, s.end)])).toEqual([
      [ROOT_SECTION_KEY, "intro\n"],
      ["Guide", "# Guide\nhello\n```\n# not a heading\n```\n"],
      ["Guide > Usage", "## Usage\nrun it\n"],
      ["Guide ~2", "# Guide\nagain\n"],
    ]);
  });

  it("make the markdown slicer's section ids stable", async () => {
    const ids = async (input: string) =>
      (await registry.load({ location: "/virtual/guide.md", type: "markdown", input }, { maxChars: 2000 })).slices.map((s) => s.sectionId);
    const first = await ids("# Setup\nA.\n## Usage\nB.\n");
    const second = await ids("Preface.\n\n# Setup\nA, longer.\n## Usage\nB.\n");
    expect(second.slice(1)).toEqual(first);
    expect(first[1]).toMatch(/#section\/Setup > Usage$/);
  });
});

describe("code block keys", () => {
  it("come from declared names, with the preamble at the root", () => {
    const text = "import x from 'x';\n\n/** Reads. */\nexport function read() {\n  return 1;\n}\nclass Store {}\nexport const LIMIT = 3;\nexport default function () {}\n";
    const blocks = splitCodeBlocks(text, "typescript");
    expect(blocks.map((b) => b.key)).toEqual([ROOT_SECTION_KEY, "read", "Store", "LIMIT", "export default function () {}"]);
    expect(blocks.map((b) => b.name)).toEqual([undefined, "read", "Store", "LIMIT", undefined]);
    expect(text.slice(blocks[1].start, blocks[1].end).startsWith("/** Reads. */")).toBe(true);
  });

  it("names declarations across languages", () => {
    const name = (line: string, type: string) => declarationName(line, CODE_DECLARATION_PATTERNS[type]!, type);
    expect(name("def first():", "python")).toBe("first");
    expect(name("func (s *Server) Serve(w io.Writer) {", "go")).toBe("Serve");
    expect(name("impl<T> Store<T> {", "rust")).toBe("Store");
    expect(name("pub fn run() {", "rust")).toBe("run");
    expect(name("declare module \"x\" {", "typescript")).toBe("x");
    expect(name("deploy() {", "shell")).toBe("deploy");
    expect(name("function deploy {", "shell")).toBe("deploy");
    expect(name("CREATE TABLE IF NOT EXISTS users (", "sql")).toBe("users");
    expect(name("select 1;", "sql")).toBeUndefined();
    expect(declarationName("nothing here", /^class\b/)).toBeUndefined();
    expect(declarationName("class A", /class/g)).toBe("A");
  });

  it("keep a file with no declarations as one root block", () => {
    expect(splitCodeBlocks("x = 1\n", "python")).toEqual([{ start: 0, end: 6, path: [], key: ROOT_SECTION_KEY }]);
  });

  it("make the code slicer's section ids stable", async () => {
    const ids = async (input: string) =>
      new Set((await registry.load({ location: "/virtual/a.ts", type: "typescript", input }, { maxChars: 2000 })).slices.map((s) => s.sectionId));
    const first = await ids("export function a() {}\nexport function b() {}\n");
    const second = await ids("import y from 'y';\nexport function b() {}\nexport function a() { return 1; }\n");
    for (const id of first) {
      expect(second.has(id)).toBe(true);
    }
    expect([...first][0]).toMatch(/#block\/a$/);
  });
});

describe("import resolution", () => {
  it("lists candidates the way node and TypeScript try them", () => {
    const candidates = importCandidates("/w/src/c.js");
    expect(candidates.slice(0, 3)).toEqual(["/w/src/c.js", "/w/src/c.ts", "/w/src/c.tsx"]);
    expect(candidates).toContain("/w/src/c.js/index.ts");
    expect(importCandidates("/w/lib")).toContain("/w/lib/index.ts");
    expect(importCandidates(String.raw`C:\w\lib`)).toContain(String.raw`C:\w\lib\index.ts`);
  });

  it("tells relative specifiers and script types apart", () => {
    expect(["./a", "../a", "/a", ".", ".."].every(isRelativeSpecifier)).toBe(true);
    expect(["react", "node:fs", "@scope/pkg", ".hidden"].some(isRelativeSpecifier)).toBe(false);
    expect(isScriptType("tsx")).toBe(true);
    expect(isScriptType("markdown")).toBe(false);
    expect(isScriptType(undefined)).toBe(false);
  });

  it("resolves to the first candidate that is a file", async () => {
    const asked: string[] = [];
    const found = await resolveImportPath("/w/x", async (p) => {
      asked.push(p);
      return p.endsWith("/x.tsx");
    });
    expect(found).toBe("/w/x.tsx");
    expect(asked).toEqual(["/w/x", "/w/x.ts", "/w/x.tsx"]);
    expect(await resolveImportPath("/w/none", async () => false)).toBeUndefined();
  });

  it("checks files on disk by default: files only, never folders or missing paths", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "is-file-"));
    try {
      await mkdir(path.join(dir, "lib"));
      await writeFile(path.join(dir, "lib", "index.ts"), "export const lib = 1;\n");
      expect(await diskIsFile(path.join(dir, "lib", "index.ts"))).toBe(true);
      expect(await diskIsFile(path.join(dir, "lib"))).toBe(false);
      expect(await diskIsFile(path.join(dir, "missing.ts"))).toBe(false);
      expect(await resolveImportPath(path.join(dir, "lib"))).toBe(path.join(dir, "lib", "index.ts"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets the file resolver and the graph follow TS imports", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "imports-"));
    try {
      await mkdir(path.join(dir, "lib"));
      await writeFile(path.join(dir, "a.ts"), "import { b } from './b.js';\nimport { lib } from './lib';\nimport React from 'react';\nimport { gone } from './gone';\n");
      await writeFile(path.join(dir, "b.ts"), "export const b = 1;\n");
      await writeFile(path.join(dir, "lib", "index.ts"), "export const lib = 1;\n");
      await writeFile(path.join(dir, "notes.md"), "[guide](guide.md)\n");
      await writeFile(path.join(dir, "guide.md"), "# Guide\n");

      const from = { baseLocation: path.join(dir, "a.ts") };
      expect(await registry.canResolve("react", from)).toBe(false);
      expect((await registry.statLink("./b.js", from))?.location).toBe(path.join(dir, "b.ts"));
      expect((await registry.resolveLink("./lib", from)).location).toBe(path.join(dir, "lib", "index.ts"));
      expect(await registry.statLink("./gone", from)).toBeUndefined();
      await expect(registry.resolveLink("./gone", from)).rejects.toThrow();
      expect(await registry.canResolve("guide.md", { baseLocation: path.join(dir, "notes.md") })).toBe(true);

      const graph = await buildResourceGraph(registry, path.join(dir, "a.ts"), { followExternal: false });
      expect([...graph.nodes.keys()].sort()).toEqual([path.join(dir, "a.ts"), path.join(dir, "b.ts"), path.join(dir, "lib", "index.ts")].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
