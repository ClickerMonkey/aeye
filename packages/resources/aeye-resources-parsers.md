# @aeye/resources — Parsers, stacking & type detection

Parent: [aeye-resources.md](./aeye-resources.md)

A **parser** turns a `ResourceSource` into a `ParsedResource` (parts + links + children). Parsers are
registered per type and tried in a **stack**; type detection is fully registry-driven.

## The `ResourceParser` interface

```ts
interface ResourceParser {
  id: string;
  supportedTypes: ResourceType[];
  defaultSlicer: string | Partial<Record<ResourceType, string>>;
  priority?: number;                 // higher tried first; ties → most-recently registered
  isSupported?: (type, ctx) => boolean | Promise<boolean>;  // env/dep capability
  // Return undefined to DECLINE (fall back to the next parser); throwing also falls back.
  parse: (source, ctx) => Promise<ParsedResource | undefined>;
}
```

`ctx` is `{ registry, options }` where `options` is the per-type config merged under the per-call
options.

## Parser stacking & fallback

Multiple parsers can serve one type. `registerParser(parser, { priority })` orders them (higher
first; equal priority → later registration wins, so you can override built-ins). At parse time the
registry tries each in order:

- returns a `ParsedResource` → success;
- returns `undefined` → declines, try next;
- throws → recorded, try next (aborts propagate immediately). If all throw, errors surface
  (single error rethrown, or `AggregateError`).

This is how "enhanced" parsers stack ahead of base ones:

| Type | priority 10 (tried first) | priority 0 (fallback) |
| --- | --- | --- |
| pdf | `pdfRenderParser` (render pages + transcribe) | `pdfParser` (pdf-parse text) |
| docx | `docxPdfParser` (convert→PDF→delegate) | `docxParser` (mammoth → markdown) |
| excel/csv/tsv | `excelPdfParser` (convert→PDF) | `excelParser` (xlsx → tables) |

A higher-priority parser declines (returns `undefined`) when its capability isn't configured (e.g.
no `renderPdfPages`), so the base parser handles it.

### Write a custom parser

```ts
const csvSummaryParser: ResourceParser = {
  id: "csv-summary",
  supportedTypes: ["csv"],
  defaultSlicer: "text",
  priority: 20,
  async parse(source, ctx) {
    if (!ctx.options.summarizeTables) return undefined; // decline → fall back to excelParser
    const resource = createParsedResource(source);
    // ... build resource.parts / resource.links ...
    return resource;
  },
};
registry.registerParser(csvSummaryParser);
```

## Built-in parsers

- **textParser** — `text, json, csv, tsv, yaml, xml, svg, toml, ini`. Decodes UTF-8 into one text
  part. Extracts bare URLs; for **markup types** (`markupTypes`, default `xml`/`svg`) also extracts
  `href`/`src` links.
- **markdownParser** — `markdown`. Extracts markdown links + URLs. Default slicer `markdown`.
- **htmlParser** — `html`. Converts HTML → markdown (`htmlToMarkdown`), extracts `href`/`src` + URLs.
  Honors `options.renderUrl(url, signal)` to fetch rendered HTML (e.g. via headless browser) when the
  source is an http(s) URL.
- **codeParser** — all `CODE_TYPES` (ts, js, py, go, rust, …). Extracts import/require + URLs.
  Default slicer `code`.
- **imageParser** — `image`. Stores image bytes as an image part; optionally adds text parts from
  `options.transcribeImage` and `options.describeImage`.
- **pdfRenderParser / pdfParser** — see PDF section.
- **excelPdfParser / excelParser** — Excel/CSV/TSV. Base parser uses `xlsx`, detects multiple table
  regions per sheet, renders markdown tables, and stores structured tables in
  `resource.metadata.structuredTables`.
- **docxPdfParser / docxParser** — DOCX. Base parser uses `mammoth` → markdown.
- **zipParser** — `zip`. Lists entries and parses each entry **through the registry** so its links
  become part of the graph (see graph doc); entries that can't be parsed in-memory fall back to a raw
  representation. Children carry `modifiedAt` from the zip entry date.

