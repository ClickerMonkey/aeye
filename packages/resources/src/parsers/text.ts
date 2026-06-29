import { Buffer } from "node:buffer";
import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart } from "../types";
import {
  DEFAULT_MARKUP_TYPES,
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromHtml,
  extractLinksFromText,
} from "../utils";

export const TEXT_LIKE_TYPES = [
  "text",
  "json",
  "csv",
  "tsv",
  "yaml",
  "xml",
  "svg",
  "toml",
  "ini",
] as const;

export const textParser: ResourceParser = {
  id: "text-parser",
  supportedTypes: [...TEXT_LIKE_TYPES],
  defaultSlicer: "text",
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const rawText = Buffer.from(await collectInput(source.input)).toString("utf8");
    const resource = createParsedResource(source);
    resource.defaultSlicer = "text";
    const partLocation = `${resource.location}#part/0`;
    const markupTypes = context.options.markupTypes ?? DEFAULT_MARKUP_TYPES;
    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: partLocation,
      kind: "text",
      text: rawText,
      links: dedupeLinks([
        // Markup formats (e.g. xml/svg) may reference resources via href/src attributes.
        ...(markupTypes.includes(resource.type) ? extractLinksFromHtml(rawText, partLocation) : []),
        ...extractLinksFromText(rawText, partLocation)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
