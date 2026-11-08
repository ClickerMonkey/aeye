import type { Readable } from "node:stream";
import type { HtmlToMarkdownOptions } from "./html/markdown";
import type { ResourceVersion, Table } from "./versions";

export type ResourceType = string;
export type ResourceInput = string | Uint8Array | ArrayBuffer | URL | Readable | ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array> | (() => AsyncIterable<Uint8Array>);
export type ResourceLocation = string;
export type ResourcePartKind = "text" | "image";

/** What a {@link PageRenderer} is asked to render. */
export interface RenderRequest {
  /** The page's URL (after redirects). */
  url: string;
  /** The html the server sent, before any script ran. */
  html: string;
  /** Request headers the page was fetched with. */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** A page after a {@link PageRenderer} ran it. */
export interface RenderedHtml {
  /** The html after scripts ran (the live document, serialized). */
  html: string;
  /** The URL the page ended up at, when the page navigated. */
  url?: string;
}

/**
 * Runs a web page's scripts and returns the resulting html, for pages whose content is built in the browser. The
 * library ships none; plug in a headless browser (puppeteer, playwright) through this interface.
 */
export interface PageRenderer {
  /** Names the renderer in a source's metadata (`metadata.renderedBy`). */
  readonly id: string;
  render(request: RenderRequest): Promise<RenderedHtml>;
}

/**
 * When fetched html pages go through the {@link PageRenderer}: `never`, `always`, or `auto` (the default), only
 * when the fetched page looks built by scripts (see `looksScriptRendered`).
 */
export type RenderMode = "never" | "auto" | "always";

/** The fetch function the url loader calls; the global `fetch` by default. Inject one to test or to proxy. */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** How a folder is listed by the folder resolver. */
export interface FolderOptions {
  /** List entries whose names start with a dot. Defaults to false. */
  includeHidden?: boolean;
  /** Entry names to leave out. Defaults to `DEFAULT_FOLDER_IGNORE` (`.git`, `node_modules`). */
  ignore?: readonly string[];
  /** The most entries listed; the rest are counted but left out. Defaults to 1000. */
  maxEntries?: number;
}

/**
 * Renders all pages of a PDF to image files in a directory. Receives the PDF file path, an output
 * directory, and the target DPI; should write one image per page and return the rendered page files.
 * This avoids loading the entire PDF into memory.
 */
export type RenderPdfPagesFn = (pdfFilePath: string, outputDir: string, dpi: number, signal?: AbortSignal) => Promise<RenderedPage[]>;

/** Converts a document file to PDF for richer parsing. Returns the path to the converted PDF file. */
export type ConvertToPdfFn = (sourceFilePath: string, signal?: AbortSignal) => Promise<string>;

export interface ResourceLink {
  id: string;
  value: string;
  location: string;
  kind: "resource" | "external";
  title?: string;
  targetType?: ResourceType;
  metadata?: Record<string, unknown>;
}

export interface ResourceSource {
  location: ResourceLocation;
  input: ResourceInput;
  type?: ResourceType;
  name?: string;
  mimeType?: string;
  /** Estimated last-modified time of the underlying source, in epoch milliseconds, if known. */
  modifiedAt?: number;
  /** Size of the underlying source in bytes, if known. */
  size?: number;
  metadata?: Record<string, unknown>;
}

/** Lightweight metadata about a resource location, obtainable without fully loading/parsing it. */
export interface ResourceStat {
  location: ResourceLocation;
  /** Estimated last-modified time, in epoch milliseconds, if known. */
  modifiedAt?: number;
  size?: number;
  mimeType?: string;
  type?: ResourceType;
}

export interface ResourcePart {
  id: string;
  location: string;
  kind: ResourcePartKind;
  text?: string;
  mimeType?: string;
  pageNumber?: number;
  data?: Uint8Array;
  metadata?: Record<string, unknown>;
  links?: ResourceLink[];
}

export interface ParsedResource {
  id: string;
  /**
   * The LLM-ready version the resource's parts were built from (markdown for html, tables for a spreadsheet, pages for
   * a pdf), when its type has a converter. Absent when the raw text is already LLM-ready (markdown, code, plain text).
   */
  version?: ResourceVersion;
  location: ResourceLocation;
  type: ResourceType;
  name: string;
  mimeType?: string;
  /**
   * Estimated last-modified time of the source this resource was built from, in epoch milliseconds.
   * Lets a target system decide whether a previously-built resource is stale and needs rebuilding.
   */
  modifiedAt?: number;
  /** Size of the underlying source in bytes, if known. */
  size?: number;
  metadata?: Record<string, unknown>;
  defaultSlicer: string;
  parts: ResourcePart[];
  links: ResourceLink[];
  /** Child resources (e.g. files inside a zip, rendered pages of a PDF). */
  children?: ParsedResource[];
  /** Location of the parent resource, if this resource is a child. */
  parentLocation?: ResourceLocation;
}

export interface SliceContext {
  headings?: string[];
  declaration?: string;
  /** Summary of the whole resource, from {@link SliceOptions.summarize}. */
  summary?: string;
  /** Summary of the section (markdown section, code block, text part) the slice belongs to. */
  sectionSummary?: string;
  prefixes?: string[];
}

/** What {@link SliceOptions.summarize} is asked to summarize. */
export interface SummaryRequest {
  /** "resource" for the whole resource, "section" for one section of it. */
  scope: "resource" | "section";
  resource: ParsedResource;
  /** The text to summarize (all text parts for a resource; the section's text for a section). */
  text: string;
  /** Section id (only for scope "section"). */
  sectionId?: string;
  /** Heading path of the section, when known. */
  headings?: string[];
  /** Leading declaration of a code section, when known. */
  declaration?: string;
  signal?: AbortSignal;
}

/** Produces a summary for a resource or section, e.g. by calling an LLM. Return undefined to skip. */
export type SummarizeFn = (request: SummaryRequest) => Promise<string | undefined>;

/** A contiguous span of text produced by a {@link TextSegmenter}, with offsets into the input text. */
export interface TextSegment {
  start: number;
  end: number;
  text: string;
}

/** Inputs a slicer hands to a segmenter so it can size and (optionally) language-tune its splitting. */
export interface SegmentContext {
  maxChars: number;
  minChars: number;
  /** Preferred break strings (longest-context first), when the segmenter honors them. */
  boundaries?: string[];
  /** The resource type being sliced (lets language-aware segmenters pick a grammar). */
  type?: ResourceType;
  /** The id of the slicer requesting segmentation ("text" | "markdown" | "code" | …). */
  slicerId?: string;
  signal?: AbortSignal;
}

/**
 * Pluggable text-segmentation strategy. The default segmenter is lossless and offset-exact (the
 * concatenation of segments reproduces the input). Alternative segmenters (e.g. the LangChain adapter)
 * may overlap or trim, in which case offsets are best-effort and the round-trip guarantee is relaxed.
 */
export type TextSegmenter = (text: string, context: SegmentContext) => TextSegment[] | Promise<TextSegment[]>;

export interface ResourceSlice {
  id: string;
  resourceId: string;
  partId: string;
  location: string;
  text: string;
  embedText: string;
  start: number;
  end: number;
  context?: SliceContext;
  links: ResourceLink[];
  /**
   * Id of the section the slice was cut from (a markdown section, a code block, or a whole text
   * part). Slices sharing a section id are contiguous pieces of the same section.
   */
  sectionId?: string;
  metadata?: Record<string, unknown>;
}

export interface EmbedTextContext {
  resource: ParsedResource;
  part: ResourcePart;
  slice: ResourceSlice;
  contextLines: string[];
}

export interface CodeParserOptions {
  /** Pattern to detect top-level declarations in code. Defaults to export/function/class/interface/type/enum/const/let/var */
  declarationPattern?: RegExp;
  /** Pattern to detect import/require lines. */
  importPattern?: RegExp;
  /** Maximum number of detected import lines to attach as slice context prefixes. Defaults to 5. */
  maxImportPrefixes?: number;
  /**
   * Only treat unindented lines as declarations, so nested `const`s or methods don't split a block.
   * Defaults to true. Set false for languages where top-level declarations are indented.
   */
  topLevelOnly?: boolean;
}

export interface PdfParseOptions {
  /** When true, render PDF pages to images and include as image parts/children. */
  renderPages?: boolean;
  /** DPI for rendered page images. Defaults to 150. */
  renderDpi?: number;
  /** When true, use transcription on rendered page images to produce markdown text parts. */
  transcribePages?: boolean;
  /** When true, extract embedded images from the PDF as image parts. */
  extractImages?: boolean;
  /**
   * Directory to keep rendered page images in. When set, page image parts reference files there
   * (`metadata.filePath`) and the caller owns them. When unset, pages render to a temporary
   * directory, their bytes are loaded into the image parts' `data`, and the directory is deleted.
   */
  pageOutputDir?: string;
}

export interface RenderedPage {
  /** Path to the rendered image file on disk. */
  filePath: string;
  /** 1-based page number. */
  pageNumber: number;
  /** MIME type of the image (e.g. "image/png"). */
  mimeType: string;
}

/** A table extracted from tabular data; see {@link Table}. */
export type ExtractedTable = Table;

export interface ParseOptions {
  signal?: AbortSignal;
  describeImage?: (image: Uint8Array, part: ResourcePart, source: ResourceSource) => Promise<string | undefined>;
  transcribeImage?: (image: Uint8Array, part: ResourcePart, source: ResourceSource) => Promise<string | undefined>;
  /** How html becomes markdown. `baseUrl` defaults to the resource's location when it is a URL. */
  html?: HtmlToMarkdownOptions;
  /** Options for code parsing/slicing behavior. */
  code?: CodeParserOptions;
  /** Options for PDF parsing behavior. */
  pdf?: PdfParseOptions;
  /**
   * Resource types whose textual content should have href/src markup links extracted (in addition to
   * bare URLs). Defaults to {@link DEFAULT_MARKUP_TYPES} (xml, svg).
   */
  markupTypes?: ResourceType[];
  /**
   * Renders all pages of a PDF to image files in a directory.
   * See {@link RenderPdfPagesFn}. Use {@link createPopplerRenderer} for a poppler-based implementation.
   */
  renderPdfPages?: RenderPdfPagesFn;
  /**
   * Converts a document file to PDF for richer parsing (render pages, transcribe, etc.).
   * See {@link ConvertToPdfFn}. Supported for types like docx, excel, etc. that can be "pdfified".
   */
  convertToPdf?: ConvertToPdfFn;
}

export interface SliceOptions {
  signal?: AbortSignal;
  slicer?: string;
  maxChars?: number;
  minChars?: number;
  /** Ordered boundary strings a slicer prefers to break on, longest-context first. Slicer-specific defaults apply. */
  boundaries?: string[];
  /**
   * Strategy used to split text into segments. Defaults to the built-in lossless, offset-exact
   * boundary segmenter. Provide e.g. a LangChain-backed segmenter for overlap / token sizing /
   * language-aware splitting. Can be set per type via the registry's `configureType`.
   */
  segmenter?: TextSegmenter;
  includeResourceLocation?: boolean;
  includeResourceType?: boolean;
  includePartLocation?: boolean;
  includePartKind?: boolean;
  includeContext?: boolean;
  includeLinks?: boolean;
  embedSeparator?: string;
  buildEmbedText?: (context: EmbedTextContext) => string;
  /** Options for code slicing behavior. */
  code?: CodeParserOptions;
  /**
   * Summarizes resources and/or sections (see {@link SliceOptions.summaryScope}); the results land
   * in each slice's `context.summary` / `context.sectionSummary` and in its embed text. Summaries
   * are cached on `resource.metadata.summary` / `resource.metadata.sectionSummaries`, so slicing
   * the same (or a cached) resource again does not re-summarize.
   */
  summarize?: SummarizeFn;
  /** What to summarize: "resource" (default), "section", or "both". */
  summaryScope?: "resource" | "section" | "both";
  /** Maximum concurrent {@link SliceOptions.summarize} calls. Defaults to 4. */
  summaryConcurrency?: number;
  /** Sections whose text is shorter than this are not summarized. Defaults to 0 (summarize all). */
  minSectionSummaryChars?: number;
}

export interface ResolveOptions {
  signal?: AbortSignal;
  baseLocation?: string;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
  /** Timeout for fetching a URL (headers and body), in milliseconds. Defaults to 30000. 0 disables. */
  timeoutMs?: number;
  /** Maximum bytes to download for a URL. Defaults to 50 MiB. 0 disables. */
  maxBytes?: number;
  /** The fetch function URLs are fetched with. Defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Runs script-built web pages; see {@link PageRenderer}. */
  renderer?: PageRenderer;
  /** When fetched html goes through {@link ResolveOptions.renderer}. Defaults to `auto`. */
  render?: RenderMode;
  /** How folders are listed. */
  folder?: FolderOptions;
}

export interface LoadResourceOptions extends ParseOptions, SliceOptions, ResolveOptions {
  type?: ResourceType;
  name?: string;
  mimeType?: string;
}

export interface LoadedResource {
  source: ResourceSource;
  resource: ParsedResource;
  slices: ResourceSlice[];
}

export interface ResourceSupport {
  type: ResourceType;
  parserId?: string;
  slicerId?: string;
  parser: boolean;
  slicer: boolean;
  supported: boolean;
}

export interface ResourceRegistryLike {
  inferType(location: string, mimeType?: string): ResourceType | undefined;
  getDefaultSlicer(type: ResourceType): string | undefined;
  /** Returns the per-type parse config registered on the registry for this type, if any. */
  getTypeConfig(type: ResourceType): Partial<ParseOptions> | undefined;
  resolveLink(link: string, options?: ResolveOptions): Promise<ResourceSource>;
  /** Runs the parser stack for an already-resolved source, falling back through registered parsers. */
  parseSource(source: ResourceSource, options?: ParseOptions): Promise<ParsedResource>;
  /** True when a converter is registered for the type. */
  hasConverter(type: ResourceType): boolean;
  /**
   * Runs the converter stack for an already-resolved source: the LLM-ready version of it, or undefined when no
   * converter is registered for its type (its raw text is the LLM-ready form).
   */
  convertSource(source: ResourceSource, options?: ParseOptions): Promise<ResourceVersion | undefined>;
}

export interface SupportContext {
  registry: ResourceRegistryLike;
  signal?: AbortSignal;
}

export interface ParserContext {
  registry: ResourceRegistryLike;
  options: ParseOptions;
}

export interface SlicerContext {
  registry: ResourceRegistryLike;
  options: SliceOptions;
}

export interface ResolverContext {
  registry: ResourceRegistryLike;
  options: ResolveOptions;
}

export interface ResourceParser {
  id: string;
  supportedTypes: ResourceType[];
  defaultSlicer: string | Partial<Record<ResourceType, string>>;
  /**
   * Relative ordering within a type's parser stack. Higher priority parsers are attempted first
   * before falling back to lower priority ones; ties are broken by most-recent registration so a
   * later parser overrides an earlier one of equal priority. Defaults to 0.
   */
  priority?: number;
  isSupported?: (type: ResourceType, context: SupportContext) => boolean | Promise<boolean>;
  /**
   * Parses the source into a resource. Returning `undefined` declines this source so the registry
   * falls back to the next parser in the stack (e.g. a render-based PDF parser that is not configured
   * yields to the plain text-extraction parser). Throwing also triggers fallback to the next parser.
   */
  parse: (source: ResourceSource, context: ParserContext) => Promise<ParsedResource | undefined>;
}

/** Options controlling how a parser is placed within a type's parser stack. */
export interface RegisterParserOptions {
  /** Overrides the parser's own `priority`. Higher is attempted first. Defaults to the parser's priority or 0. */
  priority?: number;
}

/** What a converter is given besides the source. */
export interface ConverterContext {
  registry: ResourceRegistryLike;
  options: ParseOptions;
}

/**
 * Turns a raw resource into its LLM-ready version ({@link ResourceVersion}): html into clean markdown, a spreadsheet
 * into tables, a pdf into page text. Converters for a type form a stack like parsers do: the highest priority is
 * tried first, and one that declines (returns undefined) or throws falls back to the next.
 */
export interface ResourceConverter {
  id: string;
  supportedTypes: ResourceType[];
  /** Order within a type's stack: higher first, ties to the most recently registered. Defaults to 0. */
  priority?: number;
  /** Whether the converter can run here (its optional dependency is installed). Defaults to true. */
  isSupported?: (type: ResourceType, context: SupportContext) => boolean | Promise<boolean>;
  convert: (source: ResourceSource, context: ConverterContext) => Promise<ResourceVersion | undefined>;
}

export interface ResourceSlicer {
  id: string;
  supportedTypes: ResourceType[];
  isSupported?: (type: ResourceType, context: SupportContext) => boolean | Promise<boolean>;
  slice: (resource: ParsedResource, context: SlicerContext) => Promise<ResourceSlice[]>;
}

export interface ResourceResolver {
  id: string;
  canResolve: (link: string, context: ResolverContext) => boolean | Promise<boolean>;
  resolve: (link: string, context: ResolverContext) => Promise<ResourceSource | undefined>;
  /**
   * Cheaply determines the canonical location (and, if available, modified time) of a link without
   * loading its contents. Used for de-duplication and incremental-build decisions when walking a
   * resource graph. Optional; resolvers that cannot probe cheaply may omit it.
   */
  stat?: (link: string, context: ResolverContext) => Promise<ResourceStat | undefined>;
}
