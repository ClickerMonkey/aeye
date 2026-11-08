/** Folder listings to markdown: one line per entry, folders first, with each entry's type and size. */
import { Buffer } from "node:buffer";
import type { ResourceConverter, ResourceSource } from "../types.js";
import { assertNotAborted, basenameFromLocation, collectInput } from "../utils.js";
import { type FolderEntry, type FolderListing, folderListingSchema } from "../versions.js";

/** A folder listing from the bytes of its raw form (json, checked against {@link folderListingSchema}). */
export function parseFolderListing(raw: Uint8Array): FolderListing {
  return folderListingSchema.parse(JSON.parse(Buffer.from(raw).toString("utf8")));
}

/** A folder's listing from its source. */
export async function readFolderListing(source: ResourceSource): Promise<FolderListing> {
  return parseFolderListing(await collectInput(source.input));
}

/** A byte count for people: `512 B`, `1.2 KB`, `3.4 MB`. */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** One line of a listing: the entry (a folder with a trailing slash), then its type and size. */
function entryLine(entry: FolderEntry): string {
  const label = entry.kind === "folder" || entry.type === "folder" ? `${entry.name}/` : entry.name;
  const facts = [entry.type !== undefined && entry.type !== "folder" ? entry.type : undefined, entry.kind === "link" ? "link" : undefined, entry.size !== undefined ? formatSize(entry.size) : undefined]
    .filter((fact): fact is string => fact !== undefined);
  return `- ${label}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`;
}

/** The markdown of a listing: a heading naming the folder, where it is, its entries, and a note when the list was cut. */
export function folderListingMarkdown(name: string, location: string, listing: FolderListing): string {
  const lines = [`# ${name}`, "", `Folder: ${location}`, ""];
  if (listing.entries.length === 0) {
    lines.push("This folder is empty.");
  } else {
    lines.push(...listing.entries.map(entryLine));
  }
  if (listing.truncated) {
    lines.push("", `Showing ${listing.entries.length} of ${listing.total} entries.`);
  }
  return lines.join("\n");
}

/** Folders to a markdown listing. */
export const folderConverter: ResourceConverter = {
  id: "folder-markdown",
  supportedTypes: ["folder"],
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const listing = await readFolderListing(source);
    const name = source.name ?? basenameFromLocation(source.location);
    return {
      kind: "markdown",
      converter: "folder-markdown",
      from: "folder",
      title: name,
      text: folderListingMarkdown(name, source.location, listing),
      metadata: { entries: listing.entries.length, total: listing.total, truncated: listing.truncated },
    };
  },
};
