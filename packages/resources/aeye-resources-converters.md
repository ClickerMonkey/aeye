# @aeye/resources — versions, converters, sections, fetching and folders

A resource has a **raw** form (the bytes as they are stored or served) and, for many formats, an
**LLM-ready version** made from it by a **converter**: clean markdown from html, tables from a
spreadsheet, text page by page from a pdf, a pretty form of json or yaml, a listing of a folder. Keep
both: show either, and cut sections and slices from the version.

## Versions (`@aeye/resources/versions`, browser safe)

Every shape is a zod schema with its type derived from it, so stored or sent versions can be checked.
The module imports only zod.

```ts
import { resourceVersionSchema, versionText, versionMimeType, type ResourceVersion } from "@aeye/resources/versions";

type ResourceVersion =
  | { kind: "markdown"; text: string; ...base }              // html, docx, folders
  | { kind: "text"; text: string; ...base }
  | { kind: "code"; language: string; text: string; ...base } // json, yaml (pretty)
  | { kind: "pages"; pages: string[]; ...base }               // pdf
  | { kind: "table"; tables: Table[]; ...base };              // csv, tsv, workbooks
// base: { converter: string; from: string /* source type */; title?: string; metadata?: Record<string, unknown> }
```

What can be worked out is a function, not a field:

| Function | Gives |
| --- | --- |
| `versionText(v)` | the text: `text`, pages joined by `PAGE_BREAK` (`\f`), or tables as markdown (`## name` + GFM table, blocks joined by a blank line) |
| `versionMimeType(v)` | `text/markdown`, `text/plain`, or the code language's (`application/json`, `application/yaml`) |
| `tableToMarkdown(t)` / `tableBlock(t)` | one table as a GFM table / with its heading |
| `columnKinds(t)` | per column: `empty`, `boolean`, `integer`, `number`, `date` or `text` |
| `tableRecords(t)` | rows as records keyed by header, cells typed by column kind (blank/repeat headers get `column 3`, `name 2`) |

`RESOURCE_VERSION_KINDS` lists the kinds; `ResourceVersionOf<"table">` picks one. `folderListingSchema`
and `tableSchema` are here too.

## Converters

```ts
interface ResourceConverter {
  id: string;
  supportedTypes: ResourceType[];
  priority?: number;                                   // higher tried first; ties → most recently registered
  isSupported?(type, ctx): boolean | Promise<boolean>; // e.g. its optional dependency is installed
  convert(source: ResourceSource, ctx: { registry, options: ParseOptions }): Promise<ResourceVersion | undefined>;
}

registry.registerConverter(myConverter, { priority: 10 });
registry.getConverters("html");        // the stack, first tried first
registry.hasConverter("html");
await registry.convertSource(source);  // version, or undefined (no converter / all declined → raw is LLM-ready)
await registry.convert("https://x.dev/page", { renderer });  // resolve + convert; { source (input buffered), version }
```

A converter that returns `undefined` declines and one that throws falls back to the next; if all
throw, the error (or an `AggregateError`) is thrown. One-shot inputs are buffered so each converter
gets the whole input. Per-type options from `configureType` apply.

Built in (`DEFAULT_CONVERTERS`, registered by `createDefaultResourceRegistry`):

| Converter | Types | Version |
| --- | --- | --- |
| `htmlConverter` | html | markdown of the main content; `title`, and `description`, `language`, `canonicalUrl` in metadata |
| `docxConverter` | docx | markdown, through mammoth's html (needs `mammoth`) |
| `delimitedConverter` | csv, tsv | tables; RFC 4180, the csv delimiter detected (`, ; tab \|`); no dependency |
| `workbookConverter` | excel | tables per sheet, formatted cells (needs `xlsx`) |
| `pdfConverter` | pdf | pages (needs `pdf-parse`); scanned pages are empty — use the render/transcribe parsers for those |
| `jsonConverter` | json | json indented two spaces; json lines each pretty printed. Declines when already pretty or not json |
| `yamlConverter` | yaml | even yaml (needs `js-yaml`). Declines when it has comments (they would be lost), is invalid or already even |
| `folderConverter` | folder | markdown listing: `# name`, `Folder: <path>`, `- entry (type, size)` |

