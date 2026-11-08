/**
 * A small, forgiving html parser: it builds an element tree the way a browser would for ordinary pages (void
 * elements, raw text in `<script>`/`<style>`, implied end tags for paragraphs, list items, table rows and cells),
 * so converters can walk structure instead of scanning tags. It is not a full html5 tree builder; it never throws.
 */
import { decodeHtmlEntities } from "./entities.js";

/** An element: its lower-case tag name, attributes (names lower-cased, values decoded) and children. */
export interface HtmlElement {
  readonly kind: "element";
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: HtmlNode[];
}

/** Text between tags, with character references decoded. */
export interface HtmlText {
  readonly kind: "text";
  readonly text: string;
}

/** A node of the tree. */
export type HtmlNode = HtmlElement | HtmlText;

/** The name of the root element {@link parseHtml} returns. */
export const DOCUMENT_NODE_NAME = "#document";

/** Elements that never have children or an end tag. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is raw text up to their end tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "template", "plaintext"]);

/** Elements whose start tag closes an open `<p>`. */
const CLOSES_PARAGRAPH = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p",
  "pre", "section", "table", "ul",
]);

/**
 * Start tags that close an open element of the same group, up to (not past) a boundary element: a new `<li>` closes
 * the open `<li>` of the same list, a new `<td>` the open cell of the same row, and so on.
 */
const IMPLIED_END: ReadonlyArray<{ readonly opens: ReadonlySet<string>; readonly closes: ReadonlySet<string>; readonly boundary: ReadonlySet<string> }> = [
  { opens: new Set(["li"]), closes: new Set(["li"]), boundary: new Set(["ul", "ol", "menu"]) },
  { opens: new Set(["dt", "dd"]), closes: new Set(["dt", "dd"]), boundary: new Set(["dl"]) },
  { opens: new Set(["tr"]), closes: new Set(["tr"]), boundary: new Set(["table", "thead", "tbody", "tfoot"]) },
  { opens: new Set(["td", "th"]), closes: new Set(["td", "th"]), boundary: new Set(["tr", "table"]) },
  { opens: new Set(["thead", "tbody", "tfoot"]), closes: new Set(["thead", "tbody", "tfoot"]), boundary: new Set(["table"]) },
  { opens: new Set(["option"]), closes: new Set(["option"]), boundary: new Set(["select", "datalist", "optgroup"]) },
];

/** Elements a `<p>` cannot be closed past when looking for one to close. */
const PARAGRAPH_SCOPE = new Set(["button", "table", "td", "th", "li", "dd", "dt", "blockquote", "div", "section", "article"]);

function element(name: string, attributes: Record<string, string> = {}): HtmlElement {
  return { kind: "element", name, attributes, children: [] };
}

/**
 * Parses the attributes of a start tag (the text after its name): double-quoted, single-quoted, unquoted and bare
 * (`hidden`, given the value "") attributes. Names are lower-cased and values decoded; the first of a repeated name
 * wins, as in browsers.
 */
export function parseHtmlAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of input.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (name === "" || name in attributes) continue;
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/** Parser state: the stack of open elements, the document root at the bottom. */
class TreeBuilder {
  readonly root = element(DOCUMENT_NODE_NAME);
  private readonly open: HtmlElement[] = [this.root];

  private get current(): HtmlElement {
    return this.open[this.open.length - 1] ?? this.root;
  }

  text(text: string): void {
    if (text === "") return;
    const children = this.current.children;
    const last = children[children.length - 1];
    if (last?.kind === "text") {
      children[children.length - 1] = { kind: "text", text: last.text + text };
    } else {
      children.push({ kind: "text", text });
    }
  }

  /** The depth of the innermost open element named one of `names`, stopping at a boundary; -1 when there is none. */
  private find(names: ReadonlySet<string>, boundary: ReadonlySet<string>): number {
    for (let i = this.open.length - 1; i > 0; i--) {
      const name = this.open[i]?.name ?? "";
      if (names.has(name)) return i;
      if (boundary.has(name)) return -1;
    }
    return -1;
  }

