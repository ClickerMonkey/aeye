/**
 * Html to clean, LLM-ready markdown. The page is parsed into a tree ({@link parseHtml}); scripts, styles, forms and
 * hidden elements are dropped; with `content: "main"` (the default) the main content is picked (`<main>`, the one
 * `<article>`, or the body without its navigation, banners, sidebars and footers); and what is left becomes GitHub
 * markdown: headings, paragraphs, nested lists, tables, fenced code with its language, quotes, links and images
 * (made absolute against the page's URL), emphasis and definitions.
 */
import { type HtmlElement, type HtmlNode, descendants, findElement, parseHtml, textContent } from "./dom";

/** How html is turned into markdown. */
export interface HtmlToMarkdownOptions {
  /** The page's URL: relative links and images are made absolute against it (or against the page's `<base href>`). */
  baseUrl?: string;
  /** `main` (default) keeps the page's main content only; `body` keeps the whole body, less scripts and forms. */
  content?: "main" | "body";
  /** Keep links as `[text](url)` (default true); when false only their text is kept. */
  links?: boolean;
  /** Keep images as `![alt](src)` (default true). Inline `data:` images are always dropped. */
  images?: boolean;
  /** More tag names to drop, with everything inside them. */
  dropTags?: readonly string[];
}

/** Markdown made from an html page, with what the page says about itself. */
export interface HtmlMarkdown {
  markdown: string;
  /** The page's title: `<title>`, else its `og:title`, else its first `<h1>`. */
  title?: string;
  /** The page's `description` (or `og:description`) meta. */
  description?: string;
  /** The page's language (`<html lang>`). */
  language?: string;
  /** The page's canonical URL (`<link rel="canonical">`), made absolute. */
  canonicalUrl?: string;
}

/** Elements dropped wherever they are, with their content. */
const ALWAYS_DROPPED = new Set([
  "head", "script", "style", "noscript", "template", "iframe", "object", "embed", "canvas", "svg", "math", "map",
  "form", "input", "select", "textarea", "button", "option", "datalist", "dialog", "audio", "video", "source", "track",
  "link", "meta", "base", "title",
]);

/** Page chrome dropped when keeping the main content. */
const CHROME_TAGS = new Set(["nav", "aside", "header", "footer"]);

/** Landmark roles that are page chrome. */
const CHROME_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar", "toolbar", "dialog", "alert", "alertdialog"]);

/** Class and id words that mark page chrome. */
const CHROME_WORDS = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|breadcrumbs?|sidebar|footer|masthead|cookies?|consent|banner|advert|ads|adsbygoogle|promo|social|share|sharing|subscribe|newsletter|popup|modal|related|comments?|skip-link)(?:$|[\s_-])/i;

/** Elements that start a block of their own. Anything else is inline. */
const BLOCK_TAGS = new Set([
  "#document", "html", "body", "address", "article", "aside", "blockquote", "center", "details", "dd", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr",
  "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "td", "th",
  "caption", "ul", "menu", "legend", "picture",
]);

/** A line break inside inline text, kept through whitespace collapsing. */
const LINE_BREAK = " ";

interface Settings {
  readonly baseUrl?: string;
  readonly links: boolean;
  readonly images: boolean;
  readonly drop: ReadonlySet<string>;
  readonly chrome: boolean;
}

