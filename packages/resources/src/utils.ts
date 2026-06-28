import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmbedTextContext, ParsedResource, ResourceInput, ResourceLink, ResourcePart, ResourceSlice, ResourceSource, ResourceType, SliceContext, SliceOptions } from "./types.js";

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
  ".avif": "image"
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
  const pattern = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text))) {
    links.push({
      id: createLinkId(location, match[2], index++),
      value: match[2],
      location,
      title: match[3] || match[1] || undefined,
      kind: isExternalLink(match[2]) ? "external" : "resource"
    });
  }

  return links;
}

export function extractLinksFromHtml(text: string, location: string): ResourceLink[] {
  const links: ResourceLink[] = [];
  const pattern = /<(a|img|script|link)\b[^>]*(href|src)=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text))) {
    links.push({
      id: createLinkId(location, match[3], index++),
      value: match[3],
      location,
      kind: isExternalLink(match[3]) ? "external" : "resource"
    });
  }

  return links;
}

export function extractLinksFromCode(text: string, location: string): ResourceLink[] {
  const links: ResourceLink[] = [];
  const patterns = [
    /(?:import|export)\s+(?:[^'"`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /from\s+["'`]([^"'`]+)["'`]/g
  ];

  let index = 0;
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const value = match[1];
      links.push({
        id: createLinkId(location, value, index++),
        value,
        location,
        kind: isExternalLink(value) ? "external" : "resource"
      });
    }
  }

  return dedupeLinks(links);
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
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => `${"#".repeat(Number(level))} ${stripTags(content)}\n\n`)
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_match, content) => `${stripTags(content)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => `- ${stripTags(content)}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, content) => `[${stripTags(content) || href}](${href})`)
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (_match, alt, src) => `![${alt || src}](${src})`)
    .replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi, (_match, src) => `![](${src})`)
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
