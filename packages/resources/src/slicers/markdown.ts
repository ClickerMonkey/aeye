import type { ResourceSlice, ResourceSlicer } from "../types";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_CHARS,
  createSliceId,
  dedupeLinks,
  extractLinksFromMarkdown,
  extractLinksFromText,
  finalizeSlice,
  toHeadingContext,
} from "../utils";
import { defaultTextSegmenter } from "../segmenters";

const DEFAULT_MARKDOWN_BOUNDARIES = ["\n\n", "\n", ". ", " "];

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
      const headingMatches = [...text.matchAll(/^(#{1,6}) (.+)$/gm)];
      const sections = headingMatches.length === 0
        ? [{ start: 0, end: text.length, headings: [] as string[] }]
        : headingMatches.map((match, index) => {
            const level = match[1].length;
            const title = match[2].trim();
            const start = match.index ?? 0;
            const end = headingMatches[index + 1]?.index ?? text.length;
            const headings = headingMatches
              .slice(0, index + 1)
              .reduce<string[]>((stack, current) => {
                const currentLevel = current[1].length;
                const currentTitle = current[2].trim();
                stack.splice(currentLevel - 1);
                stack[currentLevel - 1] = currentTitle;
                return stack.filter(Boolean);
              }, [])
              .slice(0, level);
            return { start, end, headings: headings.length > 0 ? headings : [title] };
          });

      for (const [sectionIndex, section] of sections.entries()) {
        const sectionText = text.slice(section.start, section.end);
        const segments = await segment(sectionText, {
          maxChars,
          minChars,
          boundaries,
          type: resource.type,
          slicerId: "markdown",
          signal: context.options.signal,
        });
        segments.forEach((seg, index) => {
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location: `${part.location}#section/${sectionIndex}/slice/${index}`,
            text: seg.text,
            start: section.start + seg.start,
            end: section.start + seg.end,
            context: toHeadingContext(section.headings),
            links: dedupeLinks([
              ...extractLinksFromMarkdown(seg.text, `${part.location}#section/${sectionIndex}/slice/${index}`),
              ...extractLinksFromText(seg.text, `${part.location}#section/${sectionIndex}/slice/${index}`)
            ])
          };
          slices.push(finalizeSlice(resource, part, rawSlice, context.options));
        });
      }
    }

    return slices;
  }
};
