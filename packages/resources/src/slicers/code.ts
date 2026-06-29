import type { CodeParserOptions, ResourceSlice, ResourceSlicer } from "../types";
import {
  CODE_TYPES,
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_CHARS,
  createSliceId,
  dedupeLinks,
  extractLinksFromCode,
  extractLinksFromText,
  finalizeSlice,
  normalizeDeclaration,
} from "../utils";
import { defaultTextSegmenter } from "../segmenters";

const DEFAULT_DECLARATION_PATTERN = /^(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\s+([^=(<{]+)/;
const DEFAULT_IMPORT_PATTERN = /^(import\b|export\b[^;]*\bfrom\b|const\b[^;]*=\s*require\()/;
const DEFAULT_CODE_BOUNDARIES = ["\n\n", "\n", " "];
const DEFAULT_MAX_IMPORT_PREFIXES = 5;

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
    const declarationPattern = codeOpts.declarationPattern ?? DEFAULT_DECLARATION_PATTERN;
    const importPattern = codeOpts.importPattern ?? DEFAULT_IMPORT_PATTERN;
    const maxImportPrefixes = codeOpts.maxImportPrefixes ?? DEFAULT_MAX_IMPORT_PREFIXES;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const lines = part.text.split(/(?<=\n)/);
      const declarationIndexes: number[] = [];
      let offset = 0;
      const importLines: string[] = [];

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (importPattern.test(trimmed)) {
          importLines.push(normalizeDeclaration(trimmed));
        }
        if (declarationPattern.test(trimmed)) {
          declarationIndexes.push(offset);
        }
        offset += line.length;
      });

      const starts = declarationIndexes.length > 0 ? declarationIndexes : [0];
      for (const [index, start] of starts.entries()) {
        const end = starts[index + 1] ?? part.text!.length;
        const block = part.text!.slice(start, end);
        const declaration = normalizeDeclaration(block.split(/\r?\n/, 1)[0] ?? "");
        const segments = await segment(block, {
          maxChars,
          minChars,
          boundaries,
          type: resource.type,
          slicerId: "code",
          signal: context.options.signal,
        });

        segments.forEach((seg, segmentIndex) => {
          const location = `${part.location}#block/${index}/slice/${segmentIndex}`;
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location,
            text: seg.text,
            start: start + seg.start,
            end: start + seg.end,
            context: {
              declaration,
              prefixes: importLines.slice(0, maxImportPrefixes)
            },
            links: dedupeLinks([
              ...(part.links ?? []),
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
