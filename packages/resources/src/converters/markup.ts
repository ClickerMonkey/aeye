/** Converters to markdown: html pages, and word documents by way of the html mammoth makes of them. */
import { Buffer } from "node:buffer";
import { htmlToCleanMarkdown, type HtmlMarkdown, type HtmlToMarkdownOptions } from "../html/markdown";
import { missingDependency, optionalModule } from "../optional";
import type { ResourceConverter, ResourceSource } from "../types";
import { assertNotAborted, collectInput, isHttpUrl } from "../utils";
import type { ResourceVersionOf } from "../versions";

/** The part of mammoth the docx converter uses. */
interface DocxToHtml {
  convertToHtml(input: { buffer: Buffer }): Promise<{ value: string }>;
}

/** Loads mammoth (an optional peer dependency) for word documents. */
const loadMammoth = optionalModule(async (): Promise<DocxToHtml> => (await import("mammoth")).default);

/** A markdown version from converted html: the page's title, and its description, language and canonical URL as metadata. */
function markdownVersion(converter: string, from: string, page: HtmlMarkdown): ResourceVersionOf<"markdown"> {
  const metadata: Record<string, unknown> = {};
  if (page.description !== undefined) metadata.description = page.description;
  if (page.language !== undefined) metadata.language = page.language;
  if (page.canonicalUrl !== undefined) metadata.canonicalUrl = page.canonicalUrl;
  return {
    kind: "markdown",
    converter,
    from,
    text: page.markdown,
    ...(page.title !== undefined ? { title: page.title } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/** The html options for a source: the caller's, with the base URL defaulting to the source's own URL. */
function htmlOptions(source: ResourceSource, options: HtmlToMarkdownOptions | undefined): HtmlToMarkdownOptions {
  const baseUrl = options?.baseUrl ?? (isHttpUrl(source.location) ? source.location : undefined);
  return baseUrl === undefined ? { ...options } : { ...options, baseUrl };
}

/** Html to clean markdown: the page's main content, with links and images made absolute against its URL. */
export const htmlConverter: ResourceConverter = {
  id: "html-markdown",
  supportedTypes: ["html"],
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const html = Buffer.from(await collectInput(source.input)).toString("utf8");
    return markdownVersion("html-markdown", "html", htmlToCleanMarkdown(html, htmlOptions(source, context.options.html)));
  },
};

/** Word documents to markdown, through the html mammoth makes (headings, lists, tables, links and emphasis kept). */
export const docxConverter: ResourceConverter = {
  id: "docx-markdown",
  supportedTypes: ["docx"],
  async isSupported() {
    return (await loadMammoth()) !== undefined;
  },
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const mammoth = await loadMammoth();
    if (!mammoth) throw missingDependency("mammoth", "DOCX");
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(await collectInput(source.input)) });
    // A document is all content, so nothing is dropped as page chrome.
    const page = htmlToCleanMarkdown(result.value, { ...htmlOptions(source, context.options.html), content: "body" });
    return markdownVersion("docx-markdown", "docx", page);
  },
};
