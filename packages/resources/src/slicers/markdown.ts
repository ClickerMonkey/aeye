import type { ResourceSlice, ResourceSlicer } from "../types";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_CHARS,
  createSliceId,
  dedupeSliceLinks,
  extractLinksFromMarkdown,
  extractLinksFromText,
  finalizeSlice,
  toHeadingContext,
} from "../utils";
import { defaultTextSegmenter } from "../segmenters";

const DEFAULT_MARKDOWN_BOUNDARIES = ["\n\n", "\n", ". ", " "];

export interface MarkdownSection {
  start: number;
  end: number;
  /** Heading path for the section (empty for text before the first heading). */
  headings: string[];
}

const HEADING_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Splits markdown into sections at ATX headings. Headings inside fenced code blocks are ignored, and
 * any text before the first heading becomes its own section, so the sections cover the whole text.
 */
export function splitMarkdownSections(text: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const stack: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let current: MarkdownSection = { start: 0, end: text.length, headings: [] };
  let offset = 0;

  for (const rawLine of text.split(/(?<=\n)/)) {
    const line = rawLine.replace(/\r?\n$/, "");
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && line.trim() === fenceMatch[1].trim()) {
        fence = undefined;
      }
    } else if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    } else {
      const heading = HEADING_PATTERN.exec(line);
      if (heading) {
        const level = heading[1].length;
        stack.length = Math.min(stack.length, level - 1);
        stack[level - 1] = heading[2].trim();
        if (offset > current.start) {
          current.end = offset;
          sections.push(current);
        }
        current = { start: offset, end: text.length, headings: stack.filter(Boolean) };
      }
    }
    offset += rawLine.length;
  }

  if (current.end > current.start || sections.length === 0) {
    sections.push(current);
  }
  return sections;
}

export const markdownSlicer: ResourceSlicer = {
  id: "markdown",
  supportedTypes: ["markdown", "html"],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? DEFAULT_MAX_CHARS;
    const minChars = context.options.minChars ?? DEFAULT_MIN_CHARS;
    const boundaries = context.options.boundaries ?? DEFAULT_MARKDOWN_BOUNDARIES;
    const segment = context.options.segmenter ?? defaultTextSegmenter;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const text = part.text;
      for (const [sectionIndex, section] of splitMarkdownSections(text).entries()) {
        const sectionText = text.slice(section.start, section.end);
        const sectionId = `${part.location}#section/${sectionIndex}`;
        const segments = await segment(sectionText, {
          maxChars,
          minChars,
          boundaries,
          type: resource.type,
          slicerId: "markdown",
          signal: context.options.signal,
        });
        segments.forEach((seg, index) => {
          const location = `${sectionId}/slice/${index}`;
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location,
            sectionId,
            text: seg.text,
            start: section.start + seg.start,
            end: section.start + seg.end,
            context: toHeadingContext(section.headings),
            links: dedupeSliceLinks([
              ...extractLinksFromMarkdown(seg.text, location),
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
