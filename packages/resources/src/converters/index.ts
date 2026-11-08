import type { ResourceConverter } from "../types.js";
import { jsonConverter, yamlConverter } from "./data.js";
import { folderConverter } from "./folder.js";
import { docxConverter, htmlConverter } from "./markup.js";
import { pdfConverter } from "./pdf.js";
import { delimitedConverter, workbookConverter } from "./tables.js";

export { jsonConverter, yamlConverter } from "./data.js";
export { folderConverter, folderListingMarkdown, formatSize, parseFolderListing, readFolderListing } from "./folder.js";
export { docxConverter, htmlConverter } from "./markup.js";
export { pdfConverter, pdfPageText } from "./pdf.js";
export { delimitedConverter, workbookConverter } from "./tables.js";

/** The converters a default registry has: html, docx, csv/tsv, workbooks, pdf, json, yaml and folders. */
export const DEFAULT_CONVERTERS: readonly ResourceConverter[] = [
  htmlConverter,
  docxConverter,
  delimitedConverter,
  workbookConverter,
  pdfConverter,
  jsonConverter,
  yamlConverter,
  folderConverter,
];
