import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  LoadedResource,
  LoadResourceOptions,
  ParsedResource,
  ParseOptions,
  RegisterParserOptions,
  ResolveOptions,
  ResourceParser,
  ResourceRegistryLike,
  ResourceResolver,
  ResourceSlice,
  ResourceSlicer,
  ResourceSource,
  ResourceStat,
  ResourceSupport,
  ResourceType,
  SliceOptions,
  SupportContext
} from "./types";
import {
  DEFAULT_EXTENSION_TYPES,
  DEFAULT_MIME_TYPE_PATTERNS,
  assertNotAborted,
  basenameFromLocation,
  createResourceId,
  dedupeLinks,
  inferTypeFromExtension,
  inferTypeFromLocation,
  inferTypeFromMimePatterns,
  isSelfContainedLocation,
  mergeOptions
} from "./utils";

interface ParserEntry {
  id: string;
  priority: number;
  order: number;
}

/** Declarative definition of how a resource type is detected, registered on the registry. */
export interface ResourceTypeDefinition {
  type: ResourceType;
  /** File extensions (with or without leading dot) that map to this type. */
  extensions?: string[];
  /** Mime-type patterns that map to this type. */
  mimePatterns?: RegExp[];
}

export class ResourceRegistry implements ResourceRegistryLike {
  private readonly parsers = new Map<string, ResourceParser>();
  private readonly slicers = new Map<string, ResourceSlicer>();
  private readonly resolvers: ResourceResolver[] = [];
  private readonly parserTypes = new Map<ResourceType, ParserEntry[]>();
  private readonly slicerTypes = new Map<ResourceType, string>();
  private readonly typeConfigs = new Map<ResourceType, Partial<LoadResourceOptions>>();
  private readonly extensionTypes = new Map<string, ResourceType>(Object.entries(DEFAULT_EXTENSION_TYPES));
  private readonly mimeTypePatterns: Array<[RegExp, ResourceType]> = [...DEFAULT_MIME_TYPE_PATTERNS];
  private parserOrder = 0;

  registerParser(parser: ResourceParser, options: RegisterParserOptions = {}): this {
    this.parsers.set(parser.id, parser);
    const priority = options.priority ?? parser.priority ?? 0;

    for (const type of parser.supportedTypes) {
      const entries = (this.parserTypes.get(type) ?? []).filter((entry) => entry.id !== parser.id);
      entries.push({ id: parser.id, priority, order: this.parserOrder++ });
      // Higher priority first; ties broken by most-recent registration so later parsers override earlier ones.
      entries.sort((a, b) => b.priority - a.priority || b.order - a.order);
      this.parserTypes.set(type, entries);
      this.recomputeDefaultSlicer(type);
    }

    return this;
  }

  /**
   * Registers per-type options on the registry, covering both parse and slice behavior. These are
   * merged underneath any per-call options (per-call wins), letting callers configure capabilities
   * once — e.g. `renderPdfPages` / `convertToPdf`, PDF flags, `maxChars`/`minChars`, slicer choice,
   * code patterns, or boundary strings — per type rather than on every call.
   */
  configureType(type: ResourceType, options: Partial<LoadResourceOptions>): this {
    const existing = this.typeConfigs.get(type) ?? {};
    this.typeConfigs.set(type, mergeOptions(existing, options));
    return this;
  }

  getTypeConfig(type: ResourceType): Partial<LoadResourceOptions> | undefined {
    return this.typeConfigs.get(type);
  }

  /** Returns the parsers registered for a type, ordered from highest to lowest priority. */
  getParsers(type: ResourceType): ResourceParser[] {
    const entries = this.parserTypes.get(type) ?? [];
    return entries.map((entry) => this.parsers.get(entry.id)).filter((parser): parser is ResourceParser => Boolean(parser));
  }

  private recomputeDefaultSlicer(type: ResourceType): void {
    for (const parser of this.getParsers(type)) {
      const defaultSlicer = typeof parser.defaultSlicer === "string" ? parser.defaultSlicer : parser.defaultSlicer[type];
      if (defaultSlicer) {
        this.slicerTypes.set(type, defaultSlicer);
        return;
      }
    }
  }

  registerSlicer(slicer: ResourceSlicer): this {
    this.slicers.set(slicer.id, slicer);
    return this;
  }

  registerResolver(resolver: ResourceResolver): this {
    this.resolvers.push(resolver);
    return this;
  }

  inferType(location: string, mimeType?: string): ResourceType | undefined {
    return inferTypeFromMimePatterns(mimeType, this.mimeTypePatterns)
      ?? inferTypeFromExtension(location, this.extensionTypes);
  }

  /** Maps a file extension (with or without leading dot) to a resource type. */
  registerExtensionType(extension: string, type: ResourceType): this {
    const normalized = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    this.extensionTypes.set(normalized, type);
    return this;
  }

