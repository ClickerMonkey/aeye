import { jsonConverter, yamlConverter } from "../converters/data";
import { createVersionParser } from "./version";

/**
 * Json through its pretty form (see {@link jsonConverter}). It declines when the json is already pretty or does not
 * parse, leaving it to the text parser.
 */
export const jsonParser = createVersionParser({
  id: "json-parser",
  supportedTypes: ["json"],
  defaultSlicer: "text",
  fallback: jsonConverter,
});

/** Yaml through its even form (see {@link yamlConverter}); it declines as the converter does, leaving it to the text parser. */
export const yamlParser = createVersionParser({
  id: "yaml-parser",
  supportedTypes: ["yaml"],
  defaultSlicer: "text",
  fallback: yamlConverter,
});
