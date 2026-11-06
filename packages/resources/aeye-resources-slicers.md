# @aeye/resources — Slicers & segmenters

Parent: [aeye-resources.md](./aeye-resources.md)

A **slicer** splits a `ParsedResource` into retrieval-ready `ResourceSlice`s, attaching context
(headings/declarations), per-slice links, and an `embedText` string. The raw text-splitting step is a
pluggable **segmenter**, so you can swap in LangChain for overlap / token sizing / language grammars
without losing the slice model.

## Slicer selection

For a resource, the slicer id is chosen as:
`options.slicer` → `resource.defaultSlicer` (set by the parser) → registry default for the type
(`getDefaultSlicer`). Register a slicer for a type by giving a parser a matching `defaultSlicer`, or
configure `slicer` per type via `configureType`.

## The `ResourceSlicer` interface

```ts
interface ResourceSlicer {
  id: string;
  supportedTypes: ResourceType[];   // ["*"] = any
  isSupported?: (type, ctx) => boolean | Promise<boolean>;
  slice: (resource, ctx) => Promise<ResourceSlice[]>;
}
```

## Built-in slicers

### `text` — `supportedTypes: ["*"]`
Universal fallback. Splits each text part on boundary strings into contiguous, non-overlapping
segments. No structural context.
- Default boundaries: `["\n\n", "\n", " "]`.
- Per-slice links: the part's links that appear in the slice + bare URLs in the segment.
- `slice.sectionId` = the part location (one section per part).

