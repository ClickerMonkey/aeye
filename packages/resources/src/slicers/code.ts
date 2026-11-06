import type { CodeParserOptions, ResourceSlice, ResourceSlicer, ResourceType } from "../types";
import {
  CODE_TYPES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_CHARS,
  createSliceId,
  dedupeSliceLinks,
  extractLinksFromCode,
  extractLinksFromText,
  finalizeSlice,
  normalizeDeclaration,
} from "../utils";
import { defaultTextSegmenter } from "../segmenters";

const JS_DECLARATION_PATTERN = /^(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|const|let|var|namespace|module)\b/;
const GENERIC_DECLARATION_PATTERN = /^((public|private|protected|internal|static|final|abstract|sealed|open|override|data|export|async|suspend|inline|extern|pub)\s+)*(function|class|interface|enum|struct|record|object|trait|fun|func|def|fn|protocol|extension|namespace|module|typedef|template|impl)\b/;

/** Per-language top-level declaration patterns, matched against unindented lines. */
export const CODE_DECLARATION_PATTERNS: Partial<Record<ResourceType, RegExp>> = {
  javascript: JS_DECLARATION_PATTERN,
  typescript: JS_DECLARATION_PATTERN,
  jsx: JS_DECLARATION_PATTERN,
  tsx: JS_DECLARATION_PATTERN,
  python: /^(async\s+)?(def|class)\s/,
  ruby: /^(def|class|module)\s/,
  go: /^(func|type|var|const)\b/,
  rust: /^(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?(fn|struct|enum|trait|impl|mod|type|const|static|macro_rules!)\b/,
  lua: /^(local\s+)?function\b/,
  shell: /^(function\s+[\w-]+|[\w-]+\s*\(\)\s*\{?)/,
  sql: /^(create|alter|drop|insert|update|delete|select|with)\b/i,
  graphql: /^(type|input|enum|interface|union|scalar|schema|query|mutation|subscription|fragment|extend|directive)\b/,
};

const DEFAULT_IMPORT_PATTERN = /^(import\b|from\s+\S+\s+import\b|export\b[^;]*\bfrom\b|(const|let|var)\b[^;]*=\s*require\(|use\s+[\w:{]|#include\b|require(_relative)?\b)/;
const DEFAULT_CODE_BOUNDARIES = ["\n\n", "\n", " "];
const DEFAULT_MAX_IMPORT_PREFIXES = 5;
const HASH_COMMENT_TYPES = new Set<ResourceType>(["python", "ruby", "shell", "r", "dockerfile"]);

/** Lines that belong to the declaration below them: decorators, attributes and doc comments. */
function isLeadingLine(trimmed: string, type: ResourceType): boolean {
  return /^(@|\/\/|\/\*|\*|#\[|--)/.test(trimmed) || (HASH_COMMENT_TYPES.has(type) && trimmed.startsWith("#"));
}

interface CodeBlock {
  start: number;
  end: number;
  declaration?: string;
}

/**
 * Splits code into blocks at top-level declarations. Text before the first declaration (license
 * header, imports) is its own block, so the blocks cover the whole text. Doc comments and decorators
 * directly above a declaration stay with it.
 */
export function splitCodeBlocks(text: string, type: ResourceType, options: CodeParserOptions = {}): CodeBlock[] {
  const pattern = options.declarationPattern ?? CODE_DECLARATION_PATTERNS[type] ?? GENERIC_DECLARATION_PATTERN;
  const topLevelOnly = options.topLevelOnly ?? true;
  const lines = text.split(/(?<=\n)/);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }

  const starts: Array<{ start: number; declaration: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (topLevelOnly && /^\s/.test(line)) {
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || !pattern.test(trimmed)) {
      continue;
    }
    // Pull in contiguous doc comments / decorators above the declaration.
    let first = i;
    while (first > 0 && (starts.length === 0 || offsets[first - 1] > starts[starts.length - 1].start)) {
      const above = lines[first - 1].trim();
      if (!above || !isLeadingLine(above, type)) break;
      first--;
    }
    starts.push({ start: offsets[first], declaration: normalizeDeclaration(trimmed) });
  }

  if (starts.length === 0) {
    return [{ start: 0, end: text.length }];
  }

  const blocks: CodeBlock[] = [];
  if (starts[0].start > 0) {
    blocks.push({ start: 0, end: starts[0].start });
  }
  starts.forEach((entry, index) => {
    blocks.push({ start: entry.start, end: starts[index + 1]?.start ?? text.length, declaration: entry.declaration });
  });
  return blocks;
}

export const codeSlicer: ResourceSlicer = {
  id: "code",
  supportedTypes: [...CODE_TYPES],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? DEFAULT_MAX_CHARS;
    const minChars = context.options.minChars ?? DEFAULT_MIN_CHARS;
    const boundaries = context.options.boundaries ?? DEFAULT_CODE_BOUNDARIES;
    const segment = context.options.segmenter ?? defaultTextSegmenter;
    const codeOpts: CodeParserOptions = context.options.code ?? {};
    const importPattern = codeOpts.importPattern ?? DEFAULT_IMPORT_PATTERN;
    const maxImportPrefixes = codeOpts.maxImportPrefixes ?? DEFAULT_MAX_IMPORT_PREFIXES;

    for (const part of resource.parts) {
      const text = part.text;
      if (!text) {
        continue;
      }

      const importLines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => importPattern.test(line))
        .map(normalizeDeclaration);

      for (const [index, block] of splitCodeBlocks(text, resource.type, codeOpts).entries()) {
        const blockText = text.slice(block.start, block.end);
        const sectionId = `${part.location}#block/${index}`;
        const segments = await segment(blockText, {
          maxChars,
          minChars,
          boundaries,
          type: resource.type,
          slicerId: "code",
          signal: context.options.signal,
        });

        segments.forEach((seg, segmentIndex) => {
          const location = `${sectionId}/slice/${segmentIndex}`;
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location,
            sectionId,
            text: seg.text,
            start: block.start + seg.start,
            end: block.start + seg.end,
            context: {
              declaration: block.declaration,
              prefixes: importLines.slice(0, maxImportPrefixes)
            },
            links: dedupeSliceLinks([
              // Only the part's links that actually appear in this slice.
              ...(part.links ?? []).filter((link) => seg.text.includes(link.value)),
              ...extractLinksFromCode(seg.text, location),
              ...extractLinksFromText(seg.text, location)
            ])
          };
          slices.push(finalizeSlice(resource, part, rawSlice, context.options));
        });
      }
    }

    return slices;
  }
};
