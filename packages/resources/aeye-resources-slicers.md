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
- Per-slice links: part links present in the text + bare URLs in the segment.

### `markdown` — `supportedTypes: ["markdown", "html"]`
Heading-aware. Detects `#`–`######` headings, builds a heading breadcrumb
(`slice.context.headings`, e.g. `Intro > Details`), then segments each section.
- Default boundaries: `["\n\n", "\n", ". ", " "]` (sentence-aware).
- Per-slice links: markdown `[](…)` links + bare URLs. Used for HTML too (HTML is parsed to markdown).

### `code` — `supportedTypes: [...CODE_TYPES]`
Declaration-aware. Splits at top-level declarations and attaches import context.
- `slice.context.declaration` = the block's first line; `slice.context.prefixes` = the first
  `maxImportPrefixes` import lines.
- Default boundaries: `["\n\n", "\n", " "]`.
- Per-slice links: import/require specifiers + bare URLs.

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
| `code.declarationPattern` | TS/JS regex | what starts a code block |
| `code.importPattern` | import/require regex | what counts as an import prefix |
| `code.maxImportPrefixes` | `5` | how many import lines to attach |
| `signal` | — | abort |

`embedText` is assembled by the built-in `buildEmbedText`/`collectEmbedContext` from the include-flags
above; override `buildEmbedText` to fully control the embedding-facing string.

```ts
registry.configureType("markdown", { maxChars: 1200, minChars: 200, includePartKind: true });
const { slices } = await registry.load("/docs/guide.md");
```

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
