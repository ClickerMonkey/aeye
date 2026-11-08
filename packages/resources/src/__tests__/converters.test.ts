import { describe, expect, it } from "@jest/globals";
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { jsonConverter, yamlConverter } from "../converters/data";
import { docxConverter, htmlConverter } from "../converters/markup";
import { pdfConverter } from "../converters/pdf";
import { delimitedConverter, workbookConverter } from "../converters/tables";
import { createDefaultResourceRegistry } from "../default";
import { htmlParser } from "../parsers";
import { ResourceRegistry } from "../registry";
import { sectionVersion } from "../sections";
import { markdownSlicer, textSlicer } from "../slicers";
import { detectDelimiter, parseDelimited, tablesFromRows } from "../tables";
import type { ResourceConverter, ResourceSource } from "../types";
import { type ResourceVersion, versionText } from "../versions";

const registry = createDefaultResourceRegistry();

/** Converts in-memory content as a given type through the default registry. */
async function convert(type: string, input: string | Uint8Array, location = `/virtual/file.${type}`): Promise<ResourceVersion | undefined> {
  return registry.convertSource({ location, type, input, name: location.split("/").pop() });
}

/** Builds a pdf with one page per text. */
function makePdf(pages: string[]): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const kids: string[] = [];
  const font = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const page = 3 + i * 2;
    const content = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents ${page + 1} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
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

/** Builds a minimal word document whose body is the given WordprocessingML paragraphs. */
async function makeDocx(body: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

/** Builds a workbook from sheets of rows. */
function makeWorkbook(sheets: Record<string, string[][]>): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

describe("delimited text", () => {
  it("reads quoted fields, doubled quotes, line breaks in quotes, CRLF and a BOM", () => {
    expect(parseDelimited("\ufeffa,\"b,1\",\"say \"\"hi\"\"\"\r\n\"two\nlines\",,x\n", ",")).toEqual([["a", "b,1", "say \"hi\""], ["two\nlines", "", "x"]]);
    expect(parseDelimited("a\tb", "\t")).toEqual([["a", "b"]]);
  });

  it("detects the delimiter the lines use consistently", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a,b\n\"x;y\",2\n")).toBe(",");
    expect(detectDelimiter("a|b\n1|2\n")).toBe("|");
    expect(detectDelimiter("single")).toBe(",");
  });

  it("splits rows into tables at blank rows, trimming trailing empty cells", () => {
    expect(tablesFromRows([["h1", "h2", ""], ["1", "2"], ["", ""], ["k"], ["v"]], { name: "S", index: 0 })).toEqual([
      { name: "S", sheetName: "S", sheetIndex: 0, headers: ["h1", "h2"], rows: [["1", "2"]] },
      { name: "S - Table 2", sheetName: "S", sheetIndex: 0, headers: ["k"], rows: [["v"]] },
    ]);
  });
});

