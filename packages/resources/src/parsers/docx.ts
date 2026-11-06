import { Buffer } from "node:buffer";
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
import { parseViaPdf } from "./convert";

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

/**
 * Higher-priority DOCX parser that converts the document to PDF and delegates to the PDF parser stack
 * for richer output (rendered pages, transcription, etc.). Declines (falls back to {@link docxParser})
 * when no `convertToPdf` function is configured or conversion fails.
 */
export const docxPdfParser: ResourceParser = {
  id: "docx-pdf-parser",
  supportedTypes: ["docx"],
  defaultSlicer: "markdown",
  priority: 10,
  async isSupported(_type: string, context: SupportContext) {
    return Boolean(context.registry.getTypeConfig?.("docx")?.convertToPdf);
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);

    return parseViaPdf(source, context);
  }
};

/** Base DOCX parser that converts the document to markdown via mammoth. Fallback in the DOCX stack. */
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
