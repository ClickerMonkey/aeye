import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbedTextContext, ParsedResource, ResourceInput, ResourceLink, ResourcePart, ResourceSlice, ResourceSource, ResourceType, SliceContext, SliceOptions } from "./types";

export const DEFAULT_MAX_CHARS = 2000;
export const DEFAULT_MIN_CHARS = 400;

export const CODE_TYPES = [
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "ruby",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "rust",
  "swift",
  "kotlin",
  "scala",
  "sql",
  "shell",
  "css",
  "scss",
  "less",
  "dockerfile",
  "graphql",
  "lua",
  "r",
  "dart"
] as const;

const EXTENSION_TYPE_MAP: Record<string, ResourceType> = {
  ".txt": "text",
  ".text": "text",
  ".log": "text",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".jsonl": "json",
  ".csv": "csv",
  ".tsv": "tsv",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".svg": "svg",
  ".toml": "toml",
  ".ini": "ini",
  ".conf": "ini",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".jsx": "jsx",
  ".tsx": "tsx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".rs": "rust",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".sql": "sql",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "shell",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".lua": "lua",
  ".r": "r",
  ".dart": "dart",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".webp": "image",
  ".bmp": "image",
  ".ico": "image",
  ".avif": "image",
  ".pdf": "pdf",
  ".xlsx": "excel",
  ".xls": "excel",
  ".docx": "docx",
  ".doc": "docx"
};

const MIME_TYPE_MAP: Array<[RegExp, ResourceType]> = [
  [/^text\/markdown/i, "markdown"],
  [/^text\/html/i, "html"],
  [/^application\/json/i, "json"],
  [/^application\/([a-z.+-]*\+)?json/i, "json"],
  [/^text\/csv/i, "csv"],
  [/^text\/tab-separated-values/i, "tsv"],
  [/^application\/xml/i, "xml"],
  [/^text\/xml/i, "xml"],
  [/^application\/pdf/i, "pdf"],
  [/^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/i, "excel"],
  [/^application\/vnd\.ms-excel/i, "excel"],
  [/^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/i, "docx"],
  [/^application\/msword/i, "docx"],
  [/^image\//i, "image"],
  [/^text\//i, "text"]
];

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Operation aborted");
  }
}

export async function collectInput(input: ResourceInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  if (input instanceof URL) {
    return Buffer.from(input.toString(), "utf8");
  }

  if (typeof input === "string") {
    return Buffer.from(input, "utf8");
  }

  // Factory function that produces an async iterable (lazy streaming)
  if (typeof input === "function") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input()) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Web ReadableStream
  if (isReadableStream(input)) {
    const chunks: Uint8Array[] = [];
    const reader = input.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }

  if (input instanceof Readable || isAsyncIterable(input) || isIterable(input)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input as AsyncIterable<string | Uint8Array>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    }
    return Buffer.concat(chunks);
  }

  throw new Error("Unsupported resource input");
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string | Uint8Array> {
  return Boolean(value && typeof (value as AsyncIterable<string | Uint8Array>)[Symbol.asyncIterator] === "function");
}

function isIterable(value: unknown): value is Iterable<string | Uint8Array> {
  return Boolean(value && typeof (value as Iterable<string | Uint8Array>)[Symbol.iterator] === "function");
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(value && typeof (value as ReadableStream).getReader === "function" && typeof (value as ReadableStream).locked !== "undefined");
}

export async function readText(input: ResourceInput): Promise<string> {
  const content = await collectInput(input);
  return Buffer.from(content).toString("utf8");
}

export function basenameFromLocation(location: string): string {
  if (/^https?:\/\//i.test(location)) {
    const url = new URL(location);
    const name = path.posix.basename(url.pathname);
    return name || url.hostname || location;
  }

  if (location.startsWith("file://")) {
    return path.basename(fileURLToPath(location));
  }

  return path.basename(location) || location;
}

export function inferTypeFromLocation(location: string, mimeType?: string): ResourceType | undefined {
  const mimeGuess = inferTypeFromMimeType(mimeType);
  if (mimeGuess) {
    return mimeGuess;
  }

  const lower = location.toLowerCase();
  if (lower.endsWith("/dockerfile") || path.basename(lower) === "dockerfile") {
    return "dockerfile";
  }

  const extension = path.extname(lower);
  return EXTENSION_TYPE_MAP[extension];
}

