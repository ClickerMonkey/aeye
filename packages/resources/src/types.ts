import type { Readable } from "node:stream";

export type ResourceType = string;
export type ResourceInput = string | Uint8Array | ArrayBuffer | URL | Readable | ReadableStream<Uint8Array> | AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array> | (() => AsyncIterable<Uint8Array>);
export type ResourceLocation = string;
export type ResourcePartKind = "text" | "image";

/** A function that renders a URL to HTML (e.g. using puppeteer). */
export type RenderUrlFn = (url: string, signal?: AbortSignal) => Promise<string>;

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
  metadata?: Record<string, unknown>;
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
   * Renders all pages of a PDF to image files in a directory.
   * Receives the PDF file path and an output directory; should write one image per page.
   * Returns the list of rendered page files. This avoids loading the entire PDF into memory.
   */
  renderPdfPages?: (pdfFilePath: string, outputDir: string, dpi: number, signal?: AbortSignal) => Promise<RenderedPage[]>;
}

export interface SliceOptions {
  signal?: AbortSignal;
  slicer?: string;
  maxChars?: number;
  minChars?: number;
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
  resolveLink(link: string, options?: ResolveOptions): Promise<ResourceSource>;
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
  isSupported?: (type: ResourceType, context: SupportContext) => boolean | Promise<boolean>;
  parse: (source: ResourceSource, context: ParserContext) => Promise<ParsedResource>;
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
}
