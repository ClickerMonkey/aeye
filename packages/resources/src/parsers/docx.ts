import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
  htmlToMarkdown,
} from "../utils";

let mammothModule: any;

async function loadMammoth(): Promise<any> {
  if (mammothModule) return mammothModule;
  try {
    mammothModule = await import("mammoth");
    return mammothModule;
  } catch {
    return undefined;
  }
}

export const docxParser: ResourceParser = {
  id: "docx-parser",
  supportedTypes: ["docx"],
  defaultSlicer: "markdown",
  async isSupported(_type: string, _context: SupportContext) {
    return Boolean(await loadMammoth());
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const mammoth = await loadMammoth();
    if (!mammoth) {
      throw new Error("mammoth is not installed. Install it to parse DOCX resources: npm install mammoth");
    }

    const data = await collectInput(source.input);
    const { Buffer: NodeBuffer } = await import("node:buffer");
    const result = await mammoth.convertToHtml({ buffer: NodeBuffer.from(data) });
    const markdown = htmlToMarkdown(result.value);
    const resource = createParsedResource(source);
    resource.defaultSlicer = "markdown";

    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text: markdown,
      metadata: { originalType: "docx" },
      links: dedupeLinks([
        ...extractLinksFromText(markdown, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
