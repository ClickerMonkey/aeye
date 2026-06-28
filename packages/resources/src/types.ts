import type { Readable } from "node:stream";

export type ResourceType = string;
export type ResourceInput = string | Uint8Array | ArrayBuffer | URL | Readable | AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>;
export type ResourceLocation = string;
export type ResourcePartKind = "text" | "image";

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

export interface ParseOptions {
  signal?: AbortSignal;
  describeImage?: (image: Uint8Array, part: ResourcePart, source: ResourceSource) => Promise<string | undefined>;
  transcribeImage?: (image: Uint8Array, part: ResourcePart, source: ResourceSource) => Promise<string | undefined>;
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
