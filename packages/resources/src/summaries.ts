import type { ParsedResource, ResourcePart, ResourceSlice, SliceOptions } from "./types";
import { assertNotAborted, finalizeSlice } from "./utils";

const DEFAULT_SUMMARY_CONCURRENCY = 4;

/** Runs async tasks with at most `limit` in flight at once. */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const max = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

interface SectionGroup {
  sectionId: string;
  part?: ResourcePart;
  slices: ResourceSlice[];
}

/** Reads cached section summaries from resource metadata. */
function cachedSectionSummaries(resource: ParsedResource): Record<string, string> {
  const value = resource.metadata?.sectionSummaries;
  return value && typeof value === "object" ? { ...(value as Record<string, string>) } : {};
}

/**
 * Fills `context.summary` (whole resource) and/or `context.sectionSummary` (the slice's section) on
 * each slice using {@link SliceOptions.summarize}, then rebuilds each slice's embed text. Summaries are
 * cached on the resource's metadata (`summary`, `sectionSummaries`) so a resource is summarized once
 * even when it is sliced again or reused from a cache.
 */
export async function applySummaries(resource: ParsedResource, slices: ResourceSlice[], options: SliceOptions): Promise<ResourceSlice[]> {
  const summarize = options.summarize;
  if (!summarize || slices.length === 0) {
    return slices;
  }

  const scope = options.summaryScope ?? "resource";
  const wantResource = scope === "resource" || scope === "both";
  const wantSections = scope === "section" || scope === "both";
  const minSectionChars = options.minSectionSummaryChars ?? 0;
  const limit = createLimiter(options.summaryConcurrency ?? DEFAULT_SUMMARY_CONCURRENCY);
  const signal = options.signal;

  const partsById = new Map(resource.parts.map((part) => [part.id, part]));
  const groups = new Map<string, SectionGroup>();
  for (const slice of slices) {
    const sectionId = slice.sectionId ?? slice.partId;
    const group = groups.get(sectionId) ?? { sectionId, part: partsById.get(slice.partId), slices: [] };
    group.slices.push(slice);
    groups.set(sectionId, group);
  }

  const resourceText = resource.parts
    .map((part) => part.text ?? "")
    .filter((text) => text.trim().length > 0)
    .join("\n\n");

  const sectionText = (group: SectionGroup): string => {
    const text = group.part?.text;
    if (text) {
      const start = Math.min(...group.slices.map((slice) => slice.start));
      const end = Math.max(...group.slices.map((slice) => slice.end));
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return text.slice(start, end);
      }
    }
    return group.slices.map((slice) => slice.text).join("");
  };

  // Whole-resource summary.
  let resourceSummary = typeof resource.metadata?.summary === "string" ? resource.metadata.summary : undefined;
  const resourceTask = wantResource && !resourceSummary && resourceText.trim()
    ? limit(async () => {
        assertNotAborted(signal);
        resourceSummary = await summarize({ scope: "resource", resource, text: resourceText, signal });
      })
    : Promise.resolve();

  // Per-section summaries.
  const sectionSummaries = cachedSectionSummaries(resource);
  const sectionTasks: Array<Promise<void>> = [];
  if (wantSections) {
    for (const group of groups.values()) {
      if (sectionSummaries[group.sectionId]) continue;
      const text = sectionText(group);
      if (!text.trim() || text.trim().length < minSectionChars) continue;
      // A section that is the whole resource would just repeat the resource summary.
      if (wantResource && groups.size === 1 && text.trim() === resourceText.trim()) continue;
      const first = group.slices[0];
      sectionTasks.push(limit(async () => {
        assertNotAborted(signal);
        const summary = await summarize({
          scope: "section",
          resource,
          text,
          sectionId: group.sectionId,
          headings: first.context?.headings,
          declaration: first.context?.declaration,
          signal,
        });
        if (summary) {
          sectionSummaries[group.sectionId] = summary;
        }
      }));
    }
  }

  await Promise.all([resourceTask, ...sectionTasks]);
  assertNotAborted(signal);

  resource.metadata = {
    ...resource.metadata,
    ...(resourceSummary ? { summary: resourceSummary } : {}),
    ...(Object.keys(sectionSummaries).length > 0 ? { sectionSummaries } : {}),
  };

  return slices.map((slice) => {
    const sectionSummary = wantSections ? sectionSummaries[slice.sectionId ?? slice.partId] : undefined;
    const summary = wantResource ? resourceSummary : undefined;
    if (!summary && !sectionSummary) {
      return slice;
    }
    const part = partsById.get(slice.partId) ?? { id: slice.partId, location: slice.location, kind: "text" as const };
    const { embedText: _embedText, ...rest } = slice;
    return finalizeSlice(resource, part, {
      ...rest,
      context: {
        ...slice.context,
        ...(summary ? { summary } : {}),
        ...(sectionSummary ? { sectionSummary } : {}),
      },
    }, options);
  });
}
