# @aeye/resources

Extensible **resource parsing, slicing, and resolution** utilities. Turn a file/URL/zip-entry into a
`ParsedResource` (typed parts + extracted links + child resources), split it into retrieval-ready
`ResourceSlice`s (with embed-text), resolve the links it references, and walk the whole reference
**graph** — all driven from a configurable registry.

Use it to build RAG / knowledge-base ingestion: ingest documents of many formats, chunk them for
embedding, follow links between them, and incrementally rebuild when sources change.

> This doc is split for length. See also:
> - [aeye-resources-parsers.md](./aeye-resources-parsers.md) — parsers, parser stacking, per-type config, PDF rendering, type inference.
> - [aeye-resources-slicers.md](./aeye-resources-slicers.md) — slicers, slice options, pluggable segmenters (LangChain).
> - [aeye-resources-graph.md](./aeye-resources-graph.md) — resolvers, locations, `modifiedAt`, the resource graph.

## Install / import

```ts
import {
  ResourceRegistry,            // the engine
  // types: ParsedResource, ResourcePart, ResourceLink, ResourceSlice, ResourceSource, ...
} from "@aeye/resources";

// Batteries-included registry with all built-in parsers/slicers/resolvers:
import { createDefaultResourceRegistry, defaultResourceRegistry } from "@aeye/resources/default";
```

Optional peer dependencies are loaded lazily and only needed for specific formats/features:
`pdf-parse` (PDF text), `mammoth` (DOCX), `xlsx` (Excel/CSV), `jszip` (ZIP), `node-poppler`
(PDF page rendering), `@langchain/textsplitters` (overlap/token/language-aware chunking). If a
dependency is missing, the relevant parser/feature simply declines or reports unsupported.

## The pipeline

```
input (path | URL | ResourceSource)
   └─ resolve   → ResourceSource          (resolvers: zip, file, url)
   └─ parse     → ParsedResource          (parser stack per type → parts, links, children)
   └─ slice     → ResourceSlice[]         (slicer per type → chunks + embedText)
```

`load()` does all three; `parse()` and `slice()` are also available individually.

```ts
const registry = createDefaultResourceRegistry();

// One call: resolve → parse → slice
const { source, resource, slices } = await registry.load("/docs/guide.md", {
  maxChars: 1500,
  minChars: 300,
});

resource.type;        // "markdown"
resource.parts;       // ResourcePart[] (text/image parts)
resource.links;       // ResourceLink[] (deduped, kind "resource" | "external")
slices[0].embedText;  // string ready to embed
```

## Core data model (from `./types`)

```ts
interface ParsedResource {
  id: string;                 // `${location}::${type}`
  location: string;           // canonical, self-contained location
  type: string;               // e.g. "markdown", "pdf", "typescript"
  name: string;
  mimeType?: string;
  modifiedAt?: number;        // epoch ms — for staleness/incremental rebuilds
  size?: number;
  defaultSlicer: string;      // slicer id chosen by the parser
  parts: ResourcePart[];
  links: ResourceLink[];
  children?: ParsedResource[];// zip entries, rendered PDF pages, …
  parentLocation?: string;
}

interface ResourcePart {
  id: string; location: string;
  kind: "text" | "image";
  text?: string; data?: Uint8Array; mimeType?: string;
  pageNumber?: number; metadata?: Record<string, unknown>;
  links?: ResourceLink[];
}

interface ResourceLink {
  id: string; value: string; location: string;
  kind: "resource" | "external";  // relative/internal vs absolute external
  title?: string; targetType?: string; metadata?: Record<string, unknown>;
}

interface ResourceSlice {
  id: string; resourceId: string; partId: string; location: string;
  text: string;        // the slice content
  embedText: string;   // text augmented with context/links, ready to embed
  start: number; end: number;        // offsets into the part text
  context?: { headings?; declaration?; summary?; prefixes? };
  links: ResourceLink[]; metadata?: Record<string, unknown>;
}
```

## The registry (`ResourceRegistry`)

