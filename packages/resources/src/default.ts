import { ResourceRegistry } from "./registry";
import {
  textParser,
  markdownParser,
  htmlParser,
  codeParser,
  imageParser,
  pdfParser,
  pdfRenderParser,
  excelParser,
  excelPdfParser,
  docxParser,
  docxPdfParser,
  zipParser,
} from "./parsers";
import {
  textSlicer,
  markdownSlicer,
  codeSlicer,
} from "./slicers";
import {
  fileResolver,
  urlResolver,
  zipResolver,
} from "./resolvers";

export {
  textParser,
  markdownParser,
  htmlParser,
  codeParser,
  imageParser,
  pdfParser,
  pdfRenderParser,
  excelParser,
  excelPdfParser,
  docxParser,
  docxPdfParser,
  zipParser,
  textSlicer,
  markdownSlicer,
  codeSlicer,
  fileResolver,
  urlResolver,
  zipResolver,
};

export function createDefaultResourceRegistry(): ResourceRegistry {
  return new ResourceRegistry()
    .registerParser(textParser)
    .registerParser(markdownParser)
    .registerParser(htmlParser)
    .registerParser(codeParser)
    .registerParser(imageParser)
    // PDF: render-based parser is attempted first, falling back to plain text extraction.
    .registerParser(pdfRenderParser)
    .registerParser(pdfParser)
    // Spreadsheets & DOCX: PDF-conversion parser is attempted first, falling back to native extraction.
    .registerParser(excelPdfParser)
    .registerParser(excelParser)
    .registerParser(docxPdfParser)
    .registerParser(docxParser)
    .registerParser(zipParser)
    .registerSlicer(textSlicer)
    .registerSlicer(markdownSlicer)
    .registerSlicer(codeSlicer)
    // Zip resolver first so entry-relative links win over the generic file/url resolvers.
    .registerResolver(zipResolver)
    .registerResolver(fileResolver)
    .registerResolver(urlResolver);
}

export const defaultResourceRegistry = createDefaultResourceRegistry();

