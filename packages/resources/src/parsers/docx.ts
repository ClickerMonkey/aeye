import { docxConverter } from "../converters/markup";
import type { ResourceParser, SupportContext } from "../types";
import { assertNotAborted } from "../utils";
import { parseViaPdf } from "./convert";
import { createVersionParser } from "./version";

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

/** Word documents, through their markdown version (see {@link docxConverter}). Fallback in the DOCX stack. */
export const docxParser = createVersionParser({
  id: "docx-parser",
  supportedTypes: ["docx"],
  defaultSlicer: "markdown",
  fallback: docxConverter,
});
