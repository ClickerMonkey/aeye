import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfConverter } from "../converters/pdf";
import { createParsedResource } from "../registry";
import type { ParsedResource, ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
  isAbortError,
  withLocalFile,
} from "../utils";
import { createVersionParser } from "./version";

/**
 * Higher-priority PDF parser that renders pages to images (and optionally transcribes them).
 * Declines (falls back to {@link pdfParser}) when page rendering is not enabled/configured, or when
 * rendering does not produce any usable parts — so it can be stacked ahead of the text parser.
 */
export const pdfRenderParser: ResourceParser = {
  id: "pdf-render-parser",
  supportedTypes: ["pdf"],
  defaultSlicer: "text",
  priority: 10,
  async isSupported(_type: string, context: SupportContext) {
    // Reported as supported only when rendering is configured on the registry; per-call options can
    // still enable it at parse time (handled by the decline-and-fall-back flow in parse()).
    return Boolean(context.registry.getTypeConfig?.("pdf")?.renderPdfPages);
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);

    const pdfOptions = context.options.pdf;
    const renderPdfPages = context.options.renderPdfPages;
    const renderPages = pdfOptions?.renderPages && renderPdfPages;
    const canTranscribePages = pdfOptions?.transcribePages && context.options.transcribeImage;
    const dpi = pdfOptions?.renderDpi ?? 150;

    // Not configured for rendering — decline so the plain text parser can take over.
    if (!renderPages || !renderPdfPages) {
      return undefined;
    }

    // Pages go to the caller's directory (kept) or a temporary one (deleted, bytes kept in the parts).
    const keepPages = Boolean(pdfOptions?.pageOutputDir);
    let outputDir: string | undefined;

    try {
      // Renderers need a file on disk; in-memory, URL and zip-entry PDFs go through a temp file.
      return await withLocalFile(source, ".pdf", async (pdfFilePath) => {
        if (pdfOptions?.pageOutputDir) {
          await mkdir(pdfOptions.pageOutputDir, { recursive: true });
          outputDir = pdfOptions.pageOutputDir;
        } else {
          outputDir = await mkdtemp(join(tmpdir(), "aeye-pdf-pages-"));
        }
        const renderedPages = await renderPdfPages(pdfFilePath, outputDir, dpi, context.options.signal);
        if (renderedPages.length === 0) {
          return undefined;
        }

        const resource = createParsedResource(source);
        resource.defaultSlicer = "text";
        const pageChildren: ParsedResource[] = [];

        for (const renderedPage of renderedPages) {
          assertNotAborted(context.options.signal);
          const pageLocation = `${source.location}#page/${renderedPage.pageNumber}`;

          const pageResource = createParsedResource({
            ...source,
            location: pageLocation,
            name: `${source.name ?? "page"} - Page ${renderedPage.pageNumber}`,
            type: "image",
            mimeType: renderedPage.mimeType,
          });
          pageResource.parentLocation = source.location;

          const needsData = !keepPages || canTranscribePages;
          const imageData = needsData ? await readFile(renderedPage.filePath) : undefined;

          const imagePart: ResourcePart = {
            id: createPartId(pageResource, 0, "image"),
            location: `${pageLocation}/image`,
            kind: "image",
            mimeType: renderedPage.mimeType,
            pageNumber: renderedPage.pageNumber,
            // Temporary page files are deleted below, so their bytes travel with the part.
            ...(keepPages ? { metadata: { filePath: renderedPage.filePath } } : { data: imageData }),
          };
          pageResource.parts.push(imagePart);

          if (canTranscribePages && context.options.transcribeImage && imageData) {
            try {
              const pageSource = {
                ...source,
                location: pageResource.location,
                name: pageResource.name,
                type: "image" as const,
                mimeType: renderedPage.mimeType,
              };
              const transcript = await context.options.transcribeImage(imageData, imagePart, pageSource);
              if (transcript) {
                pageResource.parts.push({
                  id: createPartId(pageResource, 1, "transcript"),
                  location: `${pageLocation}/transcript`,
                  kind: "text",
                  text: transcript,
                  pageNumber: renderedPage.pageNumber,
                  links: extractLinksFromText(transcript, `${pageLocation}/transcript`),
                });
              }
            } catch (error) {
              if (isAbortError(error)) throw error;
              // Transcription failed for this page; image part still available.
            }
          }

          pageResource.links = dedupeLinks(pageResource.parts.flatMap((p) => p.links ?? []));
          pageChildren.push(pageResource);
        }

        resource.children = pageChildren;

        // Add text parts from transcribed pages to the parent resource.
        let partIndex = 0;
        for (const child of pageChildren) {
          for (const part of child.parts) {
            if (part.kind === "text" && part.text) {
              resource.parts.push({ ...part, id: createPartId(resource, partIndex++) });
            }
          }
        }

        // Only succeed if rendering produced usable text parts; otherwise fall back to text extraction.
        if (resource.parts.length === 0) {
          return undefined;
        }
        resource.links = dedupeLinks(resource.parts.flatMap((p) => p.links ?? []));
        return resource;
      });
    } catch (error) {
      if (isAbortError(error) || context.options.signal?.aborted) throw error;
      // Rendering failed; decline so the text-extraction parser can handle it.
      return undefined;
    } finally {
      if (outputDir && !keepPages) {
        await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
};

/** Pdfs as text page by page (see {@link pdfConverter}), one part per page. The fallback in the PDF parser stack. */
export const pdfParser = createVersionParser({
  id: "pdf-parser",
  supportedTypes: ["pdf"],
  defaultSlicer: "text",
  fallback: pdfConverter,
});
