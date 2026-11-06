import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Zip bomb protection limits, shared by the zip parser and zip resolver. */
export const ZIP_LIMITS = {
  MAX_FILES: 1000,
  MAX_TOTAL_SIZE: 100 * 1024 * 1024, // 100MB total uncompressed
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB per file
};

export interface ZipEntry {
  name: string;
  dir: boolean;
  date?: Date;
  async(type: "uint8array"): Promise<Uint8Array>;
}

export interface LoadedZip {
  files: Record<string, ZipEntry>;
}

interface JSZipModule {
  loadAsync(data: Uint8Array | Buffer): Promise<LoadedZip>;
}

let jszip: JSZipModule | undefined;

export async function loadJSZip(): Promise<JSZipModule | undefined> {
  if (jszip) return jszip;
  try {
    const mod = await import("jszip");
    jszip = (mod.default ?? mod) as unknown as JSZipModule;
    return jszip;
  } catch {
    return undefined;
  }
}

interface CacheEntry {
  mtimeMs: number;
  zip: LoadedZip;
}

const MAX_CACHED_ZIPS = 8;
const zipCache = new Map<string, CacheEntry>();

function remember(key: string, entry: CacheEntry): void {
  zipCache.delete(key);
  zipCache.set(key, entry);
  if (zipCache.size > MAX_CACHED_ZIPS) {
    const oldest = zipCache.keys().next().value;
    if (oldest !== undefined) {
      zipCache.delete(oldest);
    }
  }
}

/**
 * Loads (and caches) a zip archive. The cache is keyed by location, so repeatedly resolving entries
 * within one archive (e.g. while walking a resource graph of cross-referencing entries) does not
 * re-read or re-parse it.
 *
 * - With `data`, the archive is loaded from those bytes (a zip fetched from a URL, nested in another
 *   zip, or held in memory) and cached under `location`.
 * - Without `data`, a local file path is read from disk (cache invalidated by its modified time);
 *   any other location is served only from the cache.
 */
export async function getCachedZip(location: string, data?: Uint8Array, modifiedAt?: number): Promise<LoadedZip | undefined> {
  const JSZip = await loadJSZip();
  if (!JSZip) return undefined;

  const cached = zipCache.get(location);

  if (data) {
    if (cached && modifiedAt !== undefined && cached.mtimeMs === modifiedAt) {
      remember(location, cached);
      return cached.zip;
    }
    const zip = await JSZip.loadAsync(data);
    remember(location, { mtimeMs: modifiedAt ?? Number.NaN, zip });
    return zip;
  }

  if (!path.isAbsolute(location)) {
    if (cached) remember(location, cached);
    return cached?.zip;
  }

  const stats = await stat(location).catch(() => undefined);
  if (!stats) {
    if (cached) remember(location, cached);
    return cached?.zip;
  }
  const mtimeMs = stats.mtimeMs;
  if (cached && cached.mtimeMs === mtimeMs) {
    remember(location, cached);
    return cached.zip;
  }

  const zip = await JSZip.loadAsync(await readFile(location));
  remember(location, { mtimeMs, zip });
  return zip;
}