### Html to markdown

`htmlToCleanMarkdown(html, options)` → `{ markdown, title?, description?, language?, canonicalUrl? }`
(`htmlToMarkdown` gives the markdown alone). It parses html into a tree (`parseHtml`: void elements,
raw text, implied end tags; never throws), drops scripts, styles, forms, iframes, svg and hidden
elements (`hidden`, `aria-hidden`, inline `display:none`), and with `content: "main"` (default) keeps
the `<main>` (or `role=main`), else the one `<article>`, else the body without its chrome (`nav`,
`aside`, `header`/`footer` outside content, chrome landmarks, and class/id words like `menu`,
`sidebar`, `cookie`, `share`). A nearly empty main falls back to the body; a page that is all chrome
keeps it. Out comes GitHub markdown: headings, paragraphs, nested/numbered lists, tables (colspans,
captions; one-column layout tables become blocks), fenced code with its language, inline code,
quotes, definitions, emphasis, links and images made absolute against `baseUrl` (or `<base href>`).
Fragment, `javascript:` and `data:` links and 1px images are dropped; line starts that would read as
markdown are escaped. Options: `baseUrl`, `content`, `links`, `images`, `dropTags`. Through the
registry it is `options.html`, with `baseUrl` defaulting to the resource's URL.

## Parsing works from the version

Version parsers (`createVersionParser({ id, supportedTypes, defaultSlicer, fallback, links? })`)
convert through the registry's stack for the type (else `fallback`) and cut parts from the version:
a page per part (`#page/<n>`), a sheet per part (`#sheet/<i>`), otherwise one part (`#part/0`). The
version is kept on `resource.version`. Registering another converter for a type (say a Readability
one for html) changes what is parsed, sliced and sectioned with no other change. When the stack
declines, the parser declines too and the next parser (e.g. `textParser`) takes the raw text.

## Sections of a version

```ts
registry.sectionVersion(version);   // or sectionVersion(version) for the defaults alone
// → [{ key, path, title, start, end }]  offsets into versionText(version), covering it in order
```

| Version | Cut by | Keys |
| --- | --- | --- |
| markdown | headings (fences ignored) | heading path `Guide > Usage`, `(root)` before the first heading |
| pages | page (its page break included) | `Page 1`, `Page 2` |
| table | table | `Sheet > Sheet - Table 2`, or the table's name, or `Table 1` |
| code (json, yaml) | top-level key (text before the first joins it) | `name`, `list` |
| anything else | whole | `(root)` |

Keys come from structure (`sectionKeys`; repeats get ` ~2`), so they survive edits around them.
`registry.registerSectioner({ id, supports(version), sections(version) })` adds a sectioner; newer
ones are asked first, so one can override a default for the versions it supports.

## Fetching URLs

The url resolver fetches with `fetchResource(url, registry, options)`, also usable on its own:

```ts
const page = await fetchResource("https://site.dev/docs", registry, {
  fetch,            // FetchFn, default global fetch (inject to test or proxy)
  headers, timeoutMs /* 30000 */, maxBytes /* 50 MiB */, signal,
  renderer,         // PageRenderer, optional
  render: "auto",   // "never" | "auto" | "always"
});
page.source;        // { location: final URL, input: Uint8Array, type?, mimeType (always), size, modifiedAt?, metadata }
page.detectedBy;    // "content" | "header" | "extension" | "text" | "default"
page.charset; page.renderedBy; page.renderError; page.requestedUrl; page.url; page.status;
```

