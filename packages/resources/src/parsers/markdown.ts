import { Buffer } from "node:buffer";
import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromMarkdown,
  extractLinksFromText,
} from "../utils";

export const markdownParser: ResourceParser = {
  id: "markdown-parser",
  supportedTypes: ["markdown"],
  defaultSlicer: "markdown",
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const rawText = Buffer.from(await collectInput(source.input)).toString("utf8");
    const resource = createParsedResource(source);
    resource.defaultSlicer = "markdown";
    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text: rawText,
      links: dedupeLinks([
        ...extractLinksFromMarkdown(rawText, `${resource.location}#part/0`),
        ...extractLinksFromText(rawText, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