export function inferTypeFromMimeType(mimeType?: string): ResourceType | undefined {
  if (!mimeType) {
    return undefined;
  }

  for (const [pattern, type] of MIME_TYPE_MAP) {
    if (pattern.test(mimeType)) {
      return type;
    }
  }

  return undefined;
}

export function createResourceId(location: string, type: ResourceType): string {
  return `${location}::${type}`;
}

export function createPartId(resource: ParsedResource, index: number, suffix = "part"): string {
  return `${resource.id}::${suffix}/${index}`;
}

export function createSliceId(part: ResourcePart, index: number): string {
  return `${part.id}::slice/${index}`;
}

export function createLinkId(location: string, value: string, index: number): string {
  return `${location}::link/${index}:${value}`;
}

export function dedupeLinks(links: ResourceLink[]): ResourceLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.location}|${link.value}|${link.title ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function splitTextByBoundaries(text: string, maxChars = DEFAULT_MAX_CHARS, minChars = DEFAULT_MIN_CHARS, boundaries = ["\n\n", "\n", " "]): Array<{ start: number; end: number; text: string }> {
  if (text.length <= maxChars) {
    return [{ start: 0, end: text.length, text }];
  }

  const segments: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const remaining = text.length - cursor;
    if (remaining <= maxChars) {
      segments.push({ start: cursor, end: text.length, text: text.slice(cursor) });
      break;
    }

    const targetEnd = cursor + maxChars;
    const minimumEnd = Math.min(text.length, cursor + minChars);
    let bestEnd = -1;

    for (const boundary of boundaries) {
      const found = text.lastIndexOf(boundary, targetEnd);
      if (found >= minimumEnd) {
        bestEnd = found + boundary.length;
        break;
      }
    }

    if (bestEnd === -1 || bestEnd <= cursor) {
      bestEnd = targetEnd;
    }

    segments.push({ start: cursor, end: bestEnd, text: text.slice(cursor, bestEnd) });
    cursor = bestEnd;
  }

  return segments;
}

export function buildEmbedText(context: EmbedTextContext, options: SliceOptions): string {
  if (options.buildEmbedText) {
    return options.buildEmbedText(context);
  }

  const lines = [...context.contextLines];
  if (options.includeLinks !== false && context.slice.links.length > 0) {
    lines.push(`Links: ${context.slice.links.map((link) => link.value).join(", ")}`);
  }
  lines.push(context.slice.text);
  return lines.filter(Boolean).join(options.embedSeparator ?? "\n\n");
}

export function collectEmbedContext(resource: ParsedResource, part: ResourcePart, slice: ResourceSlice, options: SliceOptions): string[] {
  const lines: string[] = [];

  if (options.includeResourceLocation !== false) {
    lines.push(`Resource: ${resource.location}`);
  }

  if (options.includeResourceType !== false) {
    lines.push(`Type: ${resource.type}`);
  }

  if (options.includePartLocation !== false) {
    lines.push(`Part: ${part.location}`);
  }

  if (options.includePartKind) {
    lines.push(`Kind: ${part.kind}`);
  }

  if (options.includeContext !== false) {
    if (slice.context?.headings?.length) {
      lines.push(`Headings: ${slice.context.headings.join(" > ")}`);
    }
    if (slice.context?.declaration) {
      lines.push(`Declaration: ${slice.context.declaration}`);
    }
    if (slice.context?.summary) {
      lines.push(`Summary: ${slice.context.summary}`);
    }
    if (slice.context?.prefixes?.length) {
      lines.push(...slice.context.prefixes.map((prefix) => `Context: ${prefix}`));
    }
  }

  return lines;
}

export function finalizeSlice(resource: ParsedResource, part: ResourcePart, slice: Omit<ResourceSlice, "embedText">, options: SliceOptions): ResourceSlice {
  const incomplete: ResourceSlice = {
    ...slice,
    embedText: ""
  };
  const contextLines = collectEmbedContext(resource, part, incomplete, options);
  return {
    ...incomplete,
    embedText: buildEmbedText({ resource, part, slice: incomplete, contextLines }, options)
  };
}

