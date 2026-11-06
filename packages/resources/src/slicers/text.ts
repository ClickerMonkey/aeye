import type { ResourceSlice, ResourceSlicer } from "../types";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MIN_CHARS,
  createSliceId,
  dedupeSliceLinks,
  extractLinksFromText,
  finalizeSlice,
} from "../utils";
import { defaultTextSegmenter } from "../segmenters";

export const textSlicer: ResourceSlicer = {
  id: "text",
  supportedTypes: ["*"],
  async slice(resource, context) {
    const slices: ResourceSlice[] = [];
    const maxChars = context.options.maxChars ?? DEFAULT_MAX_CHARS;
    const minChars = context.options.minChars ?? DEFAULT_MIN_CHARS;
    const segment = context.options.segmenter ?? defaultTextSegmenter;

    for (const part of resource.parts) {
      if (!part.text) {
        continue;
      }

      const segments = await segment(part.text, {
        maxChars,
        minChars,
        boundaries: context.options.boundaries,
        type: resource.type,
        slicerId: "text",
        signal: context.options.signal,
      });
      segments.forEach((segment, index) => {
        const rawSlice = {
          id: createSliceId(part, slices.length),
          resourceId: resource.id,
          partId: part.id,
          location: `${part.location}#slice/${index}`,
          sectionId: part.location,
          text: segment.text,
          start: segment.start,
          end: segment.end,
          links: dedupeSliceLinks([
            // Only the part's links that actually appear in this slice.
            ...(part.links ?? []).filter((link) => segment.text.includes(link.value)),
            ...extractLinksFromText(segment.text, `${part.location}#slice/${index}`)
          ])
        };
        slices.push(finalizeSlice(resource, part, rawSlice, context.options));
      });
    }

    return slices;
  }
};
