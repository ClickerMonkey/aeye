import { ResourceRegistry } from "./registry";
import {
  textParser,
  markdownParser,
  htmlParser,
  codeParser,
  imageParser,
  pdfParser,
  excelParser,
  docxParser,
} from "./parsers";
import {
  textSlicer,
  markdownSlicer,
  codeSlicer,
} from "./slicers";
import {
  fileResolver,
  urlResolver,
} from "./resolvers";

export {
  textParser,
  markdownParser,
  htmlParser,
  codeParser,
  imageParser,
  pdfParser,
  excelParser,
  docxParser,
  textSlicer,
  markdownSlicer,
  codeSlicer,
  fileResolver,
  urlResolver,
};

export function createDefaultResourceRegistry(): ResourceRegistry {
  return new ResourceRegistry()
    .registerParser(textParser)
    .registerParser(markdownParser)
    .registerParser(htmlParser)
    .registerParser(codeParser)
    .registerParser(imageParser)
    .registerParser(pdfParser)
    .registerParser(excelParser)
    .registerParser(docxParser)
    .registerSlicer(textSlicer)
    .registerSlicer(markdownSlicer)
    .registerSlicer(codeSlicer)
    .registerResolver(fileResolver)
    .registerResolver(urlResolver);
}

export const defaultResourceRegistry = createDefaultResourceRegistry();