- **Type detection** (`detectType`): magic numbers first (pdf, png, jpeg, gif, webp, bmp, ico; zips
  told apart as docx or workbook by their entry names), then a specific `Content-Type`, then the URL
  path's extension, then how the text starts (html, svg, xml, json), else `text`, or no type for
  binary bytes. Generic types (`application/octet-stream`, `text/plain`) are looked past, and so is
  a `text/*` type with no rule of its own (`text/typescript` says only `text`, so `a.ts` is
  `typescript` by its extension; with no extension it labels plain `text`).
- **Mime type**: `source.mimeType` is always set. A specific declared mime type is kept as it is
  (`application/javascript`); else the detected type's from `DEFAULT_TYPE_MIME_TYPES` (`markdown` →
  `text/markdown`, `docx` → the wordprocessingml type, an image's by its extension); else
  `text/plain` for text and `application/octet-stream` for binary bytes (`effectiveMimeType`).
- **Text** is decoded by BOM, declared charset, or (html) `<meta charset>`, and stored as utf-8
  (`metadata.charset` keeps the original).
- **Redirects** are followed; the source is located at the final URL (`metadata.requestedUrl` keeps the
  asked one). Non-2xx, timeouts and bodies over `maxBytes` throw; aborts throw an `AbortError`.
- `statUrl` probes with HEAD for type, size and modified time (falls back to the URL itself).

### Content sniffing helpers

The pieces `detectType` is made of are exported for code that fetches its own way:

```ts
import {
  detectType, parseContentType, isGenericMimeType, sniffMagic, sniffText, looksBinary, decodeText, isUtf8Charset,
  effectiveMimeType, DEFAULT_TYPE_MIME_TYPES,
} from "@aeye/resources";

detectType(registry, url, bytes, parseContentType(header)); // { type?, mimeType, detectedBy, binary }
parseContentType("Text/HTML; charset=UTF-8"); // { mimeType: "text/html", charset: "utf-8" }; undefined for none
isGenericMimeType("application/octet-stream"); // true (also text/plain, binary/octet-stream, application/unknown, …)
sniffMagic(bytes);                // { type: "pdf", mimeType: "application/pdf" } by the first bytes, or undefined
sniffText(text);                  // { type: "html" | "svg" | "xml" | "json", mimeType } by how the text starts, or undefined
looksBinary(bytes);               // true for a NUL byte, or many control characters, in the first 1024 bytes
decodeText(bytes, charset?, html?); // { text, charset }: BOM, then the declared charset, then <meta charset> for html
isUtf8Charset("us-ascii");        // true for utf-8 or ascii (no transcoding needed)
effectiveMimeType("markdown", "text/plain", { location: "/a.md", binary: false }); // "text/markdown"
```

### Page renderers

```ts
interface PageRenderer {
  readonly id: string;
  render(request: { url; html; headers?; signal? }): Promise<{ html: string; url?: string }>;
}
```

The library ships none; plug in a headless browser. With `render: "auto"` only pages that look built
by scripts go through it (`looksScriptRendered`: an empty app root like `<div id="root"></div>`, a
`<noscript>` asking for JavaScript, or scripts with almost no visible text). The rendered html
replaces the fetched html (`metadata.renderedBy`). In `auto` a failed render keeps the fetched html
(`metadata.renderError`); in `always` it throws. Pass `renderer`/`render` with the call that fetches, e.g. `registry.load(url, { renderer })`.

## Folders

`folderResolver` (in the default registry, ahead of the file resolver) resolves an existing folder to a
`folder` resource: raw form a json `FolderListing` (`listFolder` gives it directly), version a
markdown listing, links one per entry, so `buildResourceGraph(registry, dir)` walks the tree. Options
under `folder`: `includeHidden`, `ignore` (`DEFAULT_FOLDER_IGNORE`), `maxEntries`
(`DEFAULT_FOLDER_MAX_ENTRIES`). `FOLDER_TYPE` is `"folder"`, `FOLDER_MIME_TYPE` is `"inode/directory"`.