  /** Maps a mime-type pattern to a resource type. Newly registered patterns take precedence. */
  registerMimeType(pattern: RegExp, type: ResourceType): this {
    this.mimeTypePatterns.unshift([pattern, type]);
    return this;
  }

  /** Registers a resource type's detection rules (extensions and/or mime patterns) in one call. */
  registerType(definition: ResourceTypeDefinition): this {
    for (const extension of definition.extensions ?? []) {
      this.registerExtensionType(extension, definition.type);
    }
    for (const pattern of definition.mimePatterns ?? []) {
      this.registerMimeType(pattern, definition.type);
    }
    return this;
  }

  getDefaultSlicer(type: ResourceType): string | undefined {
    return this.slicerTypes.get(type);
  }

  getParser(type: ResourceType): ResourceParser | undefined {
    return this.getParsers(type)[0];
  }

  getSlicer(typeOrId: ResourceType): ResourceSlicer | undefined {
    return this.slicers.get(typeOrId) ?? (this.slicerTypes.has(typeOrId) ? this.slicers.get(this.slicerTypes.get(typeOrId)!) : undefined);
  }

  async getTypeSupport(type: ResourceType, signal?: AbortSignal): Promise<ResourceSupport> {
    const parsers = this.getParsers(type);
    const slicerId = this.getDefaultSlicer(type);
    const slicer = slicerId ? this.slicers.get(slicerId) : undefined;
    const context: SupportContext = { registry: this, signal };

    // A type is parseable if any parser in its stack reports support.
    let parserSupported = false;
    let supportingParser: ResourceParser | undefined;
    for (const parser of parsers) {
      if (await parser.isSupported?.(type, context) ?? true) {
        parserSupported = true;
        supportingParser = parser;
        break;
      }
    }

    const slicerSupported = slicer ? await slicer.isSupported?.(type, context) ?? true : false;

    return {
      type,
      parserId: (supportingParser ?? parsers[0])?.id,
      slicerId,
      parser: parserSupported,
      slicer: slicerSupported,
      supported: parserSupported && slicerSupported && parsers.length > 0 && Boolean(slicer)
    };
  }

  async isTypeSupported(type: ResourceType, signal?: AbortSignal): Promise<boolean> {
    const support = await this.getTypeSupport(type, signal);
    return support.supported;
  }

