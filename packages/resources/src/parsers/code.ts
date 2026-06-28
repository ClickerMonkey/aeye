import { Buffer } from "node:buffer";
import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart } from "../types";
import {
  CODE_TYPES,
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromCode,
  extractLinksFromText,
} from "../utils";

export const codeParser: ResourceParser = {
  id: "code-parser",
  supportedTypes: [...CODE_TYPES],
  defaultSlicer: "code",
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const rawText = Buffer.from(await collectInput(source.input)).toString("utf8");
    const resource = createParsedResource(source);
    resource.defaultSlicer = "code";
    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text: rawText,
      links: dedupeLinks([
        ...extractLinksFromCode(rawText, `${resource.location}#part/0`),
        ...extractLinksFromText(rawText, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
