import { readFile } from "node:fs/promises";
import { createParsedResource } from "../registry";
import type { ParsedResource, ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  createPartId,
  createResourceId,
  dedupeLinks,
  inferTypeFromLocation,
  toFilePath,
} from "../utils";

/** Zip bomb protection limits. */
const ZIP_LIMITS = {
  MAX_FILES: 1000,
  MAX_TOTAL_SIZE: 100 * 1024 * 1024, // 100MB total uncompressed
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB per file
};

let jszip: { loadAsync(data: Uint8Array | Buffer): Promise<{ files: Record<string, { name: string; dir: boolean; async(type: "uint8array"): Promise<Uint8Array> }> }> } | undefined;

async function loadJSZip(): Promise<typeof jszip> {
  if (jszip) return jszip;
  try {
    const mod = await import("jszip");
    jszip = mod.default ?? mod;
    return jszip;
  } catch {
    return undefined;
  }
}

export const zipParser: ResourceParser = {
  id: "zip-parser",
  supportedTypes: ["zip"],
  defaultSlicer: "text",
  async isSupported(_type: string, _context: SupportContext) {
    return Boolean(await loadJSZip());
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const JSZip = await loadJSZip();
    if (!JSZip) {
      throw new Error("jszip is not installed. Install it to parse ZIP resources: npm install jszip");
    }

    // Read from file system to avoid holding the entire zip in JS heap
    const filePath = toFilePath(source.location);
    const zipBuffer = await readFile(filePath);
    const zip = await JSZip.loadAsync(zipBuffer);

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
      const childLocation = `${source.location}#entry/${entry.name}`;
      const entryType = inferTypeFromLocation(entry.name);

      const childResource: ParsedResource = {
        id: createResourceId(childLocation, entryType ?? "unknown"),
        location: childLocation,
        type: entryType ?? "unknown",
        name: entry.name,
        metadata: { size: uncompressedSize },
        defaultSlicer: "text",
        parts: [],
        links: [],
        parentLocation: source.location,
      };

      const childPart: ResourcePart = {
        id: createPartId(childResource, 0),
        location: `${childLocation}#part/0`,
        kind: entryType === "image" ? "image" : "text",
        data: entryData,
        mimeType: entryType === "image" ? `image/${getImageExtension(entry.name)}` : undefined,
      };

      // For text-like files, decode the content
      if (childPart.kind === "text") {
        try {
          const { Buffer: NodeBuffer } = await import("node:buffer");
          childPart.text = NodeBuffer.from(entryData).toString("utf8");
        } catch {
          // Binary file that isn't an image; leave data only
        }
      }

      childResource.parts.push(childPart);
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

const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  bmp: "bmp",
  ico: "x-icon",
  avif: "avif",
  tif: "tiff",
  tiff: "tiff",
  svg: "svg+xml",
};

function getImageExtension(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "png";
  return IMAGE_EXT_TO_MIME[ext] ?? "png";
}
