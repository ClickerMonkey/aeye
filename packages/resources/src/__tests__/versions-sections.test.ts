import { describe, expect, it } from "@jest/globals";
import { ResourceRegistry } from "../registry";
import { ROOT_SECTION_KEY } from "../section-keys";
import { DEFAULT_VERSION_SECTIONERS, type VersionSectioner, sectionVersion } from "../sections";
import {
  PAGE_BREAK,
  RESOURCE_VERSION_KINDS,
  type ResourceVersion,
  columnKinds,
  resourceVersionSchema,
  tableRecords,
  tableToMarkdown,
  versionMimeType,
  versionText,
} from "../versions";

const tableVersion: ResourceVersion = {
  kind: "table",
  converter: "test",
  from: "excel",
  tables: [
    { name: "Sales", sheetName: "Sales", sheetIndex: 0, headers: ["Region", "Total"], rows: [["North", "10"], ["South", "12.5"]] },
    { name: "Sales - Table 2", sheetName: "Sales", sheetIndex: 0, headers: ["Note"], rows: [["ok"]] },
    { name: "Staff", sheetName: "Staff", sheetIndex: 1, headers: ["Name"], rows: [["Ann"]] },
  ],
};

describe("versions", () => {
  it("lists every kind and checks shapes with the schema", () => {
    expect(RESOURCE_VERSION_KINDS).toEqual(["markdown", "text", "code", "pages", "table"]);
    expect(resourceVersionSchema.parse(tableVersion)).toEqual(tableVersion);
    expect(resourceVersionSchema.safeParse({ kind: "pages", converter: "x", from: "pdf", pages: "nope" }).success).toBe(false);
    expect(resourceVersionSchema.safeParse({ kind: "video", converter: "x", from: "mp4" }).success).toBe(false);
  });

  it("works out text and mime types from the version", () => {
    expect(versionText({ kind: "pages", converter: "x", from: "pdf", pages: ["one", "two"] })).toBe(`one${PAGE_BREAK}two`);
    expect(versionText(tableVersion)).toBe(
      "## Sales\n\n| Region | Total |\n| --- | --- |\n| North | 10 |\n| South | 12.5 |\n\n## Sales - Table 2\n\n| Note |\n| --- |\n| ok |\n\n## Staff\n\n| Name |\n| --- |\n| Ann |",
    );
    expect(versionMimeType(tableVersion)).toBe("text/markdown");
    expect(versionMimeType({ kind: "code", converter: "x", from: "json", language: "json", text: "{}" })).toBe("application/json");
    expect(versionMimeType({ kind: "code", converter: "x", from: "x", language: "toml", text: "" })).toBe("text/plain");
  });

  it("writes markdown tables padded to the widest row, escaping cells", () => {
    expect(tableToMarkdown({ headers: ["a", ""], rows: [["x|y", "multi\nline", "extra"], []] })).toBe(
      "| a |   |   |\n| --- | --- | --- |\n| x\\|y | multi line | extra |\n|  |  |  |",
    );
  });

  it("types columns and records from their cells", () => {
    const table = {
      headers: ["n", "price", "ok", "when", "name", "", "n"],
      rows: [["1", "1,200.50", "yes", "2026-11-07", "Ann", "", "3"], ["2", "50%", "No", "2026-01-02T10:00:00Z", "Bo", "", "x"]],
    };
    expect(columnKinds(table)).toEqual(["integer", "number", "boolean", "date", "text", "empty", "text"]);
    expect(tableRecords(table)).toEqual([
      { n: 1, price: 1200.5, ok: true, when: "2026-11-07", name: "Ann", "column 6": null, "n 2": "3" },
      { n: 2, price: 0.5, ok: false, when: "2026-01-02T10:00:00Z", name: "Bo", "column 6": null, "n 2": "x" },
    ]);
  });
});

