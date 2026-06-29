import { Buffer } from "node:buffer";
import { createParsedResource } from "../registry";
import type { ParsedResource, ResourceParser, ResourcePart, ResourceSource, SupportContext } from "../types";
import {
  assertNotAborted,
  buildZipEntryLocation,
  createPartId,
  createResourceId,
  dedupeLinks,
  imageMimeTypeFromLocation,
  toFilePath,
} from "../utils";
import { ZIP_LIMITS, getCachedZip, loadJSZip } from "../zip-internal";

export const zipParser: ResourceParser = {
  id: "zip-parser",
  supportedTypes: ["zip"],
  defaultSlicer: "text",
  async isSupported(_type: string, _context: SupportContext) {
    return Boolean(await loadJSZip());
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    if (!(await loadJSZip())) {
      throw new Error("jszip is not installed. Install it to parse ZIP resources: npm install jszip");
    }

    // Read (and cache) the zip from the file system to avoid holding the entire zip in JS heap.
    const filePath = toFilePath(source.location);
    const zip = await getCachedZip(filePath);
    if (!zip) {
      throw new Error("jszip is not installed. Install it to parse ZIP resources: npm install jszip");
    }

    const resource = createParsedResource(source);
    resource.defaultSlicer = "text";
    resource.children = [];

    const entries = Object.values(zip.files);
    let fileCount = 0;
    let totalSize = 0;

    // Build a text listing of zip contents as the main part
    const listing: string[] = [];

    // Extract entries one at a time to keep memory usage low
    for (const entry of entries) {
      assertNotAborted(context.options.signal);

      if (entry.dir) {
        continue;
      }

      fileCount++;
      if (fileCount > ZIP_LIMITS.MAX_FILES) {
        throw new Error(`Zip file contains too many files (max: ${ZIP_LIMITS.MAX_FILES})`);
      }

      // Extract one entry at a time to avoid holding all in memory simultaneously
      const entryData = await entry.async("uint8array");
      const uncompressedSize = entryData.length;

      if (uncompressedSize > ZIP_LIMITS.MAX_FILE_SIZE) {
        throw new Error(`File in zip exceeds size limit: ${entry.name}`);
      }

      totalSize += uncompressedSize;
      if (totalSize > ZIP_LIMITS.MAX_TOTAL_SIZE) {
        throw new Error(`Zip file total uncompressed size exceeds limit (max: ${Math.round(ZIP_LIMITS.MAX_TOTAL_SIZE / 1024 / 1024)}MB)`);
      }

      listing.push(entry.name);

      // Create a child resource for each file entry
      const childLocation = buildZipEntryLocation(source.location, entry.name);
      const entryType = context.registry.inferType(entry.name);
      const modifiedAt = entry.date instanceof Date ? entry.date.getTime() : undefined;

      // Try to parse the entry through the registry so its links/parts join the resource graph.
      // Parsers that read from the filesystem (e.g. nested pdf/zip) cannot handle in-memory entries
      // and will throw, in which case we fall back to a raw representation below.
      let childResource: ParsedResource | undefined;
      if (entryType) {
        const childSource: ResourceSource = {
          location: childLocation,
          input: entryData,
          type: entryType,
          name: entry.name,
          modifiedAt,
          size: uncompressedSize,
          metadata: { size: uncompressedSize, parentLocation: source.location },
        };
        try {
          childResource = await context.registry.parseSource(childSource, context.options);
        } catch {
          childResource = undefined;
        }
      }

      if (!childResource) {
        childResource = createRawEntryResource(childLocation, entry.name, entryType, entryData, uncompressedSize, modifiedAt);
      }

      childResource.parentLocation = source.location;
      childResource.modifiedAt = childResource.modifiedAt ?? modifiedAt;
      resource.children.push(childResource);
    }

    // Add a text listing part to the parent resource
    const listingText = `Zip archive: ${source.name ?? source.location}\nFiles (${fileCount}):\n${listing.map((f) => `  ${f}`).join("\n")}`;
    const listingPart: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#listing`,
      kind: "text",
      text: listingText,
      metadata: { fileCount, totalSize },
    };
    resource.parts.push(listingPart);
    resource.links = dedupeLinks(resource.children.flatMap((c) => c.links));

    return resource;
  }
};

/** Builds a minimal child resource for an entry that could not be parsed by a registered parser. */
function createRawEntryResource(
  childLocation: string,
  name: string,
  entryType: string | undefined,
  entryData: Uint8Array,
  size: number,
  modifiedAt: number | undefined,
): ParsedResource {
  const childResource: ParsedResource = {
    id: createResourceId(childLocation, entryType ?? "unknown"),
    location: childLocation,
    type: entryType ?? "unknown",
    name,
    modifiedAt,
    size,
    metadata: { size },
    defaultSlicer: "text",
    parts: [],
    links: [],
  };

  const childPart: ResourcePart = {
    id: createPartId(childResource, 0),
    location: `${childLocation}#part/0`,
    kind: entryType === "image" ? "image" : "text",
    data: entryData,
    mimeType: entryType === "image" ? imageMimeTypeFromLocation(name) : undefined,
  };

  // For text-like files, decode the content
  if (childPart.kind === "text") {
    try {
      childPart.text = Buffer.from(entryData).toString("utf8");
    } catch {
      // Binary file that isn't an image; leave data only
    }
  }

  childResource.parts.push(childPart);
  return childResource;
}
