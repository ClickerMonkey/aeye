import path from "node:path";
import type { ResolverContext, ResourceResolver, ResourceSource, ResourceStat } from "../types";
import {
  assertNotAborted,
  basenameFromLocation,
  buildZipEntryLocation,
  hasUriScheme,
  isHttpUrl,
  isZipEntryLocation,
  parseZipEntryLocation,
  resolveZipEntryName,
  toFilePath,
} from "../utils";
import { ZIP_LIMITS, getCachedZip } from "../zip-internal";

interface ZipTarget {
  zipLocation: string;
  entryName: string;
}

/** Determines which zip + entry a link refers to, either directly or relative to a zip-entry base. */
function resolveZipTarget(link: string, context: ResolverContext): ZipTarget | undefined {
  if (isZipEntryLocation(link)) {
    return parseZipEntryLocation(link);
  }
  const baseLocation = context.options.baseLocation;
  if (baseLocation && isZipEntryLocation(baseLocation) && isRelativeLink(link)) {
    const base = parseZipEntryLocation(baseLocation)!;
    return { zipLocation: base.zipLocation, entryName: resolveZipEntryName(base.entryName, link) };
  }
  return undefined;
}

function isRelativeLink(link: string): boolean {
  return !isHttpUrl(link) && !hasUriScheme(link) && !link.startsWith("//");
}

/**
 * Resolves links to entries inside a zip archive — both fully-qualified zip-entry locations
 * (`bundle.zip#entry/doc.md`) and links relative to another entry (`./other.md` from within an entry).
 * This lets a resource graph follow cross-references between files contained in the same archive.
 */
export const zipResolver: ResourceResolver = {
  id: "zip",
  canResolve(link, context) {
    return Boolean(resolveZipTarget(link, context));
  },
  async resolve(link, context): Promise<ResourceSource | undefined> {
    assertNotAborted(context.options.signal);
    const target = resolveZipTarget(link, context);
    if (!target) {
      return undefined;
    }

    const zip = await getCachedZip(toFilePath(target.zipLocation));
    const entry = zip?.files[target.entryName];
    if (!entry || entry.dir) {
      return undefined;
    }

    const data = await entry.async("uint8array");
    if (data.length > ZIP_LIMITS.MAX_FILE_SIZE) {
      throw new Error(`File in zip exceeds size limit: ${target.entryName}`);
    }

    const location = buildZipEntryLocation(target.zipLocation, target.entryName);
    return {
      location,
      input: data,
      type: context.registry.inferType(target.entryName),
      name: path.posix.basename(target.entryName) || basenameFromLocation(location),
      modifiedAt: entry.date instanceof Date ? entry.date.getTime() : undefined,
      size: data.length,
      metadata: { parentLocation: target.zipLocation },
    };
  },
  async stat(link, context): Promise<ResourceStat | undefined> {
    assertNotAborted(context.options.signal);
    const target = resolveZipTarget(link, context);
    if (!target) {
      return undefined;
    }

    const zip = await getCachedZip(toFilePath(target.zipLocation));
    const entry = zip?.files[target.entryName];
    if (!entry || entry.dir) {
      return undefined;
    }

    return {
      location: buildZipEntryLocation(target.zipLocation, target.entryName),
      type: context.registry.inferType(target.entryName),
      modifiedAt: entry.date instanceof Date ? entry.date.getTime() : undefined,
    };
  }
};