The registry is the configurable core. Everything is pluggable and registry-driven — there are no
hardcoded type→parser/slicer tables in the hot path.

```ts
const r = new ResourceRegistry()
  .registerParser(myParser, { priority: 10 })  // higher priority tried first
  .registerSlicer(mySlicer)
  .registerResolver(myResolver);
```

Key methods (see topic docs for details):

| Method | Purpose |
| --- | --- |
| `load(input, opts?)` | resolve → parse → slice; returns `{ source, resource, slices }` |
| `parse(input, opts?)` | resolve + parse; returns `{ source, resource }` |
| `parseSource(source, opts?)` | run the parser stack on an already-resolved source |
| `slice(resource, opts?)` | run the slicer for a resource |
| `resolveLink(link, opts?)` | resolve a link (with optional `baseLocation`) to a `ResourceSource` |
| `locate(location, opts?)` | resolve a **self-contained** location directly (no base) |
| `statLink(link, opts?)` | cheap probe → `{ location, modifiedAt, ... }` without loading |
| `canResolve(link, opts?)` / `getResolverId(link, opts?)` | resolvability checks |
| `inferType(location, mime?)` | type detection from the registry's maps |
| `configureType(type, opts)` | set per-type defaults (parse **and** slice options) |
| `getTypeConfig(type)` | read per-type config |
| `registerExtensionType` / `registerMimeType` / `registerType` | extend type detection |
| `registerParser` / `registerSlicer` / `registerResolver` | extend behavior |
| `getParser(type)` / `getParsers(type)` / `getSlicer(id)` | introspection |
| `getTypeSupport(type)` / `isTypeSupported(type)` | capability checks (incl. optional deps) |

### Per-type configuration

Configure capabilities once per type instead of on every call. Per-call options always win;
nested `pdf`/`code` objects are shallow-merged.

```ts
registry.configureType("pdf", {
  pdf: { renderPages: true, transcribePages: true },
  renderPdfPages: createPopplerRenderer(),
  transcribeImage: myVisionTranscriber,
});
registry.configureType("markdown", { maxChars: 1200, minChars: 200 });
```

## Built-in registry contents (`@aeye/resources/default`)

`createDefaultResourceRegistry()` registers:

- **Parsers** (stacked where useful): `textParser` (text/json/csv/tsv/yaml/xml/svg/toml/ini),
  `markdownParser`, `htmlParser`, `codeParser` (all `CODE_TYPES`), `imageParser`,
  `pdfRenderParser`→`pdfParser`, `excelPdfParser`→`excelParser`, `docxPdfParser`→`docxParser`,
  `zipParser`.
- **Slicers**: `textSlicer` (`*`), `markdownSlicer` (markdown/html), `codeSlicer` (code types).
- **Resolvers** (tried in order): `zipResolver`, `fileResolver`, `urlResolver`.

All are exported individually too, so you can compose a custom registry.

## Common recipes

```ts
// Ingest a folder of mixed docs and embed the slices
for (const path of paths) {
  const { slices } = await registry.load(path);
  await embed(slices.map((s) => s.embedText));
}

// Know how to fetch a stored location, then load it
import { inferLocationScheme } from "@aeye/resources";
inferLocationScheme(loc);              // "url" | "file" | "zip-entry" | "relative"
const source = await registry.locate(loc);  // throws if not self-contained

// Crawl everything reachable from a root (see graph doc)
import { buildResourceGraph } from "@aeye/resources";
const graph = await buildResourceGraph(registry, "/docs/index.md");
```

## Gotchas

- Optional deps are not bundled; install the ones for formats you use. Missing deps → parser declines
  or `isTypeSupported` returns false, not a hard crash (except when a format has no fallback).
- File locations are emitted **absolute** so they round-trip; a manually-supplied *relative*
  `location` is not self-contained (`locate()` rejects it).
- Zips are read from disk (URL-hosted zips are not supported by the zip parser/resolver).
- `modifiedAt` is best-effort: filesystem mtime, HTTP `Last-Modified`, or zip entry date.
