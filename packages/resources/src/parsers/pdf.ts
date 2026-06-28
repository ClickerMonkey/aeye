import { readFile } from "node:fs/promises";
import { createParsedResource } from "../registry";
import type { ParsedResource, ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
  toFilePath,
} from "../utils";

let pdfParse: ((buffer: Buffer) => Promise<{ text: string; numpages: number }>) | undefined;

async function loadPdfParse(): Promise<typeof pdfParse> {
  if (pdfParse) return pdfParse;
  try {
    const mod = await import("pdf-parse");
    pdfParse = mod.default ?? mod;
    return pdfParse;
  } catch {
    return undefined;
  }
}

export const pdfParser: ResourceParser = {
  id: "pdf-parser",
  supportedTypes: ["pdf"],
  defaultSlicer: "text",
  async isSupported(_type: string, _context: SupportContext) {
    return Boolean(await loadPdfParse());
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const parse = await loadPdfParse();
    if (!parse) {
      throw new Error("pdf-parse is not installed. Install it to parse PDF resources: npm install pdf-parse");
    }

    const resource = createParsedResource(source);
    resource.defaultSlicer = "text";

    const pdfOptions = context.options.pdf;
    const renderPages = pdfOptions?.renderPages && context.options.renderPdfPages;
    const transcribePages = pdfOptions?.transcribePages && context.options.transcribeImage;
    const dpi = pdfOptions?.renderDpi ?? 150;

    // If renderPages is enabled, render all pages to a temp directory using the file path
    if (renderPages && context.options.renderPdfPages) {
      let renderedSuccessfully = false;
      try {
        const { mkdtemp } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");

        // Resolve a file path for the PDF source
        const pdfFilePath = toFilePath(source.location);
        const outputDir = await mkdtemp(join(tmpdir(), "aeye-pdf-pages-"));

        const renderedPages = await context.options.renderPdfPages(pdfFilePath, outputDir, dpi, context.options.signal);

        if (renderedPages.length > 0) {
          const pageChildren: ParsedResource[] = [];

          for (const renderedPage of renderedPages) {
            assertNotAborted(context.options.signal);

            const pageResource = createParsedResource({
              ...source,
              location: `${source.location}#page/${renderedPage.pageNumber}`,
              name: `${source.name ?? "page"} - Page ${renderedPage.pageNumber}`,
              type: "image",
              mimeType: renderedPage.mimeType,
            });
            pageResource.parentLocation = source.location;

            const imagePart: ResourcePart = {
              id: createPartId(pageResource, 0, "image"),
              location: `${source.location}#page/${renderedPage.pageNumber}/image`,
              kind: "image",
              mimeType: renderedPage.mimeType,
              pageNumber: renderedPage.pageNumber,
              metadata: { filePath: renderedPage.filePath },
            };
            pageResource.parts.push(imagePart);

            // If transcription is available, read the image file and transcribe it
            if (transcribePages && context.options.transcribeImage) {
              try {
                const imageData = await readFile(renderedPage.filePath);
                const transcript = await context.options.transcribeImage(imageData, imagePart, source);
                if (transcript) {
                  const textPart: ResourcePart = {
                    id: createPartId(pageResource, 1, "transcript"),
                    location: `${source.location}#page/${renderedPage.pageNumber}/transcript`,
                    kind: "text",
                    text: transcript,
                    pageNumber: renderedPage.pageNumber,
                    links: extractLinksFromText(transcript, `${source.location}#page/${renderedPage.pageNumber}/transcript`),
                  };
                  pageResource.parts.push(textPart);
                }
              } catch {
                // Transcription failed for this page; image part still available
              }
            }

            pageResource.links = dedupeLinks(pageResource.parts.flatMap((p) => p.links ?? []));
            pageChildren.push(pageResource);
          }

          resource.children = pageChildren;
          renderedSuccessfully = true;

          // Add text parts from transcribed pages to the parent resource
          let partIndex = 0;
          for (const child of pageChildren) {
            for (const part of child.parts) {
              if (part.kind === "text" && part.text) {
                resource.parts.push({
                  ...part,
                  id: createPartId(resource, partIndex++),
                  location: part.location,
                });
              }
            }
          }
        }
      } catch {
        // Rendering failed; fall through to normal text extraction
      }

      // If rendering + transcription produced text parts, use those
      if (renderedSuccessfully && resource.parts.length > 0) {
        resource.links = dedupeLinks(resource.parts.flatMap((p) => p.links ?? []));
        return resource;
      }
    }

    // Fallback: normal text extraction from PDF (reads only what pdf-parse needs)
    const data = await collectInput(source.input);
    const { Buffer: NodeBuffer } = await import("node:buffer");
    const pdfResult = await parse(NodeBuffer.from(data));

    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text: pdfResult.text,
      metadata: { pages: pdfResult.numpages },
      links: dedupeLinks([
        ...extractLinksFromText(pdfResult.text, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
