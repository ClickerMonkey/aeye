import type { Readable } from "node:stream";

export type ResourceType = string;
export type ResourceInput = string | Uint8Array | ArrayBuffer | URL | Readable | ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array> | (() => AsyncIterable<Uint8Array>);
export type ResourceLocation = string;
export type ResourcePartKind = "text" | "image";

/** A function that renders a URL to HTML (e.g. using puppeteer). */
export type RenderUrlFn = (url: string, signal?: AbortSignal) => Promise<string>;

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
  summary?: string;
  prefixes?: string[];
}

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
}

export interface RenderedPage {
  /** Path to the rendered image file on disk. */
  filePath: string;
  /** 1-based page number. */
  pageNumber: number;
  /** MIME type of the image (e.g. "image/png"). */
  mimeType: string;
}

/** Structured table extracted from tabular data. */
export interface ExtractedTable {
  /** Optional name/title for the table. */
  name?: string;
  /** Column headers. */
  headers: string[];
  /** Rows of data (each row is an array of cell values). */
  rows: string[][];
  /** Sheet name if from a multi-sheet source. */
  sheetName?: string;
  /** 0-based sheet index if from a multi-sheet source. */
  sheetIndex?: number;
}

export interface ParseOptions {
  signal?: AbortSignal;
  describeImage?: (image: Uint8Array, part: ResourcePart, source: ResourceSource) => Promise<string | undefined>;
  transcribeImage?: (image: Uint8Array, part: ResourcePart, source: ResourceSource) => Promise<string | undefined>;
  /** Renders a URL to final HTML (e.g. after JS executes). Used for html resources when provided. */
  renderUrl?: RenderUrlFn;
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
}

export interface ResolveOptions {
  signal?: AbortSignal;
  baseLocation?: string;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
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
