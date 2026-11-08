import { ResourceRegistry } from "./registry";
import {
  textParser,
  markdownParser,
  htmlParser,
  codeParser,
  imageParser,
  pdfParser,
  pdfRenderParser,
  delimitedParser,
  excelParser,
  excelPdfParser,
  docxParser,
  docxPdfParser,
  jsonParser,
  yamlParser,
  folderParser,
  zipParser,
} from "./parsers";
import {
  textSlicer,
  markdownSlicer,
  codeSlicer,
} from "./slicers";
import {
  fileResolver,
  folderResolver,
  urlResolver,
  zipResolver,
} from "./resolvers";
import { DEFAULT_CONVERTERS } from "./converters";

export {
  textParser,
  markdownParser,
  htmlParser,
  codeParser,
  imageParser,
  pdfParser,
  pdfRenderParser,
  delimitedParser,
  excelParser,
  excelPdfParser,
  docxParser,
  docxPdfParser,
  jsonParser,
  yamlParser,
  folderParser,
  zipParser,
  textSlicer,
  markdownSlicer,
  codeSlicer,
  fileResolver,
  folderResolver,
  urlResolver,
  zipResolver,
};

/**
 * A registry with every built-in converter, parser, slicer and resolver. Html, docx, csv/tsv, workbooks, pdf, json,
 * yaml and folders parse through their converted versions, so `resource.version` holds the LLM-ready form.
 */
export function createDefaultResourceRegistry(): ResourceRegistry {
  const registry = new ResourceRegistry()
    .registerParser(textParser)
    .registerParser(markdownParser)
    .registerParser(htmlParser)
    .registerParser(codeParser)
    .registerParser(imageParser)
    // PDF: render-based parser is attempted first, falling back to page text extraction.
    .registerParser(pdfRenderParser)
    .registerParser(pdfParser)
    // Spreadsheets & DOCX: PDF-conversion parser is attempted first, falling back to native extraction.
    .registerParser(excelPdfParser)
    .registerParser(excelParser)
    .registerParser(delimitedParser)
    .registerParser(docxPdfParser)
    .registerParser(docxParser)
    // Json and yaml: their pretty forms, falling back to the text parser when already pretty.
    .registerParser(jsonParser)
    .registerParser(yamlParser)
    .registerParser(folderParser)
    .registerParser(zipParser)
    .registerSlicer(textSlicer)
    .registerSlicer(markdownSlicer)
    .registerSlicer(codeSlicer)
    // Zip resolver first so entry-relative links win over the generic file/url resolvers; folders ahead of files.
    .registerResolver(zipResolver)
    .registerResolver(folderResolver)
    .registerResolver(fileResolver)
    .registerResolver(urlResolver);
  for (const converter of DEFAULT_CONVERTERS) {
    registry.registerConverter(converter);
  }
  return registry;
}

export const defaultResourceRegistry = createDefaultResourceRegistry();
