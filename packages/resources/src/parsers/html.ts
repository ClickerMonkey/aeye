import { Buffer } from "node:buffer";
import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromHtml,
  extractLinksFromText,
  htmlToMarkdown,
} from "../utils";

export const htmlParser: ResourceParser = {
  id: "html-parser",
  supportedTypes: ["html"],
  defaultSlicer: "markdown",
  async parse(source, context) {
    assertNotAborted(context.options.signal);

    let rawHtml: string;
    // If renderUrl is provided and the source has a URL location, render it first
    if (context.options.renderUrl && /^https?:\/\//i.test(source.location)) {
      rawHtml = await context.options.renderUrl(source.location, context.options.signal);
    } else {
      rawHtml = Buffer.from(await collectInput(source.input)).toString("utf8");
    }

    const resource = createParsedResource(source);
    resource.defaultSlicer = "markdown";
    const text = htmlToMarkdown(rawHtml);
    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text,
      metadata: { originalType: "html" },
      links: dedupeLinks([
        ...extractLinksFromHtml(rawHtml, `${resource.location}#part/0`),
        ...extractLinksFromText(text, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
