/**
 * Sections of converted versions. A version's sections cover its text ({@link versionText}) in order, and each is
 * keyed by structure, never position ({@link sectionKeys}): a markdown version by heading path, a table version by
 * sheet and table name, a pages version by page number, a code version by top-level key, a text version whole.
 */
import { sectionKeys } from "./section-keys";
import { splitMarkdownSections } from "./slicers/markdown";
import { BLOCK_SEPARATOR, PAGE_BREAK, type ResourceVersion, tableBlock, versionText } from "./versions";

/** A section of a version: a span of its text with a key that comes from structure. */
export interface VersionSection {
  /** Stable within the version: the path joined, with ` ~2` for a repeat. */
  key: string;
  /** Where the section sits in the version's outline (heading path, `[sheet, table]`, `[Page 3]`, `[key]`). */
  path: string[];
  /** A short title for the section. */
  title: string;
  /** Start offset in the version's text. */
  start: number;
  /** End offset (exclusive) in the version's text. */
  end: number;
}

/** Cuts the versions it supports into sections. */
export interface VersionSectioner {
  readonly id: string;
  supports(version: ResourceVersion): boolean;
  sections(version: ResourceVersion): VersionSection[];
}

/** A span with its outline path, before keys are made. */
interface Piece {
  readonly path: readonly string[];
  readonly title: string;
  readonly start: number;
  readonly end: number;
}

/** Keys pieces from their paths, in order. */
function keyed(pieces: readonly Piece[]): VersionSection[] {
  const keys = sectionKeys(pieces.map((piece) => piece.path));
  return pieces.map((piece, i) => ({ key: keys[i] ?? "", path: [...piece.path], title: piece.title, start: piece.start, end: piece.end }));
}

/** One section holding all of a version's text. */
function whole(version: ResourceVersion): VersionSection[] {
  return keyed([{ path: [], title: version.title ?? "", start: 0, end: versionText(version).length }]);
}

/** Markdown versions by heading path. */
export const markdownSectioner: VersionSectioner = {
  id: "markdown-headings",
  supports: (version) => version.kind === "markdown",
  sections(version) {
    const text = versionText(version);
    return keyed(splitMarkdownSections(text).map((section) => ({
      path: section.headings,
      title: section.headings.at(-1) ?? version.title ?? "",
      start: section.start,
      end: section.end,
    })));
  },
};

/** Pages versions page by page (`Page 1`, `Page 2`, …); the page break after a page belongs to it. */
export const pagesSectioner: VersionSectioner = {
  id: "pages",
  supports: (version) => version.kind === "pages",
  sections(version) {
    if (version.kind !== "pages") return [];
    const pieces: Piece[] = [];
    let start = 0;
    version.pages.forEach((page, i) => {
      const end = start + page.length + (i < version.pages.length - 1 ? PAGE_BREAK.length : 0);
      pieces.push({ path: [`Page ${i + 1}`], title: `Page ${i + 1}`, start, end });
      start = end;
    });
    return pieces.length === 0 ? whole(version) : keyed(pieces);
  },
};

/** Table versions table by table, keyed by sheet and table name (`Sales > Sales - Table 2`), else `Table 1`. */
export const tableSectioner: VersionSectioner = {
  id: "tables",
  supports: (version) => version.kind === "table",
  sections(version) {
    if (version.kind !== "table") return [];
    const pieces: Piece[] = [];
    let start = 0;
    version.tables.forEach((table, i) => {
      const end = start + tableBlock(table).length + (i < version.tables.length - 1 ? BLOCK_SEPARATOR.length : 0);
      const name = table.name ?? `Table ${i + 1}`;
      const path = table.sheetName !== undefined && table.sheetName !== name ? [table.sheetName, name] : [name];
      pieces.push({ path, title: name, start, end });
      start = end;
    });
    return pieces.length === 0 ? whole(version) : keyed(pieces);
  },
};

/** Lines that start a top-level key: a json object's (two-space indent, as pretty printed) and a yaml mapping's. */
const TOP_LEVEL_KEY: Readonly<Record<string, RegExp>> = {
  json: /^ {2}"((?:[^"\\]|\\.)*)"\s*:/,
  yaml: /^("[^"]*"|'[^']*'|[^\s#\-?:"'][^:#]*?)\s*:(?:\s|$)/,
};

/**
 * Code versions by top-level key, for json and yaml: each key's section runs to the next key, the text before the
 * first key joins the first section and the text after the last joins the last. Other code, and code with no
 * top-level keys (a json array), is one section.
 */
export const codeKeySectioner: VersionSectioner = {
  id: "code-keys",
  supports: (version) => version.kind === "code",
  sections(version) {
    if (version.kind !== "code") return [];
    const pattern = TOP_LEVEL_KEY[version.language];
    if (!pattern) return whole(version);
    const starts: Array<{ key: string; offset: number }> = [];
    let offset = 0;
    for (const line of version.text.split(/(?<=\n)/)) {
      const match = pattern.exec(line.replace(/\r?\n$/, ""));
      const key = match?.[1]?.replace(/^["']|["']$/g, "");
      if (key !== undefined) starts.push({ key, offset });
      offset += line.length;
    }
    if (starts.length === 0) return whole(version);
    return keyed(starts.map((entry, i) => ({
      path: [entry.key],
      title: entry.key,
      start: i === 0 ? 0 : entry.offset,
      end: starts[i + 1]?.offset ?? version.text.length,
    })));
  },
};

/** Text versions whole. */
export const wholeSectioner: VersionSectioner = {
  id: "whole",
  supports: () => true,
  sections: whole,
};

/** The sectioners every registry starts with, most specific first; {@link wholeSectioner} catches the rest. */
export const DEFAULT_VERSION_SECTIONERS: readonly VersionSectioner[] = [markdownSectioner, pagesSectioner, tableSectioner, codeKeySectioner, wholeSectioner];

/** Sections of a version by the default sectioners; a registry's `sectionVersion` also uses sectioners added to it. */
export function sectionVersion(version: ResourceVersion): VersionSection[] {
  return DEFAULT_VERSION_SECTIONERS.find((sectioner) => sectioner.supports(version))?.sections(version) ?? [];
}