### `markdown` — `supportedTypes: ["markdown", "html"]`
Heading-aware. Detects `#`–`######` headings (ignoring `#` lines inside `` ``` `` / `~~~` code
fences), builds a heading breadcrumb (`slice.context.headings`, e.g. `Intro > Details`), then
segments each section. Text before the first heading is its own section with no headings, so the
slices always cover the whole text. `slice.sectionId` = `<part>#section/<n>`.
`splitMarkdownSections(text)` is exported.
- Default boundaries: `["\n\n", "\n", ". ", " "]` (sentence-aware).
- Per-slice links: markdown `[](…)` links + bare URLs. Used for HTML too (HTML is parsed to markdown).

### `code` — `supportedTypes: [...CODE_TYPES]`
Declaration-aware. Splits at top-level (unindented) declarations and attaches import context.
- Text before the first declaration (license header, imports) is its own block, so the slices
  always cover the whole file. Doc comments, decorators and attributes directly above a declaration
  stay with it.
- Declaration patterns per language (`CODE_DECLARATION_PATTERNS`): JS/TS, python, ruby, go, rust,
  lua, shell, sql, graphql; other languages use a generic pattern (class/struct/fn/func/def/…).
- `slice.context.declaration` = the declaration line (undefined for the preamble);
  `slice.context.prefixes` = the first `maxImportPrefixes` import lines.
- `slice.sectionId` = `<part>#block/<n>`. `splitCodeBlocks(text, type, codeOptions)` is exported.
- Default boundaries: `["\n\n", "\n", " "]`.
- Per-slice links: the part's links that appear in the slice + import/require specifiers + bare URLs.

Every slicer de-duplicates a slice's links by value, so the `Links:` line in `embedText` lists each
link once, and only links that are in that slice.

## Slice options (`SliceOptions`)

All apply to every slicer and can be set **per call** or **per type** via `configureType`.

| Option | Default | Effect |
| --- | --- | --- |
| `slicer` | per-type default | force a slicer id |
| `maxChars` | `2000` (`DEFAULT_MAX_CHARS`) | max slice size |
| `minChars` | `400` (`DEFAULT_MIN_CHARS`) | min size before a boundary break is accepted |
| `boundaries` | slicer-specific | ordered break strings (longest-context first) |
| `segmenter` | `defaultTextSegmenter` | pluggable splitting strategy (see below) |
| `includeResourceLocation` | `true` | add `Resource: <loc>` to embed text |
| `includeResourceType` | `true` | add `Type: <type>` |
| `includePartLocation` | `true` | add `Part: <loc>` |
| `includePartKind` | `false` | add `Kind: text\|image` |
| `includeContext` | `true` | add headings / declaration / summary / prefixes |
| `includeLinks` | `true` | add `Links: …` line |
| `embedSeparator` | `"\n\n"` | joins embed-text lines |
| `buildEmbedText` | built-in | full override: `(EmbedTextContext) => string` |
| `code.declarationPattern` | per language (`CODE_DECLARATION_PATTERNS`) | what starts a code block |
| `code.topLevelOnly` | `true` | only unindented lines can start a block |
| `code.importPattern` | import/require regex | what counts as an import prefix |
| `code.maxImportPrefixes` | `5` | how many import lines to attach |
| `summarize` | — | `(SummaryRequest) => Promise<string \| undefined>`; see [Summaries](#summaries) |
| `summaryScope` | `"resource"` | `"resource"`, `"section"` or `"both"` |
| `summaryConcurrency` | `4` | max concurrent `summarize` calls |
| `minSectionSummaryChars` | `0` | skip summarizing sections shorter than this |
| `signal` | — | abort |

`embedText` is assembled by the built-in `buildEmbedText`/`collectEmbedContext` from the include-flags
above; override `buildEmbedText` to fully control the embedding-facing string.

```ts
registry.configureType("markdown", { maxChars: 1200, minChars: 200, includePartKind: true });
const { slices } = await registry.load("/docs/guide.md");
```

## Summaries

Pass `summarize` to add model-written context to every slice. It is called for the whole resource
and/or for each section (markdown section, code block, or text part). The results land in
`slice.context.summary` / `slice.context.sectionSummary` and in `embedText` as `Summary: …` and
`Section summary: …` lines.

```ts
registry.configureType("markdown", {
  summaryScope: "both",
  summarize: async ({ scope, text, headings, signal }) =>
    myModel(`Summarize this ${scope}${headings ? ` (${headings.join(" > ")})` : ""} in one sentence:\n\n${text}`, signal),
});
```

- `SummaryRequest` = `{ scope, resource, text, sectionId?, headings?, declaration?, signal? }`.
- Results are cached on `resource.metadata.summary` and `resource.metadata.sectionSummaries`
  (keyed by `sectionId`), so slicing the same resource again, or one reused from a graph cache, does
  not call `summarize` again. Clear those fields to force a refresh.
- With `"both"`, a section that is the whole resource is not summarized twice.
- Return `undefined` to skip a summary. Errors from `summarize` propagate.

## Pluggable segmenters

The slicers call a `TextSegmenter` for the raw split step:

```ts
type TextSegmenter = (text: string, ctx: SegmentContext) => TextSegment[] | Promise<TextSegment[]>;
interface TextSegment { start: number; end: number; text: string; }
interface SegmentContext { maxChars; minChars; boundaries?; type?; slicerId?; signal?; }
```

### `defaultTextSegmenter` (built-in)
Lossless and offset-exact: contiguous, non-overlapping segments whose concatenation reproduces the
input. `partText.slice(start, end) === slice.text` always holds. This is the default.

### `createLangchainSegmenter(options?)` (optional)
Backed by `@langchain/textsplitters`. Adds features the built-in lacks: **chunk overlap**,
**token-based sizing**, and **language-aware** splitting (~16 languages).

```ts
import { createLangchainSegmenter, isLangchainSplittersAvailable } from "@aeye/resources";

// Overlapping char chunks; language grammar auto-derived from the resource type:
registry.configureType("typescript", {
  segmenter: createLangchainSegmenter({ chunkSize: 1500, chunkOverlap: 200 }),
});

// Token-accurate sizing (tiktoken):
registry.configureType("markdown", {
  segmenter: createLangchainSegmenter({ mode: "token", chunkSize: 512, chunkOverlap: 64 }),
});

await isLangchainSplittersAvailable(); // boolean
```

`LangchainSegmenterOptions`:

| Option | Default | Notes |
| --- | --- | --- |
| `mode` | `"recursive"` | `"recursive"` (char-sized) or `"token"` (`TokenTextSplitter`) |
| `language` | derived from `type` | force a LangChain language grammar (recursive) |
| `languageFromType` | `true` | auto-map resource type → LangChain language |
| `chunkSize` | slicer `maxChars` | chars (recursive) or tokens (token mode) |
| `chunkOverlap` | `0` | >0 enables overlap (relaxes round-trip) |
| `separators` | LangChain default | custom separators (recursive, no language) |
| `keepSeparator` | `true` | keeps chunks as literal substrings → exact offset recovery |

**Offsets**: recovered by locating each chunk in the source. With `keepSeparator: true`, chunks are
literal substrings so `partText.slice(start, end) === slice.text` still holds, even with overlap.
**Round-trip**: with overlap (or token mode) segments overlap/trim, so the lossless concat guarantee
is intentionally relaxed for this segmenter (the default segmenter stays strict).

Type→language map covers: ts/tsx/js/jsx→`js`, python, go, java, c/cpp→`cpp`, php, rust, ruby, scala,
swift, markdown, html. Other types fall back to a generic recursive split.

### Write a custom segmenter

```ts
const sentenceSegmenter: TextSegmenter = (text) => {
  const out: TextSegment[] = []; let i = 0;
  for (const m of text.matchAll(/[^.!?]+[.!?]+/g)) {
    const s = m.index!, e = s + m[0].length;
    out.push({ start: s, end: e, text: m[0] });
    i = e;
  }
  if (i < text.length) out.push({ start: i, end: text.length, text: text.slice(i) });
  return out;
};
registry.configureType("text", { segmenter: sentenceSegmenter });
```

## Slicing without the registry

```ts
const slices = await registry.slice(resource, { maxChars: 800, slicer: "markdown" });
```

`registry.slice` merges the resource type's registry config under the passed options, then runs the
resolved slicer.