  start(name: string, attributes: Record<string, string>, selfClosing: boolean): HtmlElement {
    if (CLOSES_PARAGRAPH.has(name)) {
      const p = this.find(new Set(["p"]), PARAGRAPH_SCOPE);
      if (p > 0) this.open.length = p;
    }
    for (const rule of IMPLIED_END) {
      if (!rule.opens.has(name)) continue;
      const at = this.find(rule.closes, rule.boundary);
      if (at > 0) this.open.length = at;
    }
    const node = element(name, attributes);
    this.current.children.push(node);
    if (!selfClosing && !VOID_ELEMENTS.has(name)) this.open.push(node);
    return node;
  }

  end(name: string): void {
    for (let i = this.open.length - 1; i > 0; i--) {
      if (this.open[i]?.name === name) {
        this.open.length = i;
        return;
      }
    }
    // An end tag with no open element of its name is ignored, as browsers do (`</br>` aside).
  }
}

/** A start or end tag at a position (sticky): its slash, name and the attribute text, with quoted values skipped whole. */
const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;

/** Parses html into a tree under a {@link DOCUMENT_NODE_NAME} root. Comments, doctypes and processing instructions are dropped. */
export function parseHtml(html: string): HtmlElement {
  const builder = new TreeBuilder();
  const lower = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const lt = html.indexOf("<", cursor);
    if (lt === -1) {
      builder.text(decodeHtmlEntities(html.slice(cursor)));
      break;
    }
    builder.text(decodeHtmlEntities(html.slice(cursor, lt)));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const end = html.indexOf("]]>", lt + 9);
      builder.text(html.slice(lt + 9, end === -1 ? html.length : end));
      cursor = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt + 2);
      cursor = end === -1 ? html.length : end + 1;
      continue;
    }

    TAG_PATTERN.lastIndex = lt;
    const tag = TAG_PATTERN.exec(html);
    if (!tag) {
      // A `<` that starts no tag is text.
      builder.text("<");
      cursor = lt + 1;
      continue;
    }
    cursor = lt + tag[0].length;
    const name = (tag[2] ?? "").toLowerCase();
    const rest = tag[3] ?? "";

    if (tag[1] === "/") {
      builder.end(name === "br" ? "" : name);
      if (name === "br") builder.start("br", {}, true);
      continue;
    }

    const selfClosing = rest.trimEnd().endsWith("/");
    builder.start(name, parseHtmlAttributes(selfClosing ? rest.trimEnd().slice(0, -1) : rest), selfClosing);
    if (RAW_TEXT_ELEMENTS.has(name) && !selfClosing) {
      const close = lower.indexOf(`</${name}`, cursor);
      const body = html.slice(cursor, close === -1 ? html.length : close);
      builder.text(name === "script" || name === "style" ? body : decodeHtmlEntities(body));
      builder.end(name);
      const closeEnd = close === -1 ? -1 : html.indexOf(">", close);
      cursor = closeEnd === -1 ? html.length : closeEnd + 1;
    }
  }

  return builder.root;
}

/** The elements under a node, depth first, in document order. */
export function* descendants(node: HtmlElement): Generator<HtmlElement> {
  for (const child of node.children) {
    if (child.kind === "element") {
      yield child;
      yield* descendants(child);
    }
  }
}

/** The first element under a node that passes a test, depth first. */
export function findElement(node: HtmlElement, test: (element: HtmlElement) => boolean): HtmlElement | undefined {
  for (const candidate of descendants(node)) {
    if (test(candidate)) return candidate;
  }
  return undefined;
}

/** All the text under a node, as written (whitespace kept). */
export function textContent(node: HtmlNode): string {
  return node.kind === "text" ? node.text : node.children.map(textContent).join("");
}