export function extractLinksFromMarkdown(text: string, location: string): ResourceLink[] {
  const links: ResourceLink[] = [];
  let index = 0;

  for (let cursor = 0; cursor < text.length; cursor++) {
    if (text[cursor] !== "[") {
      continue;
    }

    const labelEnd = text.indexOf("]", cursor + 1);
    if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
      continue;
    }

    const valueEnd = text.indexOf(")", labelEnd + 2);
    if (valueEnd === -1) {
      continue;
    }

    const label = text.slice(cursor + 1, labelEnd).trim();
    const rawValue = text.slice(labelEnd + 2, valueEnd).trim();
    const value = rawValue.split(/\s+/, 1)[0]?.trim();
    if (!value) {
      continue;
    }

    links.push({
      id: createLinkId(location, value, index++),
      value,
      location,
      title: label || undefined,
      kind: isExternalLink(value) ? "external" : "resource"
    });
    cursor = valueEnd;
  }

  return links;
}

export function extractLinksFromHtml(text: string, location: string): ResourceLink[] {
  const links: ResourceLink[] = [];
  let index = 0;
  forEachHtmlTag(text, ({ attributes }) => {
    for (const attribute of ["href", "src"]) {
      const value = attributes[attribute];
      if (!value) {
        continue;
      }

      links.push({
        id: createLinkId(location, value, index++),
        value,
        location,
        kind: isExternalLink(value) ? "external" : "resource"
      });
    }
  });

  return dedupeLinks(links);
}

function readQuotedValue(text: string, start: number): { value: string; end: number } | undefined {
  const quote = text[start];
  if (quote !== "\"" && quote !== "'") {
    return undefined;
  }

  const end = text.indexOf(quote, start + 1);
  if (end === -1) {
    return undefined;
  }

  return {
    value: text.slice(start + 1, end),
    end
  };
}

function parseHtmlAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor++;
    }

    if (cursor >= input.length) {
      break;
    }

    let nameEnd = cursor;
    while (nameEnd < input.length && /[^\s=]/.test(input[nameEnd])) {
      nameEnd++;
    }

    const name = input.slice(cursor, nameEnd).toLowerCase();
    cursor = nameEnd;
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor++;
    }

    if (input[cursor] !== "=") {
      continue;
    }

    cursor++;
    while (cursor < input.length && /\s/.test(input[cursor])) {
      cursor++;
    }

    const quoted = readQuotedValue(input, cursor);
    if (!quoted) {
      continue;
    }

    attributes[name] = quoted.value;
    cursor = quoted.end + 1;
  }

  return attributes;
}

function forEachHtmlTag(text: string, onTag: (tag: { name: string; closing: boolean; attributes: Record<string, string> }) => void): void {
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("<", cursor);
    if (start === -1) {
      return;
    }

    const end = text.indexOf(">", start + 1);
    if (end === -1) {
      return;
    }

    const rawTag = text.slice(start + 1, end).trim();
    const closing = rawTag.startsWith("/");
    const normalized = closing ? rawTag.slice(1).trim() : rawTag;
    const nameMatch = normalized.match(/^[a-zA-Z0-9:-]+/);
    if (nameMatch) {
      const name = nameMatch[0].toLowerCase();
      const attributes = parseHtmlAttributes(normalized.slice(name.length));
      onTag({ name, closing, attributes });
    }

    cursor = end + 1;
  }
}

export function extractLinksFromCode(text: string, location: string): ResourceLink[] {
  const links: ResourceLink[] = [];
  let index = 0;

  const addValue = (value?: string) => {
    if (!value) {
      return;
    }

    links.push({
      id: createLinkId(location, value, index++),
      value,
      location,
      kind: isExternalLink(value) ? "external" : "resource"
    });
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("import ") || trimmed.startsWith("export ")) {
      addValue(readQuotedSpecifier(trimmed));
      continue;
    }

    if (trimmed.includes("require(")) {
      addValue(readCallSpecifier(trimmed, "require"));
    }

    if (trimmed.includes("import(")) {
      addValue(readCallSpecifier(trimmed, "import"));
    }
  }

  return dedupeLinks(links);
}

function readQuotedSpecifier(line: string): string | undefined {
  for (let cursor = 0; cursor < line.length; cursor++) {
    const quoted = readQuotedValue(line, cursor);
    if (quoted) {
      return quoted.value;
    }
  }

  return undefined;
}

