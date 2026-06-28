import { readFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { ResourceRegistry, createParsedResource, createUrlResourceSource } from "./registry.js";
import type {
  ParsedResource,
  ResourceLink,
  ResourceParser,
  ResourcePart,
  ResourceResolver,
  ResourceSlice,
  ResourceSlicer,
  ResourceSource
} from "./types.js";
import {
  CODE_TYPES,
  assertNotAborted,
  collectInput,
  createLinkId,
  createPartId,
  createSliceId,
  dedupeLinks,
  extractLinksFromCode,
  extractLinksFromHtml,
  extractLinksFromMarkdown,
  extractLinksFromText,
  finalizeSlice,
  htmlToMarkdown,
  normalizeDeclaration,
  splitTextByBoundaries,
  toFilePath,
  toHeadingContext
} from "./utils.js";

const TEXT_LIKE_TYPES = [
  "text",
  "json",
  "csv",
  "tsv",
  "yaml",
  "xml",
  "svg",
  "toml",
  "ini",
  ...CODE_TYPES
] as const;

function getDefaultSlicerForTextType(type: string): string {
  if (type === "markdown" || type === "html") {
    return "markdown";
  }
  if (CODE_TYPES.includes(type as typeof CODE_TYPES[number])) {
    return "code";
  }
  return "text";
}

const textParser: ResourceParser = {
  id: "text-parser",
  supportedTypes: [...TEXT_LIKE_TYPES, "markdown", "html"],
  defaultSlicer: Object.fromEntries([...TEXT_LIKE_TYPES, "markdown", "html"].map((type) => [type, getDefaultSlicerForTextType(type)])),
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const rawText = Buffer.from(await collectInput(source.input)).toString("utf8");
    const resource = createParsedResource(source);
    resource.defaultSlicer = getDefaultSlicerForTextType(resource.type);
    const text = source.type === "html" ? htmlToMarkdown(rawText) : rawText;
    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text,
      metadata: source.type === "html" ? { originalType: "html" } : undefined,
      links: dedupeLinks([
        ...(source.type === "markdown" ? extractLinksFromMarkdown(text, `${resource.location}#part/0`) : []),
        ...(source.type === "html" ? extractLinksFromHtml(rawText, `${resource.location}#part/0`) : []),
        ...(CODE_TYPES.includes(source.type as typeof CODE_TYPES[number]) ? extractLinksFromCode(text, `${resource.location}#part/0`) : []),
        ...extractLinksFromText(text, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};

const imageParser: ResourceParser = {
  id: "image-parser",
  supportedTypes: ["image"],
  defaultSlicer: "text",
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const data = await collectInput(source.input);
    const resource = createParsedResource(source);
    resource.defaultSlicer = "text";

    const imagePart: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#image/0`,
      kind: "image",
      mimeType: source.mimeType,
      data
    };

    const parts: ResourcePart[] = [imagePart];

    const transcript = await context.options.transcribeImage?.(data, imagePart, source);
    if (transcript) {
      parts.push({
        id: createPartId(resource, parts.length),
        location: `${resource.location}#transcript/0`,
        kind: "text",
        text: transcript,
        links: extractLinksFromText(transcript, `${resource.location}#transcript/0`)
      });
    }

    const description = await context.options.describeImage?.(data, imagePart, source);
    if (description) {
      parts.push({
        id: createPartId(resource, parts.length),
        location: `${resource.location}#description/0`,
        kind: "text",
        text: description,
        links: extractLinksFromText(description, `${resource.location}#description/0`)
      });
    }

    resource.parts = parts;
    resource.links = dedupeLinks(parts.flatMap((part) => part.links ?? []));
    return resource;
  }
};

const textSlicer: ResourceSlicer = {
  id: "text",
  supportedTypes: ["*"],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? 2000;
    const minChars = context.options.minChars ?? 400;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const segments = splitTextByBoundaries(part.text, maxChars, minChars);
      segments.forEach((segment, index) => {
        const rawSlice = {
          id: createSliceId(part, slices.length),
          resourceId: resource.id,
          partId: part.id,
          location: `${part.location}#slice/${index}`,
          text: segment.text,
          start: segment.start,
          end: segment.end,
          links: dedupeLinks([
            ...(part.links ?? []).filter((link) => part.text?.includes(link.value)),
            ...extractLinksFromText(segment.text, `${part.location}#slice/${index}`)
          ])
        };
        slices.push(finalizeSlice(resource, part, rawSlice, context.options));
      });
    }

    return slices;
  }
};

