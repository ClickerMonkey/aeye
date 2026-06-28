import type { CodeParserOptions, ResourceSlice, ResourceSlicer } from "../types";
import {
  CODE_TYPES,
  createSliceId,
  dedupeLinks,
  extractLinksFromCode,
  extractLinksFromText,
  finalizeSlice,
  normalizeDeclaration,
  splitTextByBoundaries,
} from "../utils";

const DEFAULT_DECLARATION_PATTERN = /^(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\s+([^=(<{]+)/;
const DEFAULT_IMPORT_PATTERN = /^(import\b|export\b[^;]*\bfrom\b|const\b[^;]*=\s*require\()/;

export const codeSlicer: ResourceSlicer = {
  id: "code",
  supportedTypes: [...CODE_TYPES],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? 2000;
    const minChars = context.options.minChars ?? 400;
    const codeOpts: CodeParserOptions = context.options.code ?? {};
    const declarationPattern = codeOpts.declarationPattern ?? DEFAULT_DECLARATION_PATTERN;
    const importPattern = codeOpts.importPattern ?? DEFAULT_IMPORT_PATTERN;

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
      starts.forEach((start, index) => {
        const end = starts[index + 1] ?? part.text!.length;
        const block = part.text!.slice(start, end);
        const declaration = normalizeDeclaration(block.split(/\r?\n/, 1)[0] ?? "");
        const segments = splitTextByBoundaries(block, maxChars, minChars, ["\n\n", "\n", " "]);

        segments.forEach((segment, segmentIndex) => {
          const location = `${part.location}#block/${index}/slice/${segmentIndex}`;
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location,
            text: segment.text,
            start: start + segment.start,
            end: start + segment.end,
            context: {
              declaration,
              prefixes: importLines.slice(0, 5)
            },
            links: dedupeLinks([
              ...(part.links ?? []),
              ...extractLinksFromCode(segment.text, location),
              ...extractLinksFromText(segment.text, location)
            ])
          };
          slices.push(finalizeSlice(resource, part, rawSlice, context.options));
        });
      });
    }

    return slices;
  }
};
