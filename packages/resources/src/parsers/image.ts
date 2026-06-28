import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
} from "../utils";

export const imageParser: ResourceParser = {
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
