/**
 * Stable section keys. A section's key comes from its place in the document's structure (a heading path, a
 * declaration name), never from its position, so the key of a section survives text being added or moved around
 * it. This module has no imports, so it is safe to use in a browser.
 */

/** Joins the segments of a section's path in its key (`Guide > Usage`). */
export const SECTION_PATH_SEPARATOR = " > ";

/** The key of a section whose path is empty: text before the first heading or declaration, or a whole document. */
export const ROOT_SECTION_KEY = "(root)";

/**
 * Keys for sections from their outline paths, in document order. Each key is the path joined with
 * {@link SECTION_PATH_SEPARATOR} ({@link ROOT_SECTION_KEY} for an empty path); a path seen before gets ` ~2`, ` ~3`
 * and so on, so keys are unique within a document while still coming from structure.
 */
export function sectionKeys(paths: readonly (readonly string[])[]): string[] {
  const seen = new Map<string, number>();
  return paths.map((path) => {
    const base = path.join(SECTION_PATH_SEPARATOR) || ROOT_SECTION_KEY;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} ~${count}`;
  });
}
