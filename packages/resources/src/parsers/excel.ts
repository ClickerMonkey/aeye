import { delimitedConverter, workbookConverter } from "../converters/tables.js";
import type { ResourceParser, SupportContext } from "../types.js";
import { assertNotAborted } from "../utils.js";
import { parseViaPdf } from "./convert.js";
import { createVersionParser } from "./version.js";

/**
 * Higher-priority spreadsheet parser that converts to PDF and delegates to the PDF parser stack when
 * PDF rendering is enabled. Declines (falls back to {@link excelParser}) when conversion/rendering is
 * not configured or conversion fails.
 */
export const excelPdfParser: ResourceParser = {
  id: "excel-pdf-parser",
  supportedTypes: ["excel", "csv", "tsv"],
  defaultSlicer: "text",
  priority: 10,
  async isSupported(_type: string, context: SupportContext) {
    const config = context.registry.getTypeConfig?.(_type);
    return Boolean(config?.convertToPdf && config?.pdf?.renderPages);
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);

    // Only convert when both conversion and PDF rendering are enabled; otherwise decline.
    if (!context.options.convertToPdf || !context.options.pdf?.renderPages) {
      return undefined;
    }

    return parseViaPdf(source, context);
  }
};

/** Workbooks, through their table version (see {@link workbookConverter}): one part per sheet. */
export const excelParser = createVersionParser({
  id: "excel-parser",
  supportedTypes: ["excel"],
  defaultSlicer: "text",
  fallback: workbookConverter,
});

/** Csv and tsv files, through their table version (see {@link delimitedConverter}); no dependency needed. */
export const delimitedParser = createVersionParser({
  id: "delimited-parser",
  supportedTypes: ["csv", "tsv"],
  defaultSlicer: "text",
  fallback: delimitedConverter,
});