/** True when an element is hidden: `hidden`, `aria-hidden="true"`, or an inline `display:none`/`visibility:hidden`. */
function isHidden(element: HtmlElement): boolean {
  const { attributes } = element;
  if ("hidden" in attributes || attributes["aria-hidden"] === "true") return true;
  const style = (attributes.style ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** Chrome tags that belong to the content when inside it (an article's own header and footer). */
const CONTENT_CHROME_TAGS = new Set(["header", "footer"]);

/**
 * True when an element is page chrome: a chrome tag or landmark, or classed/ided as navigation, ads and so on. Inside
 * content, a header or footer is the content's own and not chrome.
 */
function isChrome(element: HtmlElement, insideContent: boolean): boolean {
  if (CHROME_TAGS.has(element.name) && !(insideContent && CONTENT_CHROME_TAGS.has(element.name))) return true;
  const role = element.attributes.role;
  if (role !== undefined && CHROME_ROLES.has(role)) return true;
  if (element.name === "main" || element.name === "article" || role === "main") return false;
  const words = `${element.attributes.class ?? ""} ${element.attributes.id ?? ""}`;
  return CHROME_WORDS.test(words);
}

/** True when an element is dropped with its content. */
function isDropped(element: HtmlElement, settings: Settings, insideContent = false): boolean {
  return ALWAYS_DROPPED.has(element.name) || settings.drop.has(element.name) || isHidden(element) || (settings.chrome && isChrome(element, insideContent));
}

/** The length of the visible text under an element, ignoring what would be dropped. */
function visibleLength(node: HtmlNode, settings: Settings): number {
  if (node.kind === "text") return node.text.replace(/\s+/g, " ").trim().length;
  if (isDropped(node, settings)) return 0;
  return node.children.reduce((sum, child) => sum + visibleLength(child, settings), 0);
}

/** A URL made absolute against the base, or as written when it can't be. */
function absolute(url: string, base: string | undefined): string {
  if (base === undefined) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/** Escapes characters at the start of a line that would turn text into markdown structure. */
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s|={3,}|-{3,}|`{3,}|~{3,})/, (_, space: string, marker: string) => `${space}\\${marker}`))
    .join("\n");
}

/** Wraps inline text in a marker (`**`), keeping surrounding spaces outside it; empty text is left as it is. */
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const inner = match?.[2] ?? "";
  if (inner === "") return text;
  return `${match?.[1] ?? ""}${marker}${inner}${marker}${match?.[3] ?? ""}`;
}

/** Inline code with a backtick fence longer than any backtick run inside it. */
function inlineCode(code: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** Collapses inline whitespace to single spaces and trims each line, keeping explicit line breaks. */
function normalizeInline(text: string): string {
  return text
    .replace(/[\s ]+/g, (space) => (space.includes(LINE_BREAK) ? LINE_BREAK : " "))
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** The code language named by an element's class (`language-ts`, `lang-ts`, `highlight-source-ts`). */
function codeLanguage(element: HtmlElement): string | undefined {
  const match = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/.exec(element.attributes.class ?? "");
  return match?.[1] ?? element.attributes["data-lang"] ?? element.attributes["data-language"];
}

/** A fenced code block, with a fence longer than any fence-like run inside the code. */
function fencedCode(code: string, language: string | undefined): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`{3,}/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language ?? ""}\n${code.replace(/^\n+|\s+$/g, "")}\n${fence}`;
}

/** Elements that hold a page's content: a header or footer inside one belongs to the content, not the page. */
const CONTENT_TAGS = new Set(["main", "article"]);

/** Turns a tree into markdown blocks and inline text. */
class MarkdownWriter {
  /** How many content elements ({@link CONTENT_TAGS}) the writer is inside. */
  private contentDepth: number;

  constructor(private readonly settings: Settings, insideContent = false) {
    this.contentDepth = insideContent ? 1 : 0;
  }

  /** True when an element is dropped here (see {@link isDropped}). */
  private dropped(element: HtmlElement): boolean {
    return isDropped(element, this.settings, this.contentDepth > 0);
  }

  /** Runs `fn` counting the element as content when it is one. */
  private within<T>(element: HtmlElement, fn: () => T): T {
    const content = CONTENT_TAGS.has(element.name) || element.attributes.role === "main";
    if (content) this.contentDepth++;
    try {
      return fn();
    } finally {
      if (content) this.contentDepth--;
    }
  }

  /** The blocks of an element's children: runs of inline content become paragraphs, block children their own blocks. */
  blocks(children: readonly HtmlNode[]): string[] {
    const out: string[] = [];
    let inline = "";
    const flush = () => {
      const text = normalizeInline(inline);
      if (text !== "") out.push(escapeLineStarts(text));
      inline = "";
    };
    for (const child of children) {
      if (child.kind === "text") {
        inline += child.text;
      } else if (this.dropped(child)) {
        continue;
      } else if (BLOCK_TAGS.has(child.name)) {
        flush();
        out.push(...this.within(child, () => this.block(child)));
      } else {
        inline += this.inline(child);
      }
    }
    flush();
    return out;
  }

  /** The inline markdown of a node and what it holds. */
  inline(node: HtmlNode): string {
    if (node.kind === "text") return node.text;
    if (this.dropped(node)) return "";
    const inner = () => node.children.map((child) => this.inline(child)).join("");
    switch (node.name) {
      case "br":
        return LINE_BREAK;
      case "strong":
      case "b":
        return wrap(inner(), "**");
      case "em":
      case "i":
      case "cite":
      case "dfn":
        return wrap(inner(), "*");
      case "del":
      case "s":
      case "strike":
        return wrap(inner(), "~~");
      case "code":
      case "kbd":
      case "samp":
      case "tt": {
        const code = textContent(node).replace(/\s+/g, " ");
        return code.trim() === "" ? code : inlineCode(code);
      }
      case "img":
        return this.image(node);
      case "a":
        return this.link(node, inner());
      case "wbr":
        return "";
      default:
        // A block inside inline content (a `<div>` in a link) reads as a space-separated run of its text.
        return BLOCK_TAGS.has(node.name) ? ` ${inner()} ` : inner();
    }
  }

  private image(node: HtmlElement): string {
    const src = node.attributes.src ?? node.attributes["data-src"] ?? "";
    if (!this.settings.images || src === "" || src.startsWith("data:")) return "";
    if (node.attributes.width === "1" || node.attributes.height === "1") return "";
    const alt = (node.attributes.alt ?? "").replace(/[\[\]\s]+/g, " ").trim();
    return `![${alt}](${absolute(src, this.settings.baseUrl).replace(/[ )]/g, encodeURIComponent)})`;
  }

  private link(node: HtmlElement, inner: string): string {
    const href = node.attributes.href?.trim();
    const text = inner.trim() === "" ? (node.attributes.title ?? node.attributes["aria-label"] ?? "") : inner;
    if (!this.settings.links || href === undefined || href === "" || href.startsWith("#") || /^(?:javascript|data):/i.test(href)) {
      return text;
    }
    if (text.trim() === "") return "";
    const url = absolute(href, this.settings.baseUrl).replace(/[ )]/g, encodeURIComponent);
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    const label = match?.[2] ?? text;
    return label === url ? `${match?.[1] ?? ""}<${url}>${match?.[3] ?? ""}` : `${match?.[1] ?? ""}[${label}](${url})${match?.[3] ?? ""}`;
  }

  /** The inline text of an element as one line of markdown. */
  private line(element: HtmlElement): string {
    return normalizeInline(element.children.map((child) => this.inline(child)).join("")).replace(/\n/g, " ");
  }

  /** The markdown blocks of a block element. */
  block(element: HtmlElement): string[] {
    switch (element.name) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
        const text = this.line(element);
        return text === "" ? [] : [`${"#".repeat(Number(element.name[1]))} ${text}`];
      }
      case "hr":
        return ["---"];
      case "pre": {
        const code = findElement(element, (e) => e.name === "code");
        const text = textContent(element);
        return text.trim() === "" ? [] : [fencedCode(text, codeLanguage(element) ?? (code ? codeLanguage(code) : undefined))];
      }
      case "ul": case "ol": case "menu": {
        const list = this.list(element);
        return list === "" ? [] : [list];
      }
      case "blockquote": {
        const inner = this.blocks(element.children).join("\n\n");
        return inner === "" ? [] : [inner.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n")];
      }
      case "table":
        return this.table(element);
      case "dl":
        return this.definitions(element);
      case "figcaption":
      case "caption": {
        const text = this.line(element);
        return text === "" ? [] : [wrap(text, "*")];
      }
      case "summary":
      case "dt": {
        const text = this.line(element);
        return text === "" ? [] : [wrap(text, "**")];
      }
      default:
        return this.blocks(element.children);
    }
  }

  private list(element: HtmlElement): string {
    const ordered = element.name === "ol";
    let number = Number.parseInt(element.attributes.start ?? "1", 10);
    if (Number.isNaN(number)) number = 1;
    const items: string[] = [];
    for (const child of element.children) {
      // Stray content directly in a list reads as an item of its own.
      const blocks = child.kind === "element" && child.name === "li" ? this.blocks(child.children) : this.blocks([child]);
      if (blocks.length === 0) continue;
      const marker = ordered ? `${number++}. ` : "- ";
      const indent = " ".repeat(marker.length);
      const body = blocks.join("\n").split("\n").map((line, i) => (i === 0 ? `${marker}${line}` : line === "" ? "" : `${indent}${line}`));
      items.push(body.join("\n"));
    }
    return items.join("\n");
  }

  private definitions(element: HtmlElement): string[] {
    const out: string[] = [];
    for (const child of descendantsUntil(element, new Set(["dt", "dd"]))) {
      const text = child.name === "dt" ? this.line(child) : this.blocks(child.children).join(" ");
      if (text === "") continue;
      out.push(child.name === "dt" ? wrap(text, "**") : `: ${text.replace(/\n/g, " ")}`);
    }
    return out.length === 0 ? [] : [out.join("\n")];
  }

  private table(element: HtmlElement): string[] {
    const rows = Array.from(descendantsUntil(element, new Set(["tr"]), new Set(["table"])));
    const grid = rows.map((row) => {
      const cells: string[] = [];
      for (const cell of row.children) {
        if (cell.kind !== "element" || (cell.name !== "td" && cell.name !== "th")) continue;
        const text = this.blocks(cell.children).join(" ").replace(/\n/g, " ").replace(/\|/g, "\\|");
        const span = Math.min(Math.max(Number.parseInt(cell.attributes.colspan ?? "1", 10) || 1, 1), 50);
        cells.push(text, ...Array.from({ length: span - 1 }, () => ""));
      }
      return cells;
    }).filter((cells) => cells.some((cell) => cell.trim() !== ""));
    const caption = element.children.find((child): child is HtmlElement => child.kind === "element" && child.name === "caption");
    const captionBlocks = caption ? this.block(caption) : [];
    const width = Math.max(0, ...grid.map((cells) => cells.length));
    // A one-column table is layout, not data: its cells read as blocks.
    if (grid.length === 0 || width < 2) {
      return [...captionBlocks, ...rows.flatMap((row) => this.blocks(row.children))];
    }
    const pad = (cells: string[]) => Array.from({ length: width }, (_, i) => cells[i] || " ");
    const [head = [], ...body] = grid;
    const lines = [`| ${pad(head).join(" | ")} |`, `| ${pad(head).map(() => "---").join(" | ")} |`, ...body.map((cells) => `| ${pad(cells).join(" | ")} |`)];
    return [...captionBlocks, lines.join("\n")];
  }
}

/**
 * The elements under a node named one of `names`, in document order, not looking inside them or inside `stop`
 * elements (so a nested table's rows are not taken as the outer table's).
 */
function* descendantsUntil(node: HtmlElement, names: ReadonlySet<string>, stop: ReadonlySet<string> = new Set()): Generator<HtmlElement> {
  for (const child of node.children) {
    if (child.kind !== "element") continue;
    if (names.has(child.name)) {
      yield child;
    } else if (!stop.has(child.name)) {
      yield* descendantsUntil(child, names, stop);
    }
  }
}

/** The first `<meta>` whose `name` or `property` is one of the given names, and its content. */
function metaContent(root: HtmlElement, names: readonly string[]): string | undefined {
  for (const name of names) {
    const meta = findElement(root, (e) => e.name === "meta" && (e.attributes.name?.toLowerCase() === name || e.attributes.property?.toLowerCase() === name));
    const content = meta?.attributes.content?.trim();
    if (content) return content;
  }
  return undefined;
}

/** Picks the element holding the page's main content, or undefined to use the whole body. */
function mainContent(root: HtmlElement): HtmlElement | undefined {
  const main = findElement(root, (e) => (e.name === "main" || e.attributes.role === "main") && !isHidden(e));
  if (main) return main;
  const articles = Array.from(descendants(root)).filter((e) => e.name === "article" && !isHidden(e));
  if (articles.length === 1) return articles[0];
  // Several articles (a blog index) or none: use the body, less its chrome.
  return undefined;
}

/** Turns an html page into clean markdown, with its title and other facts the page states. */
export function htmlToCleanMarkdown(html: string, options: HtmlToMarkdownOptions = {}): HtmlMarkdown {
  const root = parseHtml(html);
  const baseHref = findElement(root, (e) => e.name === "base" && e.attributes.href !== undefined)?.attributes.href;
  const baseUrl = baseHref !== undefined && options.baseUrl !== undefined ? absolute(baseHref, options.baseUrl) : options.baseUrl ?? (baseHref && /^https?:/i.test(baseHref) ? baseHref : undefined);
  const settings: Settings = {
    baseUrl,
    links: options.links ?? true,
    images: options.images ?? true,
    drop: new Set(options.dropTags ?? []),
    chrome: (options.content ?? "main") === "main",
  };

  const body = findElement(root, (e) => e.name === "body") ?? root;
  let scope = settings.chrome ? mainContent(root) ?? body : body;
  // A main element that holds almost nothing (an app shell's empty <main>) is not the page's content.
  if (scope !== body && visibleLength(scope, settings) < 0.2 * visibleLength(body, settings)) scope = body;

  const writer = new MarkdownWriter(settings, scope !== body);
  let blocks = scope === body || BLOCK_TAGS.has(scope.name) ? writer.block(scope) : writer.blocks([scope]);
  // When chrome removal leaves nothing (a page that is all `<div class="menu">`), keep everything.
  if (blocks.length === 0 && settings.chrome) blocks = new MarkdownWriter({ ...settings, chrome: false }).block(body);

  const titleElement = findElement(root, (e) => e.name === "title");
  const h1 = findElement(body, (e) => e.name === "h1");
  const title = [titleElement ? textContent(titleElement) : undefined, metaContent(root, ["og:title", "twitter:title"]), h1 ? textContent(h1) : undefined]
    .map((value) => value?.replace(/\s+/g, " ").trim())
    .find((value): value is string => Boolean(value));
  const htmlElement = findElement(root, (e) => e.name === "html");
  const canonical = findElement(root, (e) => e.name === "link" && (e.attributes.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))?.attributes.href;

  const result: HtmlMarkdown = { markdown: blocks.join("\n\n").trim() };
  if (title) result.title = title;
  const description = metaContent(root, ["description", "og:description", "twitter:description"]);
  if (description) result.description = description;
  const language = htmlElement?.attributes.lang?.trim();
  if (language) result.language = language;
  if (canonical) result.canonicalUrl = absolute(canonical, baseUrl);
  return result;
}

/** The visible text of an html page, as {@link htmlToCleanMarkdown} sees it, without markdown. */
export function htmlVisibleTextLength(html: string): number {
  const root = parseHtml(html);
  const body = findElement(root, (e) => e.name === "body") ?? root;
  return visibleLength(body, { links: true, images: true, drop: new Set(), chrome: false });
}
