import type { ResourceConverter } from "../types";
import { jsonConverter, yamlConverter } from "./data";
import { folderConverter } from "./folder";
import { docxConverter, htmlConverter } from "./markup";
import { pdfConverter } from "./pdf";
import { delimitedConverter, workbookConverter } from "./tables";

export { jsonConverter, yamlConverter } from "./data";
export { folderConverter, folderListingMarkdown, formatSize, parseFolderListing, readFolderListing } from "./folder";
export { docxConverter, htmlConverter } from "./markup";
export { pdfConverter, pdfPageText } from "./pdf";
export { delimitedConverter, workbookConverter } from "./tables";

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