const markdownSlicer: ResourceSlicer = {
  id: "markdown",
  supportedTypes: ["markdown", "html"],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? 2000;
    const minChars = context.options.minChars ?? 400;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const text = part.text;
      const headingMatches = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)];
      const sections = headingMatches.length === 0
        ? [{ start: 0, end: text.length, headings: [] as string[] }]
        : headingMatches.map((match, index) => {
            const level = match[1].length;
            const title = match[2].trim();
            const start = match.index ?? 0;
            const end = headingMatches[index + 1]?.index ?? text.length;
            const headings = headingMatches
              .slice(0, index + 1)
              .reduce<string[]>((stack, current) => {
                const currentLevel = current[1].length;
                const currentTitle = current[2].trim();
                stack.splice(currentLevel - 1);
                stack[currentLevel - 1] = currentTitle;
                return stack.filter(Boolean);
              }, [])
              .slice(0, level);
            return { start, end, headings: headings.length > 0 ? headings : [title] };
          });

      sections.forEach((section, sectionIndex) => {
        const sectionText = text.slice(section.start, section.end);
        const segments = splitTextByBoundaries(sectionText, maxChars, minChars, ["\n\n", "\n", ". ", " "]);
        segments.forEach((segment, index) => {
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location: `${part.location}#section/${sectionIndex}/slice/${index}`,
            text: segment.text,
            start: section.start + segment.start,
            end: section.start + segment.end,
            context: toHeadingContext(section.headings),
            links: dedupeLinks([
              ...extractLinksFromMarkdown(segment.text, `${part.location}#section/${sectionIndex}/slice/${index}`),
              ...extractLinksFromText(segment.text, `${part.location}#section/${sectionIndex}/slice/${index}`)
            ])
          };
          slices.push(finalizeSlice(resource, part, rawSlice, context.options));
        });
      });
    }

    return slices;
  }
};

const codeSlicer: ResourceSlicer = {
  id: "code",
  supportedTypes: [...CODE_TYPES],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? 2000;
    const minChars = context.options.minChars ?? 400;
    const declarationPattern = /^(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\s+([^=(<{]+)/;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const lines = part.text.split(/(?<=\n)/);
      const declarationIndexes: number[] = [];
      let offset = 0;
      const importLines: string[] = [];

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (/^(import|export\s+.*from\s+|const\s+.*=\s*require\()/.test(trimmed)) {
          importLines.push(normalizeDeclaration(trimmed));
        }
        if (declarationPattern.test(trimmed)) {
          declarationIndexes.push(offset);
        }
        offset += line.length;
      });

      const starts = declarationIndexes.length > 0 ? declarationIndexes : [0];
      starts.forEach((start, index) => {
        const end = starts[index + 1] ?? part.text!.length;
        const block = part.text!.slice(start, end);
        const declaration = normalizeDeclaration(block.split(/\r?\n/, 1)[0] ?? "");
        const segments = splitTextByBoundaries(block, maxChars, minChars, ["\n\n", "\n", " "]);

        segments.forEach((segment, segmentIndex) => {
          const location = `${part.location}#block/${index}/slice/${segmentIndex}`;
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location,
            text: segment.text,
            start: start + segment.start,
            end: start + segment.end,
            context: {
              declaration,
              prefixes: importLines.slice(0, 5)
            },
            links: dedupeLinks([
              ...(part.links ?? []),
              ...extractLinksFromCode(segment.text, location),
              ...extractLinksFromText(segment.text, location)
            ])
          };
          slices.push(finalizeSlice(resource, part, rawSlice, context.options));
        });
      });
    }

    return slices;
  }
};

const fileResolver: ResourceResolver = {
  id: "file",
  canResolve(link, context) {
    if (link.startsWith("http://") || link.startsWith("https://")) {
      return false;
    }

    if (path.isAbsolute(link) || link.startsWith("file://")) {
      return true;
    }

    return Boolean(context.options.baseLocation && !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(link));
  },
  async resolve(link, context) {
    assertNotAborted(context.options.signal);
    const baseLocation = context.options.baseLocation;
    const resolvedPath = link.startsWith("file://")
      ? toFilePath(link)
      : path.isAbsolute(link)
        ? link
        : baseLocation
          ? path.resolve(path.dirname(toFilePath(baseLocation)), link)
          : undefined;

    if (!resolvedPath) {
      return undefined;
    }

    const input = await readFile(resolvedPath);
    return {
      location: resolvedPath,
      input,
      name: path.basename(resolvedPath)
    };
  }
};

const urlResolver: ResourceResolver = {
  id: "url",
  canResolve(link) {
    return /^https?:\/\//i.test(link);
  },
  async resolve(link, context) {
    assertNotAborted(context.options.signal);
    const response = await fetch(link, {
      headers: context.options.headers,
      signal: context.options.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to resolve ${link}: ${response.status} ${response.statusText}`);
    }

    const input = new Uint8Array(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") ?? undefined;
    return createUrlResourceSource(link, input, mimeType);
  }
};

export function createDefaultResourceRegistry(): ResourceRegistry {
  return new ResourceRegistry()
    .registerParser(textParser)
    .registerParser(imageParser)
    .registerSlicer(textSlicer)
    .registerSlicer(markdownSlicer)
    .registerSlicer(codeSlicer)
    .registerResolver(fileResolver)
    .registerResolver(urlResolver);
}

export const defaultResourceRegistry = createDefaultResourceRegistry();
