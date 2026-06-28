import type { ResourceSlice, ResourceSlicer } from "../types";
import {
  createSliceId,
  dedupeLinks,
  extractLinksFromMarkdown,
  extractLinksFromText,
  finalizeSlice,
  splitTextByBoundaries,
  toHeadingContext,
} from "../utils";

export const markdownSlicer: ResourceSlicer = {
  id: "markdown",
  supportedTypes: ["markdown", "html"],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? 2000;
    const minChars = context.options.minChars ?? 400;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const text = part.text;
      const headingMatches = [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)];
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

      sections.forEach((section, sectionIndex) => {
        const sectionText = text.slice(section.start, section.end);
        const segments = splitTextByBoundaries(sectionText, maxChars, minChars, ["\n\n", "\n", ". ", " "]);
        segments.forEach((segment, index) => {
          const rawSlice = {
            id: createSliceId(part, slices.length),
            resourceId: resource.id,
            partId: part.id,
            location: `${part.location}#section/${sectionIndex}/slice/${index}`,
            text: segment.text,
            start: section.start + segment.start,
            end: section.start + segment.end,
            context: toHeadingContext(section.headings),
            links: dedupeLinks([
              ...extractLinksFromMarkdown(segment.text, `${part.location}#section/${sectionIndex}/slice/${index}`),
              ...extractLinksFromText(segment.text, `${part.location}#section/${sectionIndex}/slice/${index}`)
            ])
          };
          slices.push(finalizeSlice(resource, part, rawSlice, context.options));
        });
      });
    }

    return slices;
  }
};
