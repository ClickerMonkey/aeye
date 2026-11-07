import path from "node:path";
import { stat } from "node:fs/promises";
import type { ResourceType } from "./types";

/**
 * Node and TypeScript module resolution for relative imports: which files a specifier such as `./store`,
 * `./store.js` or `./lib` may name, and the first of them that exists.
 */

/** Resource types whose relative imports follow node and TypeScript module resolution. */
export const SCRIPT_TYPES = ["javascript", "typescript", "jsx", "tsx"] as const;

/** A resource type whose relative imports follow node and TypeScript module resolution. */
export type ScriptType = (typeof SCRIPT_TYPES)[number];

/** Extensions an import may leave off, in the order TypeScript tries them. */
export const IMPORT_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;

/** What an import's written extension may stand for in TypeScript source (`./a.js` names `a.ts`). */
export const IMPORT_SOURCE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

/** Whether a path names an existing file (not a folder). */
export type IsFile = (filePath: string) => Promise<boolean>;

const SCRIPT_TYPE_SET: ReadonlySet<string> = new Set(SCRIPT_TYPES);

/** Whether a resource type's imports follow node and TypeScript module resolution. */
export function isScriptType(type: ResourceType | undefined): type is ScriptType {
  return type !== undefined && SCRIPT_TYPE_SET.has(type);
}

/** Whether an import specifier names a file (`./a`, `../a`, `/a`, `.`, `..`) rather than a package (`react`, `node:fs`). */
export function isRelativeSpecifier(specifier: string): boolean {
  return /^\.{1,2}(\/|$)/.test(specifier) || specifier.startsWith("/");
}

/**
 * The files an import may mean, most likely first: the path as written, the TypeScript source its extension stands
 * for, the path with each of {@link IMPORT_EXTENSIONS}, then a folder's `index` with each of them.
 */
export function importCandidates(filePath: string): string[] {
  const ext = path.extname(filePath);
  const stem = filePath.slice(0, filePath.length - ext.length);
  const separator = filePath.includes("/") || !filePath.includes("\\") ? "/" : "\\"; // keep the path's own style
  return [
    filePath,
    ...(IMPORT_SOURCE_EXTENSIONS[ext] ?? []).map((source) => `${stem}${source}`),
    ...IMPORT_EXTENSIONS.map((extension) => `${filePath}${extension}`),
    ...IMPORT_EXTENSIONS.map((extension) => `${filePath}${separator}index${extension}`),
  ];
}

/** Whether a path is a file on disk. */
export const diskIsFile: IsFile = async (filePath) => (await stat(filePath).catch(() => undefined))?.isFile() === true;

/** The first of an import's {@link importCandidates} that is a file, or undefined when none is. */
export async function resolveImportPath(filePath: string, isFile: IsFile = diskIsFile): Promise<string | undefined> {
  for (const candidate of importCandidates(filePath)) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
