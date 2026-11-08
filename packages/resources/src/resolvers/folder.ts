/**
 * Folders as resources. A folder resolves to a `folder` resource whose raw form is its listing (json, see
 * {@link folderListingSchema}): its entries, folders first then by name, each with its location, kind, detected type,
 * size and modified time. The folder parser links every entry, so a resource graph walks a whole tree.
 */
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FolderOptions, ResolverContext, ResourceResolver } from "../types";
import { assertNotAborted } from "../utils";
import type { FolderEntry, FolderListing } from "../versions";
import { fileResolver, resolveFilePath } from "./file";

/** The resource type of a folder. */
export const FOLDER_TYPE = "folder";

/** The mime type of a folder's raw form. */
export const FOLDER_MIME_TYPE = "inode/directory";

/** Entry names a folder listing leaves out unless told otherwise. */
export const DEFAULT_FOLDER_IGNORE: readonly string[] = [".git", "node_modules"];

/** The most entries a folder listing holds unless told otherwise. */
export const DEFAULT_FOLDER_MAX_ENTRIES = 1000;

/** The folder a link names, or undefined when it names no existing folder (or is a script import, which names a file). */
async function folderPath(link: string, context: ResolverContext): Promise<string | undefined> {
  if (!(await fileResolver.canResolve(link, context))) return undefined;
  const resolved = await resolveFilePath(link, context);
  if (resolved === undefined) return undefined;
  const stats = await stat(resolved).catch(() => undefined);
  return stats?.isDirectory() ? resolved : undefined;
}

/** Lists a folder: hidden and ignored entries left out, folders first then by name, cut at the limit. */
export async function listFolder(folder: string, context: ResolverContext): Promise<FolderListing> {
  const options: FolderOptions = context.options.folder ?? {};
  const ignore = new Set(options.ignore ?? DEFAULT_FOLDER_IGNORE);
  const maxEntries = options.maxEntries ?? DEFAULT_FOLDER_MAX_ENTRIES;
  const dirents = (await readdir(folder, { withFileTypes: true }))
    .filter((dirent) => (options.includeHidden || !dirent.name.startsWith(".")) && !ignore.has(dirent.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  const entries: FolderEntry[] = [];
  for (const dirent of dirents.slice(0, maxEntries)) {
    assertNotAborted(context.options.signal);
    const location = path.join(folder, dirent.name);
    const kind = dirent.isDirectory() ? "folder" : dirent.isFile() ? "file" : dirent.isSymbolicLink() ? "link" : "other";
    // A link reports what it points at; a broken one only itself.
    const stats = await (kind === "link" ? stat(location).catch(() => lstat(location)) : stat(location)).catch(() => undefined);
    const isFolder = kind === "folder" || (kind === "link" && stats?.isDirectory() === true);
    const type = isFolder ? FOLDER_TYPE : context.registry.inferType(location);
    entries.push({
      name: dirent.name,
      location,
      kind,
      ...(type !== undefined ? { type } : {}),
      ...(stats && !isFolder ? { size: stats.size } : {}),
      ...(stats ? { modifiedAt: stats.mtimeMs } : {}),
    });
  }
  return { entries, truncated: dirents.length > maxEntries, total: dirents.length };
}

/**
 * Resolves links that name an existing folder (absolute paths, `file://` URLs, and relative links against a local
 * base). Register it ahead of the file resolver, which would otherwise take folders as files.
 */
export const folderResolver: ResourceResolver = {
  id: "folder",
  async canResolve(link, context) {
    return (await folderPath(link, context)) !== undefined;
  },
  async resolve(link, context) {
    assertNotAborted(context.options.signal);
    const folder = await folderPath(link, context);
    if (folder === undefined) return undefined;
    const [listing, stats] = await Promise.all([listFolder(folder, context), stat(folder)]);
    return {
      location: folder,
      input: JSON.stringify(listing),
      type: FOLDER_TYPE,
      mimeType: FOLDER_MIME_TYPE,
      name: path.basename(folder) || folder,
      modifiedAt: stats.mtimeMs,
    };
  },
  async stat(link, context) {
    assertNotAborted(context.options.signal);
    const folder = await folderPath(link, context);
    if (folder === undefined) return undefined;
    const stats = await stat(folder);
    return { location: folder, type: FOLDER_TYPE, mimeType: FOLDER_MIME_TYPE, modifiedAt: stats.mtimeMs };
  },
};