## PDF parsing & page rendering

`PdfParseOptions` (under `options.pdf`):

```ts
interface PdfParseOptions {
  renderPages?: boolean;     // render pages to images
  renderDpi?: number;        // default 150
  transcribePages?: boolean; // transcribe rendered pages → markdown text parts
  extractImages?: boolean;
}
```

Plumbing options (top-level `ParseOptions`):

- `renderPdfPages?: RenderPdfPagesFn` — `(pdfPath, outDir, dpi, signal) => Promise<RenderedPage[]>`.
- `convertToPdf?: ConvertToPdfFn` — `(srcPath, signal) => Promise<string>` (for docx/excel→pdf).
- `transcribeImage?` / `describeImage?` — vision callbacks.

### Poppler renderer (built-in `RenderPdfPagesFn`)

Requires `node-poppler` + the poppler binaries.

```ts
import { createPopplerRenderer, isPopplerAvailable } from "@aeye/resources";

registry.configureType("pdf", {
  pdf: { renderPages: true, transcribePages: true },
  renderPdfPages: createPopplerRenderer({ format: "png" /* | "jpeg" | "tiff" */ }),
  transcribeImage: async (bytes) => myVisionModel(bytes),
});

await isPopplerAvailable(); // boolean — binaries present?
```

`createPopplerRenderer(options?)` → `RenderPdfPagesFn`. Options: `binaryPath`, `format`,
`antialiasFonts`, `antialiasVectors`. Also exported: `orderRenderedPages(files, dir, format)`
(pure helper that sorts poppler output into `RenderedPage[]`).

When rendering is enabled, `pdfRenderParser` produces page-image **children** and (if
`transcribePages`) parent text parts; otherwise it declines and `pdfParser` extracts text.

## Registry-driven type detection

Detection maps live on the registry (seeded from defaults) and are extensible:

```ts
registry.registerExtensionType("ipynb", "notebook");
registry.registerMimeType(/^application\/x-ipynb\+json/i, "notebook");
registry.registerType({                       // one call
  type: "notebook",
  extensions: ["ipynb"],
  mimePatterns: [/^application\/x-ipynb\+json/i],
});

registry.inferType("/x/a.ipynb");                       // "notebook"
registry.inferType("/x/y", "application/x-ipynb+json"); // "notebook"
```

- Mime patterns take precedence over extensions; newly registered patterns are checked first.
- Extension matching scans suffixes longest-first, so **compound extensions** like `.tar.gz` and
  `.test.ts` resolve correctly. Dockerfiles are detected by name.
- Each registry instance has its own maps (no global leakage).

Standalone helpers (operate on the default maps): `inferTypeFromLocation`,
`inferTypeFromMimeType`, `inferTypeFromExtension(loc, map)`, `inferTypeFromMimePatterns(mime, list)`.
Exposed default tables: `DEFAULT_EXTENSION_TYPES`, `DEFAULT_MIME_TYPE_PATTERNS`, `CODE_TYPES`,
`DEFAULT_MARKUP_TYPES`, `DEFAULT_IMAGE_EXTENSION_MIME` (+ `imageMimeTypeFromLocation`).

## Parse options (selected `ParseOptions` fields)

| Field | Effect |
| --- | --- |
| `signal` | abort |
| `code` | `CodeParserOptions` (declaration/import patterns, `maxImportPrefixes`) |
| `pdf` | `PdfParseOptions` (see above) |
| `renderPdfPages`, `convertToPdf` | PDF render / doc→pdf conversion functions |
| `transcribeImage`, `describeImage` | vision callbacks for images & PDF pages |
| `renderUrl` | render an http(s) URL to HTML for the html parser |
| `markupTypes` | which types get `href`/`src` extraction (default xml/svg) |

All of these can be set per type via `configureType` or passed per call.

## Capability checks

```ts
await registry.isTypeSupported("pdf");   // false if pdf-parse missing AND no render configured
await registry.getTypeSupport("docx");   // { type, parserId, slicerId, parser, slicer, supported }
```
