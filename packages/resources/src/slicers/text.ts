import type { ResourceSlice, ResourceSlicer } from "../types";
import {
  createSliceId,
  dedupeLinks,
  extractLinksFromText,
  finalizeSlice,
  splitTextByBoundaries,
} from "../utils";

export const textSlicer: ResourceSlicer = {
  id: "text",
  supportedTypes: ["*"],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? 2000;
    const minChars = context.options.minChars ?? 400;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const segments = splitTextByBoundaries(part.text, maxChars, minChars);
      segments.forEach((segment, index) => {
        const rawSlice = {
          id: createSliceId(part, slices.length),
          resourceId: resource.id,
          partId: part.id,
          location: `${part.location}#slice/${index}`,
          text: segment.text,
          start: segment.start,
          end: segment.end,
          links: dedupeLinks([
            ...(part.links ?? []).filter((link) => part.text?.includes(link.value)),
            ...extractLinksFromText(segment.text, `${part.location}#slice/${index}`)
          ])
        };
        slices.push(finalizeSlice(resource, part, rawSlice, context.options));
      });
    }

    return slices;
  }
};
