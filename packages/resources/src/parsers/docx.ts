import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
  htmlToMarkdown,
  toFilePath,
} from "../utils";
import { pdfParser } from "./pdf";

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

    // If convertToPdf is available, convert to PDF and delegate to pdfParser for richer output
    if (context.options.convertToPdf) {
      try {
        const sourceFilePath = toFilePath(source.location);
        const pdfPath = await context.options.convertToPdf(sourceFilePath, context.options.signal);
        const pdfSource = {
          ...source,
          location: pdfPath,
          type: "pdf" as const,
          mimeType: "application/pdf",
          input: (() => createReadStream(pdfPath) as unknown as AsyncIterable<Uint8Array>)(),
          metadata: { ...source.metadata, convertedFrom: source.location },
        };
        const result = await pdfParser.parse(pdfSource, context);
        // Restore original location info
        result.location = source.location;
        result.name = source.name ?? result.name;
        result.metadata = { ...result.metadata, convertedFrom: "docx", pdfPath };
        return result;
      } catch {
        // Conversion failed; fall through to mammoth extraction
      }
    }

    const mammoth = await loadMammoth();
    if (!mammoth) {
      throw new Error("mammoth is not installed. Install it to parse DOCX resources: npm install mammoth");
    }

    const data = await collectInput(source.input);
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(data) });
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