function readCallSpecifier(line: string, callName: string): string | undefined {
  const start = line.indexOf(`${callName}(`);
  if (start === -1) {
    return undefined;
  }

  const quoted = readQuotedValue(line, start + callName.length + 1);
  return quoted?.value;
}

export function extractLinksFromText(text: string, location: string): ResourceLink[] {
  const links: ResourceLink[] = [];
  const pattern = /https?:\/\/[^\s)\]>'"]+/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text))) {
    links.push({
      id: createLinkId(location, match[0], index++),
      value: match[0],
      location,
      kind: "external"
    });
  }

  return links;
}

export function isExternalLink(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^mailto:/i.test(value);
}

export function htmlToMarkdown(html: string): string {
  const safeHtml = stripHtmlBlocks(html, ["script", "style"]);
  const parts: string[] = [];
  let cursor = 0;

  while (cursor < safeHtml.length) {
    const tagStart = safeHtml.indexOf("<", cursor);
    if (tagStart === -1) {
      parts.push(safeHtml.slice(cursor));
      break;
    }

    parts.push(safeHtml.slice(cursor, tagStart));
    const tagEnd = safeHtml.indexOf(">", tagStart + 1);
    if (tagEnd === -1) {
      break;
    }

    const rawTag = safeHtml.slice(tagStart + 1, tagEnd).trim();
    const closing = rawTag.startsWith("/");
    const normalized = closing ? rawTag.slice(1).trim() : rawTag;
    const name = normalized.split(/\s+/, 1)[0]?.toLowerCase();
    const attributes = parseHtmlAttributes(normalized.slice(name?.length ?? 0));

    if (name) {
      if (!closing && /^h[1-6]$/.test(name)) {
        parts.push(`\n\n${"#".repeat(Number(name[1]))} `);
      } else if (!closing && name === "li") {
        parts.push("\n- ");
      } else if (!closing && name === "br") {
        parts.push("\n");
      } else if (!closing && name === "img" && attributes.src) {
        parts.push(`![${attributes.alt || attributes.src}](${attributes.src})`);
      } else if (closing && /^h[1-6]$/.test(name)) {
        parts.push("\n\n");
      } else if (closing && ["p", "div", "section", "article", "header", "footer", "ul", "ol", "li"].includes(name)) {
        parts.push("\n\n");
      }
    }

    cursor = tagEnd + 1;
  }

  return collapseWhitespace(decodeHtmlEntities(parts.join(""))).trim();
}

export function stripTags(value: string): string {
  let output = "";
  let insideTag = false;

  for (const character of value) {
    if (character === "<") {
      insideTag = true;
      output += " ";
      continue;
    }

    if (character === ">") {
      insideTag = false;
      continue;
    }

    if (!insideTag) {
      output += character;
    }
  }

  return collapseInlineWhitespace(decodeHtmlEntities(output)).trim();
}

export function toFilePath(location: string): string {
  return location.startsWith("file://") ? fileURLToPath(location) : location;
}

export function normalizeDeclaration(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

export function toHeadingContext(pathSegments: string[]): SliceContext | undefined {
  if (pathSegments.length === 0) {
    return undefined;
  }

  return { headings: pathSegments.slice() };
}

function stripHtmlBlocks(html: string, tagNames: string[]): string {
  const lower = html.toLowerCase();
  let result = "";
  let cursor = 0;

  while (cursor < html.length) {
    let matchedTag: string | undefined;
    let matchedStart = html.length;

    for (const tagName of tagNames) {
      const candidate = lower.indexOf(`<${tagName}`, cursor);
      if (candidate !== -1 && candidate < matchedStart) {
        matchedStart = candidate;
        matchedTag = tagName;
      }
    }

    if (!matchedTag) {
      result += html.slice(cursor);
      break;
    }

    result += html.slice(cursor, matchedStart);
    const openEnd = html.indexOf(">", matchedStart);
    if (openEnd === -1) {
      break;
    }

    const closeTagStart = lower.indexOf(`</${matchedTag}`, openEnd + 1);
    if (closeTagStart === -1) {
      cursor = openEnd + 1;
      continue;
    }

    const closeTagEnd = html.indexOf(">", closeTagStart + matchedTag.length + 2);
    if (closeTagEnd === -1) {
      break;
    }

    cursor = closeTagEnd + 1;
  }

  return result;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function collapseInlineWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
