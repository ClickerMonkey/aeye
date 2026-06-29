import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";

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

/**
 * Loads (and caches) a zip archive from disk. The cache is keyed by absolute path and invalidated by
 * the file's modified time, so repeatedly resolving entries within one archive (e.g. while walking a
 * resource graph of cross-referencing entries) does not re-read or re-parse it.
 */
export async function getCachedZip(zipPath: string): Promise<LoadedZip | undefined> {
  const JSZip = await loadJSZip();
  if (!JSZip) return undefined;

  const stats = await stat(zipPath).catch(() => undefined);
  const mtimeMs = stats?.mtimeMs ?? 0;

  const cached = zipCache.get(zipPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    // Refresh recency for the simple LRU eviction below.
    zipCache.delete(zipPath);
    zipCache.set(zipPath, cached);
    return cached.zip;
  }

  const buffer = await readFile(zipPath);
  const zip = await JSZip.loadAsync(buffer);
  zipCache.set(zipPath, { mtimeMs, zip });
  if (zipCache.size > MAX_CACHED_ZIPS) {
    const oldest = zipCache.keys().next().value;
    if (oldest !== undefined) {
      zipCache.delete(oldest);
    }
  }
  return zip;
}