describe("converters", () => {
  it("turn csv and tsv into tables named after the file", async () => {
    expect(await convert("csv", "name;age\nAnn;3\n", "/data/people.csv")).toEqual({
      kind: "table", converter: delimitedConverter.id, from: "csv", metadata: { delimiter: ";" },
      tables: [{ name: "people.csv", headers: ["name", "age"], rows: [["Ann", "3"]] }],
    });
    const tsv = await convert("tsv", "a\tb\n1\t2");
    expect(tsv?.kind === "table" ? tsv.tables[0]?.rows : undefined).toEqual([["1", "2"]]);
  });

  it("turn workbooks into tables sheet by sheet", async () => {
    const version = await convert("excel", makeWorkbook({ Sales: [["Region", "Total"], ["North", "10"], [], ["Note"], ["ok"]], Empty: [], Staff: [["Name"], ["Ann"]] }));
    expect(version?.kind).toBe("table");
    if (version?.kind !== "table") return;
    expect(version.converter).toBe(workbookConverter.id);
    expect(version.tables.map((table) => [table.sheetName, table.sheetIndex, table.name, table.headers])).toEqual([
      ["Sales", 0, "Sales", ["Region", "Total"]],
      ["Sales", 0, "Sales - Table 2", ["Note"]],
      ["Staff", 2, "Staff", ["Name"]],
    ]);
    expect(version.metadata).toEqual({ sheets: ["Sales", "Empty", "Staff"] });
  });

  it("turn pdfs into text page by page", async () => {
    const version = await convert("pdf", makePdf(["First page", "Second page"]));
    expect(version).toMatchObject({ kind: "pages", converter: pdfConverter.id, pages: ["First page", "Second page"], metadata: { pageCount: 2 } });
  });

  it("pretty print json and json lines, declining json that is already pretty or not json", async () => {
    expect(await convert("json", "{\"a\":[1,2],\"b\":{}}")).toEqual({ kind: "code", converter: jsonConverter.id, from: "json", language: "json", text: "{\n  \"a\": [\n    1,\n    2\n  ],\n  \"b\": {}\n}" });
    expect(await convert("json", "{\n  \"a\": 1\n}\n")).toBeUndefined();
    expect(await convert("json", "{nope")).toBeUndefined();
    const lines = await convert("json", "{\"a\":1}\n{\"a\":2}\n", "/virtual/log.jsonl");
    expect(lines?.kind === "code" ? lines.text : undefined).toBe("{\n  \"a\": 1\n}\n\n{\n  \"a\": 2\n}");
  });

  it("write yaml out evenly, leaving commented or invalid yaml as it is", async () => {
    expect(await convert("yaml", "a:   {b: [1, 2]}\n---\nc: d\n")).toEqual({ kind: "code", converter: yamlConverter.id, from: "yaml", language: "yaml", text: "a:\n  b:\n    - 1\n    - 2\n---\nc: d" });
    expect(await convert("yaml", "# keep me\na: {b: 1}\n")).toBeUndefined();
    expect(await convert("yaml", "a: [unclosed\n")).toBeUndefined();
    expect(await convert("yaml", "a:\n  b: 1\n")).toBeUndefined();
  });

  it("turn word documents into markdown", async () => {
    const docx = await makeDocx(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> start.</w:t></w:r></w:p>`);
    const version = await convert("docx", docx);
    expect(version).toMatchObject({ kind: "markdown", converter: docxConverter.id, from: "docx" });
    expect(version && versionText(version)).toBe("# Report\n\n**Bold** start.");
  });

  it("turn html into markdown against the page's URL", async () => {
    const version = await convert("html", "<title>T</title><main><a href='b'>B</a></main>", "https://site.dev/a/");
    expect(version).toEqual({ kind: "markdown", converter: htmlConverter.id, from: "html", title: "T", text: "[B](https://site.dev/a/b)" });
    const relative = await registry.convertSource({ location: "/local/page.html", type: "html", input: "<a href='b'>B</a>" }, { html: { links: false } });
    expect(relative && versionText(relative)).toBe("B");
  });

  it("list folders as markdown", async () => {
    const listing = { entries: [{ name: "src", location: "/p/src", kind: "folder", type: "folder" }, { name: "a.md", location: "/p/a.md", kind: "file", type: "markdown", size: 2048 }], truncated: true, total: 5 };
    const version = await registry.convertSource({ location: "/p", type: "folder", input: JSON.stringify(listing), name: "p" });
    expect(version && versionText(version)).toBe("# p\n\nFolder: /p\n\n- src/\n- a.md (markdown, 2.0 KB)\n\nShowing 2 of 5 entries.");
    await expect(registry.convertSource({ location: "/p", type: "folder", input: "{\"entries\": 1}" })).rejects.toThrow();
  });
});

describe("converter stacks", () => {
  const source: ResourceSource = { location: "/virtual/x.note", type: "note", input: "hello" };
  const converter = (id: string, result: "text" | "decline" | "throw", priority = 0): ResourceConverter => ({
    id,
    priority,
    supportedTypes: ["note"],
    async convert(s) {
      if (result === "throw") throw new Error(`${id} failed`);
      if (result === "decline") return undefined;
      return { kind: "text", converter: id, from: s.type ?? "", text: "converted" };
    },
  });

  it("are empty for a type with no converter, so the raw text stands", async () => {
    const empty = new ResourceRegistry();
    expect(empty.hasConverter("note")).toBe(false);
    expect(await empty.convertSource(source)).toBeUndefined();
    await expect(empty.convertSource({ location: "/x", input: "" })).rejects.toThrow("Resource type is not known");
  });

  it("try the highest priority first and fall back past declines and failures", async () => {
    const stack = new ResourceRegistry()
      .registerConverter(converter("low", "text"))
      .registerConverter(converter("mid", "throw", 5))
      .registerConverter(converter("high", "decline", 10));
    expect(stack.getConverters("note").map((c) => c.id)).toEqual(["high", "mid", "low"]);
    expect(await stack.convertSource(source)).toMatchObject({ converter: "low" });
  });

  it("decline when every converter declines and throw when they fail", async () => {
    expect(await new ResourceRegistry().registerConverter(converter("a", "decline")).convertSource(source)).toBeUndefined();
    await expect(new ResourceRegistry().registerConverter(converter("a", "throw")).convertSource(source)).rejects.toThrow("a failed");
    const both = new ResourceRegistry().registerConverter(converter("a", "throw")).registerConverter(converter("b", "throw"));
    await expect(both.convertSource(source)).rejects.toBeInstanceOf(AggregateError);
  });

  it("replace a converter registered again under its id and let a priority option override its own", async () => {
    const stack = new ResourceRegistry().registerConverter(converter("a", "text", 10)).registerConverter(converter("b", "text")).registerConverter(converter("a", "text"), { priority: -1 });
    expect(stack.getConverters("note").map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("buffer one-shot input so a converter after one that read it still gets it", async () => {
    const reader = (id: string, decline: boolean): ResourceConverter => ({
      id,
      supportedTypes: ["note"],
      async convert(s) {
        const chunks: Buffer[] = [];
        if (typeof s.input === "string" || s.input instanceof Uint8Array) chunks.push(Buffer.from(s.input));
        return decline ? undefined : { kind: "text", converter: id, from: "note", text: Buffer.concat(chunks).toString("utf8") };
      },
    });
    const stack = new ResourceRegistry().registerConverter(reader("second", false)).registerConverter(reader("first", true));
    expect(await stack.convertSource({ ...source, input: Readable.from(["a", "b"]) })).toMatchObject({ text: "ab" });
  });

  it("convert a link end to end, keeping the source readable", async () => {
    const { source: resolved, version } = await registry.convert({ location: "/virtual/data.csv", input: Readable.from(["a,b\n1,2\n"]) });
    expect(resolved.type).toBe("csv");
    expect(resolved.input).toBeInstanceOf(Uint8Array);
    expect(version?.kind).toBe("table");
  });
});

describe("parsing through versions", () => {
  it("cuts html parts from the markdown version and takes links from the raw html", async () => {
    const html = "<nav><a href='/home'>Home</a></nav><main><h1>Doc</h1><p>See <a href='other.html'>other</a>.</p></main>";
    const { resource } = await registry.parse({ location: "https://site.dev/docs/index.html", type: "html", input: html });
    expect(resource.version).toMatchObject({ kind: "markdown", text: "# Doc\n\nSee [other](https://site.dev/docs/other.html)." });
    expect(resource.parts.map((part) => part.text)).toEqual(["# Doc\n\nSee [other](https://site.dev/docs/other.html)."]);
    expect(resource.links.map((link) => link.value)).toEqual(["/home", "other.html"]);
  });

  it("uses a registered converter for the type in place of the built-in one, so slicing follows it", async () => {
    const custom = new ResourceRegistry()
      .registerParser(htmlParser)
      .registerSlicer(markdownSlicer)
      .registerConverter({ id: "reader", supportedTypes: ["html"], convert: async () => ({ kind: "markdown", converter: "reader", from: "html", text: "# Clean\n\nonly this" }) });
    const { resource, slices } = await custom.load({ location: "/x.html", type: "html", input: "<p>raw</p>" });
    expect(resource.version?.converter).toBe("reader");
    expect(slices.map((slice) => slice.sectionId)).toEqual(["/x.html#part/0#section/Clean"]);
  });

  it("falls back to the built-in converter when the registry has none for the type", async () => {
    const bare = new ResourceRegistry().registerParser(htmlParser).registerSlicer(markdownSlicer);
    const { resource } = await bare.parse({ location: "/x.html", type: "html", input: "<h2>Hi</h2>" });
    expect(resource.version?.converter).toBe(htmlConverter.id);
  });

  it("cuts workbooks into a part per sheet and pdfs into a part per page", async () => {
    const book = await registry.parse({ location: "/virtual/book.xlsx", type: "excel", input: makeWorkbook({ A: [["x"], ["1"]], B: [["y"], ["2"]] }) });
    expect(book.resource.parts.map((part) => [part.location, part.metadata?.sheetName])).toEqual([["/virtual/book.xlsx#sheet/0", "A"], ["/virtual/book.xlsx#sheet/1", "B"]]);
    const pdf = await registry.parse({ location: "/virtual/two.pdf", type: "pdf", input: makePdf(["One", "Two"]) });
    expect(pdf.resource.parts.map((part) => [part.location, part.pageNumber, part.text])).toEqual([["/virtual/two.pdf#page/1", 1, "One"], ["/virtual/two.pdf#page/2", 2, "Two"]]);
    expect(pdf.resource.version?.kind).toBe("pages");
  });

  it("parses json through its pretty form, or as raw text when already pretty", async () => {
    const minified = await registry.parse({ location: "/virtual/a.json", type: "json", input: "{\"a\":1}" });
    expect(minified.resource.parts[0]?.text).toBe("{\n  \"a\": 1\n}");
    expect(minified.resource.version?.kind).toBe("code");
    const pretty = await registry.parse({ location: "/virtual/b.json", type: "json", input: "{\n  \"a\": 1\n}" });
    expect(pretty.resource.version).toBeUndefined();
    expect(pretty.resource.parts[0]?.text).toBe("{\n  \"a\": 1\n}");
  });

  it("sections a parsed resource's version with keys that match its slices", async () => {
    const { resource, slices } = await registry.load({ location: "/virtual/p.html", type: "html", input: "<h1>A</h1><p>one</p><h2>B</h2><p>two</p>" }, { maxChars: 2000 });
    const version = resource.version;
    expect(version && sectionVersion(version).map((section) => section.key)).toEqual(["A", "A > B"]);
    expect(slices.map((slice) => slice.sectionId?.split("#section/")[1])).toEqual(["A", "A > B"]);
  });

  it("slices csv through its tables", async () => {
    const plain = new ResourceRegistry().registerSlicer(textSlicer);
    expect(plain.hasConverter("csv")).toBe(false);
    const { slices } = await registry.load({ location: "/virtual/t.csv", type: "csv", input: "a,b\n1,2\n" });
    expect(slices[0]?.text).toContain("| a | b |");
  });
});