  async canResolve(link: string, options: ResolveOptions = {}): Promise<boolean> {
    const context = { registry: this, options };
    for (const resolver of this.resolvers) {
      if (await resolver.canResolve(link, context)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Cheaply probes a link for its canonical location and modified time without loading it, using the
   * first resolver that can both resolve and stat it. Returns undefined when no resolver supports it
   * or none can stat cheaply. Useful for de-duplication and incremental-build decisions.
   */
  async statLink(link: string, options: ResolveOptions = {}): Promise<ResourceStat | undefined> {
    assertNotAborted(options.signal);
    const context = { registry: this, options };
    for (const resolver of this.resolvers) {
      if (!resolver.stat) continue;
      if (await resolver.canResolve(link, context)) {
        const result = await resolver.stat(link, context);
        if (result) return result;
      }
    }
    return undefined;
  }

  async resolveLink(link: string, options: ResolveOptions = {}): Promise<ResourceSource> {
    assertNotAborted(options.signal);
    const context = { registry: this, options };

    for (const resolver of this.resolvers) {
      if (await resolver.canResolve(link, context)) {
        const source = await resolver.resolve(link, context);
        if (source) {
          return this.normalizeSource(source, options);
        }
      }
    }

    throw new Error(`No resolver available for resource link: ${link}`);
  }

  /**
   * Resolves a fully-qualified, self-contained location (an http(s) URL, an absolute file path /
   * file:// URL, or a zip-entry location) directly to a source — no base location required. Throws if
   * the location is relative and therefore cannot be fetched on its own; pass `resolveLink` with a
   * `baseLocation` for relative links instead.
   */
  async locate(location: string, options: ResolveOptions = {}): Promise<ResourceSource> {
    if (!isSelfContainedLocation(location)) {
      throw new Error(`Location is not self-contained and cannot be fetched without a base: ${location}`);
    }
    return this.resolveLink(location, options);
  }

  /** Returns the id of the first resolver that can handle a link, or undefined if none can. */
  async getResolverId(link: string, options: ResolveOptions = {}): Promise<string | undefined> {
    const context = { registry: this, options };
    for (const resolver of this.resolvers) {
      if (await resolver.canResolve(link, context)) {
        return resolver.id;
      }
    }
    return undefined;
  }

  async parse(input: string | ResourceSource, options: LoadResourceOptions = {}): Promise<{ source: ResourceSource; resource: ParsedResource }> {
    const source = typeof input === "string"
      ? await this.resolveLink(input, options)
      : await this.normalizeSource(input, options);

    const resource = await this.parseSource(source, options satisfies ParseOptions);
    return { source, resource };
  }

  /**
   * Runs the parser stack for an already-resolved source. Parsers are attempted in priority order;
   * a parser that returns `undefined` (declines) or throws causes a fallback to the next parser.
   * If every parser throws, the collected errors are surfaced.
   */
  async parseSource(source: ResourceSource, options: ParseOptions = {}): Promise<ParsedResource> {
    const type = source.type!;
    const parsers = this.getParsers(type);
    if (parsers.length === 0) {
      throw new Error(`No parser registered for resource type: ${type}`);
    }

    const mergedOptions = mergeOptions(this.typeConfigs.get(type), options);
    const context = { registry: this, options: mergedOptions };
    const errors: unknown[] = [];

    for (const parser of parsers) {
      assertNotAborted(mergedOptions.signal);
      try {
        const resource = await parser.parse(source, context);
        if (resource) {
          resource.links = dedupeLinks(resource.links);
          return resource;
        }
        // Parser declined; fall through to the next one in the stack.
      } catch (error) {
        // Never swallow aborts — propagate immediately rather than falling back.
        if (mergedOptions.signal?.aborted) {
          throw error;
        }
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `All ${errors.length} parsers failed for resource type: ${type}`);
    }
    throw new Error(`No parser could parse resource type: ${type} (all parsers declined)`);
  }

  async slice(resource: ParsedResource, options: SliceOptions = {}): Promise<ResourceSlice[]> {
    // Merge per-type registry options (maxChars, slicer, boundaries, code patterns, …) under per-call.
    const mergedOptions = mergeOptions(this.typeConfigs.get(resource.type), options);
    const slicerId = mergedOptions.slicer ?? resource.defaultSlicer ?? this.getDefaultSlicer(resource.type);
    if (!slicerId) {
      throw new Error(`No default slicer registered for resource type: ${resource.type}`);
    }

    const slicer = this.slicers.get(slicerId);
    if (!slicer) {
      throw new Error(`Unknown slicer: ${slicerId}`);
    }

    const supported = await slicer.isSupported?.(resource.type, { registry: this, signal: mergedOptions.signal }) ?? true;
    if (!supported) {
      throw new Error(`Slicer ${slicer.id} reported that type ${resource.type} is not supported in this environment`);
    }

    const slices = await slicer.slice(resource, { registry: this, options: mergedOptions });
    return slices;
  }

  async load(input: string | ResourceSource, options: LoadResourceOptions = {}): Promise<LoadedResource> {
    const { source, resource } = await this.parse(input, options);
    const slices = await this.slice(resource, options);
    return { source, resource, slices };
  }

  private async normalizeSource(source: ResourceSource, options: LoadResourceOptions | ResolveOptions): Promise<ResourceSource> {
    const location = source.location;
    const fallbackMimeType = "mimeType" in options ? options.mimeType : undefined;
    const inferredType = source.type ?? this.inferType(location, source.mimeType ?? fallbackMimeType);

    if (!inferredType) {
      throw new Error(`Unable to infer resource type for ${location}`);
    }

    return {
      ...source,
      type: inferredType,
      name: source.name ?? ("name" in options ? options.name : undefined) ?? basenameFromLocation(location),
      mimeType: source.mimeType ?? fallbackMimeType,
      metadata: {
        ...(options.metadata ?? {}),
        ...(source.metadata ?? {})
      }
    };
  }
}

export async function createFileResourceSource(filePath: string, type?: ResourceType): Promise<ResourceSource> {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  const [input, stats] = await Promise.all([
    readFile(absolutePath),
    stat(absolutePath).catch(() => undefined)
  ]);
  return {
    location: absolutePath,
    input,
    type,
    name: path.basename(absolutePath),
    modifiedAt: stats?.mtimeMs,
    size: stats?.size
  };
}

export function createUrlResourceSource(url: string, input: Uint8Array, mimeType?: string): ResourceSource {
  return {
    location: url,
    input,
    mimeType,
    type: inferTypeFromLocation(url, mimeType),
    name: basenameFromLocation(url)
  };
}

export function toFileUrl(location: string): string {
  return pathToFileURL(location).toString();
}

export function createParsedResource(source: ResourceSource): ParsedResource {
  const type = source.type!;
  return {
    id: createResourceId(source.location, type),
    location: source.location,
    type,
    name: source.name ?? basenameFromLocation(source.location),
    mimeType: source.mimeType,
    modifiedAt: source.modifiedAt,
    size: source.size,
    metadata: source.metadata,
    defaultSlicer: "text",
    parts: [],
    links: []
  };
}
