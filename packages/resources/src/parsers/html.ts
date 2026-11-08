import { htmlConverter } from "../converters/markup";
import { extractLinksFromHtml } from "../utils";
import { createVersionParser, rawText } from "./version";

/**
 * Html pages, through their markdown version (see {@link htmlConverter}). Links come from the raw html (every `href`
 * and `src`, as written), so a crawl sees navigation the markdown leaves out.
 */
export const htmlParser = createVersionParser({
  id: "html-parser",
  supportedTypes: ["html"],
  defaultSlicer: "markdown",
  fallback: htmlConverter,
  links: ({ raw, location }) => extractLinksFromHtml(rawText(raw), location),
});
