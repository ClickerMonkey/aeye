import { Buffer } from "node:buffer";
import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
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
    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text: rawText,
      links: dedupeLinks([
        ...extractLinksFromText(rawText, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
