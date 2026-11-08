/**
 * Parsers built on converters: the source is converted to its LLM-ready version (through the registry's converter
 * stack for its type, else a fallback converter) and the resource's parts are cut from that version, so slicing and
 * sectioning both work from the converted form. The version is kept on the resource (`resource.version`).
 */
import { Buffer } from "node:buffer";
import { createParsedResource } from "../registry";
import type { ParsedResource, ParserContext, ResourceConverter, ResourceLink, ResourceParser, ResourcePart, ResourceSource, ResourceType } from "../types";
import { assertNotAborted, collectInput, createPartId, dedupeLinks, extractLinksFromMarkdown, extractLinksFromText } from "../utils";
import { BLOCK_SEPARATOR, type ResourceVersion, type Table, tableBlock, versionText } from "../versions";

/** What a part's links are found from. */
export interface PartLinkContext {
  /** The source's raw bytes. */
  readonly raw: Uint8Array;
  /** The part's text (from the version). */
  readonly text: string;
  /** The part's location, which its links are recorded at. */
  readonly location: string;
  readonly version: ResourceVersion;
}

/** How a version parser is made. */
export interface VersionParserSpec {
  id: string;
  supportedTypes: ResourceType[];
  defaultSlicer: string;
  priority?: number;
  /** The converter used when the registry has none for the source's type. Its `isSupported` is the parser's. */
  fallback: ResourceConverter;
  /** The links of a part. Defaults to {@link versionPartLinks}. */
  links?: (context: PartLinkContext) => ResourceLink[];
}

/** A part's links by default: markdown links in a markdown version, and bare URLs in any text. */
export function versionPartLinks(context: PartLinkContext): ResourceLink[] {
  return [
    ...(context.version.kind === "markdown" ? extractLinksFromMarkdown(context.text, context.location) : []),
    ...extractLinksFromText(context.text, context.location),
  ];
}

/** A text part of a resource. */
interface PartDraft {
  readonly location: string;
  readonly text: string;
  readonly pageNumber?: number;
  readonly metadata?: Record<string, unknown>;
}

/** Groups a table version's tables by sheet, in order (tables without a sheet form one group). */
function sheetGroups(tables: readonly Table[]): Table[][] {
  const groups: Table[][] = [];
  for (const table of tables) {
    const last = groups[groups.length - 1];
    if (last && last[0]?.sheetIndex === table.sheetIndex) {
      last.push(table);
    } else {
      groups.push([table]);
    }
  }
  return groups;
}

/** The parts a version is cut into: a page per part for pages, a sheet per part for tables, else one part. */
export function versionParts(location: string, version: ResourceVersion): PartDraft[] {
  switch (version.kind) {
    case "pages":
      return version.pages.flatMap((text, i) => (text.trim() === "" ? [] : [{ location: `${location}#page/${i + 1}`, text, pageNumber: i + 1 }]));
    case "table":
      return sheetGroups(version.tables).map((group, i) => {
        const first = group[0];
        const sheetIndex = first?.sheetIndex;
        return {
          location: sheetIndex === undefined ? `${location}#part/${i}` : `${location}#sheet/${sheetIndex}`,
          text: group.map(tableBlock).join(BLOCK_SEPARATOR),
          metadata: {
            ...(first?.sheetName !== undefined ? { sheetName: first.sheetName, sheetIndex } : {}),
            tables: group.map((table) => ({ name: table.name, headers: table.headers, rowCount: table.rows.length })),
          },
        };
      });
    case "markdown":
    case "text":
    case "code":
      return [{ location: `${location}#part/0`, text: versionText(version) }];
  }
}

/** Converts a source with the registry's converters for its type, else the fallback. */
async function convert(source: ResourceSource, context: ParserContext, fallback: ResourceConverter): Promise<ResourceVersion | undefined> {
  const type = source.type ?? fallback.supportedTypes[0];
  return type !== undefined && context.registry.hasConverter(type)
    ? context.registry.convertSource(source, context.options)
    : fallback.convert(source, { registry: context.registry, options: context.options });
}

/** Builds a resource from a source and its version. */
export function resourceFromVersion(source: ResourceSource, version: ResourceVersion, raw: Uint8Array, spec: Pick<VersionParserSpec, "defaultSlicer" | "links">): ParsedResource {
  const resource = createParsedResource(source);
  resource.defaultSlicer = spec.defaultSlicer;
  resource.version = version;
  const links = spec.links ?? versionPartLinks;
  resource.parts = versionParts(resource.location, version).map((draft, i): ResourcePart => ({
    id: createPartId(resource, i),
    location: draft.location,
    kind: "text",
    text: draft.text,
    ...(draft.pageNumber !== undefined ? { pageNumber: draft.pageNumber } : {}),
    metadata: { ...draft.metadata, originalType: version.from },
    links: dedupeLinks(links({ raw, text: draft.text, location: draft.location, version })),
  }));
  resource.links = dedupeLinks(resource.parts.flatMap((part) => part.links ?? []));
  return resource;
}

/** A parser that converts the source and cuts its parts from the version; it declines when conversion declines. */
export function createVersionParser(spec: VersionParserSpec): ResourceParser {
  return {
    id: spec.id,
    supportedTypes: spec.supportedTypes,
    defaultSlicer: spec.defaultSlicer,
    ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
    isSupported: (type, context) => spec.fallback.isSupported?.(type, context) ?? true,
    async parse(source, context) {
      assertNotAborted(context.options.signal);
      const raw = await collectInput(source.input);
      const version = await convert({ ...source, input: raw }, context, spec.fallback);
      return version === undefined ? undefined : resourceFromVersion(source, version, raw, spec);
    },
  };
}

/** A source's raw bytes as utf-8 text. */
export function rawText(raw: Uint8Array): string {
  return Buffer.from(raw).toString("utf8");
}