/** The text of each section of a version, by key. */
function sectionTexts(version: ResourceVersion): Array<[string, string]> {
  const text = versionText(version);
  return sectionVersion(version).map((section) => [section.key, text.slice(section.start, section.end)]);
}

/** Checks that a version's sections cover its text end to end, in order. */
function expectCovers(version: ResourceVersion): void {
  const sections = sectionVersion(version);
  expect(sections.map((section) => versionText(version).slice(section.start, section.end)).join("")).toBe(versionText(version));
}

describe("version sections", () => {
  it("cut markdown by heading path", () => {
    const version: ResourceVersion = { kind: "markdown", converter: "x", from: "html", text: "intro\n# A\none\n## B\ntwo\n# A\nthree" };
    expect(sectionTexts(version)).toEqual([[ROOT_SECTION_KEY, "intro\n"], ["A", "# A\none\n"], ["A > B", "## B\ntwo\n"], ["A ~2", "# A\nthree"]]);
    expectCovers(version);
  });

  it("cut pages by page number, each with its page break", () => {
    const version: ResourceVersion = { kind: "pages", converter: "x", from: "pdf", pages: ["one", "", "three"] };
    expect(sectionTexts(version)).toEqual([["Page 1", `one${PAGE_BREAK}`], ["Page 2", PAGE_BREAK], ["Page 3", "three"]]);
    expectCovers(version);
  });

  it("cut tables by sheet and table name", () => {
    expect(sectionVersion(tableVersion).map((section) => section.key)).toEqual(["Sales", "Sales > Sales - Table 2", "Staff"]);
    expectCovers(tableVersion);
    const unnamed: ResourceVersion = { kind: "table", converter: "x", from: "csv", tables: [{ headers: ["a"], rows: [] }, { headers: ["b"], rows: [] }] };
    expect(sectionVersion(unnamed).map((section) => section.key)).toEqual(["Table 1", "Table 2"]);
    expectCovers(unnamed);
  });

  it("cut json and yaml by top-level key, and other code whole", () => {
    const json: ResourceVersion = { kind: "code", converter: "x", from: "json", language: "json", text: JSON.stringify({ a: 1, "b\"q": { c: [1] } }, null, 2) };
    expect(sectionVersion(json).map((section) => section.key)).toEqual(["a", "b\\\"q"]);
    expectCovers(json);
    const yaml: ResourceVersion = { kind: "code", converter: "x", from: "yaml", language: "yaml", text: "name: x\nlist:\n  - a\n\"quoted: key\": 2\n" };
    expect(sectionVersion(yaml).map((section) => section.key)).toEqual(["name", "list", "quoted: key"]);
    expectCovers(yaml);
    const array: ResourceVersion = { kind: "code", converter: "x", from: "json", language: "json", text: "[\n  1\n]" };
    expect(sectionVersion(array).map((section) => section.key)).toEqual([ROOT_SECTION_KEY]);
  });

  it("keep text whole", () => {
    const version: ResourceVersion = { kind: "text", converter: "x", from: "text", title: "T", text: "hello" };
    expect(sectionVersion(version)).toEqual([{ key: ROOT_SECTION_KEY, path: [], title: "T", start: 0, end: 5 }]);
  });

  it("let a registry's sectioner override the defaults for what it supports", () => {
    const paragraphs: VersionSectioner = {
      id: "paragraphs",
      supports: (version) => version.kind === "text",
      sections: () => [{ key: "p", path: ["p"], title: "p", start: 0, end: 1 }],
    };
    const registry = new ResourceRegistry().registerSectioner(paragraphs);
    expect(registry.sectionVersion({ kind: "text", converter: "x", from: "text", text: "a" })[0]?.key).toBe("p");
    expect(registry.sectionVersion(tableVersion).map((section) => section.key)).toEqual(sectionVersion(tableVersion).map((section) => section.key));
    expect(DEFAULT_VERSION_SECTIONERS.at(-1)?.id).toBe("whole");
  });
});
