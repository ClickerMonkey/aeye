import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  LoadedResource,
  LoadResourceOptions,
  ParsedResource,
  ParseOptions,
  ResolveOptions,
  ResourceParser,
  ResourceRegistryLike,
  ResourceResolver,
  ResourceSlice,
  ResourceSlicer,
  ResourceSource,
  ResourceSupport,
  ResourceType,
  SliceOptions,
  SupportContext
} from "./types";
import { assertNotAborted, basenameFromLocation, createResourceId, dedupeLinks, inferTypeFromLocation } from "./utils";

export class ResourceRegistry implements ResourceRegistryLike {
  private readonly parsers = new Map<string, ResourceParser>();
  private readonly slicers = new Map<string, ResourceSlicer>();
  private readonly resolvers: ResourceResolver[] = [];
  private readonly parserTypes = new Map<ResourceType, string>();
  private readonly slicerTypes = new Map<ResourceType, string>();

  registerParser(parser: ResourceParser): this {
    this.parsers.set(parser.id, parser);

    for (const type of parser.supportedTypes) {
      this.parserTypes.set(type, parser.id);
      const defaultSlicer = typeof parser.defaultSlicer === "string" ? parser.defaultSlicer : parser.defaultSlicer[type];
      if (defaultSlicer) {
        this.slicerTypes.set(type, defaultSlicer);
      }
    }

    return this;
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
    return inferTypeFromLocation(location, mimeType);
  }

  getDefaultSlicer(type: ResourceType): string | undefined {
    return this.slicerTypes.get(type);
  }

  getParser(type: ResourceType): ResourceParser | undefined {
    const parserId = this.parserTypes.get(type);
    return parserId ? this.parsers.get(parserId) : undefined;
  }

  getSlicer(typeOrId: ResourceType): ResourceSlicer | undefined {
    return this.slicers.get(typeOrId) ?? (this.slicerTypes.has(typeOrId) ? this.slicers.get(this.slicerTypes.get(typeOrId)!) : undefined);
  }

  async getTypeSupport(type: ResourceType, signal?: AbortSignal): Promise<ResourceSupport> {
    const parser = this.getParser(type);
    const slicerId = this.getDefaultSlicer(type);
    const slicer = slicerId ? this.slicers.get(slicerId) : undefined;
    const context: SupportContext = { registry: this, signal };
    const parserSupported = parser ? await parser.isSupported?.(type, context) ?? true : false;
    const slicerSupported = slicer ? await slicer.isSupported?.(type, context) ?? true : false;

    return {
      type,
      parserId: parser?.id,
      slicerId,
      parser: parserSupported,
      slicer: slicerSupported,
      supported: parserSupported && slicerSupported && Boolean(parser) && Boolean(slicer)
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

  async parse(input: string | ResourceSource, options: LoadResourceOptions = {}): Promise<{ source: ResourceSource; resource: ParsedResource }> {
    const source = typeof input === "string"
      ? await this.resolveLink(input, options)
      : await this.normalizeSource(input, options);

    const parser = this.getParser(source.type!);
    if (!parser) {
      throw new Error(`No parser registered for resource type: ${source.type}`);
    }

    const supported = await parser.isSupported?.(source.type!, { registry: this, signal: options.signal }) ?? true;
    if (!supported) {
      throw new Error(`Parser ${parser.id} reported that type ${source.type} is not supported in this environment`);
    }

    const resource = await parser.parse(source, { registry: this, options: options satisfies ParseOptions });
    resource.links = dedupeLinks(resource.links);
    return { source, resource };
  }

  async slice(resource: ParsedResource, options: SliceOptions = {}): Promise<ResourceSlice[]> {
    const slicerId = options.slicer ?? resource.defaultSlicer ?? this.getDefaultSlicer(resource.type);
    if (!slicerId) {
      throw new Error(`No default slicer registered for resource type: ${resource.type}`);
    }

    const slicer = this.slicers.get(slicerId);
    if (!slicer) {
      throw new Error(`Unknown slicer: ${slicerId}`);
    }

    const supported = await slicer.isSupported?.(resource.type, { registry: this, signal: options.signal }) ?? true;
    if (!supported) {
      throw new Error(`Slicer ${slicer.id} reported that type ${resource.type} is not supported in this environment`);
    }

    const slices = await slicer.slice(resource, { registry: this, options });
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

export function createFileResourceSource(filePath: string, type?: ResourceType): Promise<ResourceSource> {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  return readFile(absolutePath).then((input) => ({
    location: absolutePath,
    input,
    type,
    name: path.basename(absolutePath)
  }));
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
    metadata: source.metadata,
    defaultSlicer: "text",
    parts: [],
    links: []
  };
}
