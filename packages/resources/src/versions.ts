/**
 * Converted versions of resources: the LLM-ready form a converter makes from a resource's raw bytes (clean markdown
 * from html, structured tables from a spreadsheet, page text from a pdf, a pretty form of json or yaml, a listing of a
 * folder). Each shape is a zod schema with its type derived from it, so a stored or transmitted version can be
 * checked. Anything that can be worked out from a version (its text, its mime type, typed table cells) is a function
 * here rather than a stored field. This module imports only zod, so it is safe to use in a browser.
 */
import { z } from "zod";

/** Separates pages in the text of a `pages` version (a form feed, as `pdftotext` writes). */
export const PAGE_BREAK = "\f";

/** A table of string cells: one header row and its data rows, from a sheet, a csv file or an html table. */
export const tableSchema = z.object({
  /** The table's name (a sheet's name, a file's name, or `Sheet - Table 2` for a second table on a sheet). */
  name: z.string().optional(),
  /** The sheet the table is on, for workbooks. */
  sheetName: z.string().optional(),
  /** The 0-based index of the sheet the table is on, for workbooks. */
  sheetIndex: z.number().int().nonnegative().optional(),
  /** Column headers. */
  headers: z.array(z.string()),
  /** Data rows; a row may be shorter than the headers (missing cells are empty). */
  rows: z.array(z.array(z.string())),
});

/** A table of string cells. */
export type Table = z.infer<typeof tableSchema>;

/** What kind of value a table column holds, worked out from its cells by {@link columnKinds}. */
export const columnKindSchema = z.enum(["empty", "boolean", "integer", "number", "date", "text"]);

/** What kind of value a table column holds. */
export type ColumnKind = z.infer<typeof columnKindSchema>;

/** What kind an entry in a folder is. */
export const folderEntryKindSchema = z.enum(["file", "folder", "link", "other"]);

/** What kind an entry in a folder is. */
export type FolderEntryKind = z.infer<typeof folderEntryKindSchema>;

/** One entry in a folder listing. */
export const folderEntrySchema = z.object({
  /** The entry's name within the folder. */
  name: z.string(),
  /** The entry's absolute location (a file path). */
  location: z.string(),
  kind: folderEntryKindSchema,
  /** The resource type the entry is detected as (`folder` for folders), when known. */
  type: z.string().optional(),
  /** Size in bytes, for files. */
  size: z.number().nonnegative().optional(),
  /** Last modified time in epoch milliseconds. */
  modifiedAt: z.number().optional(),
});

/** One entry in a folder listing. */
export type FolderEntry = z.infer<typeof folderEntrySchema>;

/** The raw form of a `folder` resource: its entries, folders first then by name. */
export const folderListingSchema = z.object({
  entries: z.array(folderEntrySchema),
  /** True when entries were left out because the folder holds more than the limit. */
  truncated: z.boolean(),
  /** How many entries the folder holds in all (after hidden and ignored entries are left out). */
  total: z.number().int().nonnegative(),
});

/** The raw form of a `folder` resource. */
export type FolderListing = z.infer<typeof folderListingSchema>;

/** Fields every version has. */
const versionBase = {
  /** The id of the converter that made the version. */
  converter: z.string(),
  /** The resource type the version was converted from. */
  from: z.string(),
  /** The resource's title, when the source names one (an html `<title>`, a pdf's title). */
  title: z.string().optional(),
  /** Facts the converter found along the way (an html page's description and language, a pdf's page count). */
  metadata: z.record(z.string(), z.unknown()).optional(),
};

/** Markdown: html pages, word documents and folder listings convert to this. */
export const markdownVersionSchema = z.object({ kind: z.literal("markdown"), ...versionBase, text: z.string() });

/** Plain text. */
export const textVersionSchema = z.object({ kind: z.literal("text"), ...versionBase, text: z.string() });

/** Code in a language, pretty printed: json and yaml convert to this. */
export const codeVersionSchema = z.object({
  kind: z.literal("code"),
  ...versionBase,
  /** The language of the text (`json`, `yaml`). */
  language: z.string(),
  text: z.string(),
});

/** Text page by page: pdfs convert to this. Its text is the pages joined by {@link PAGE_BREAK}. */
export const pagesVersionSchema = z.object({ kind: z.literal("pages"), ...versionBase, pages: z.array(z.string()) });

/** Tables: spreadsheets, csv and tsv convert to this. Its text is the tables as markdown. */
export const tableVersionSchema = z.object({ kind: z.literal("table"), ...versionBase, tables: z.array(tableSchema) });

/** A converted version of a resource, by kind. */
export const resourceVersionSchema = z.discriminatedUnion("kind", [
  markdownVersionSchema,
  textVersionSchema,
  codeVersionSchema,
  pagesVersionSchema,
  tableVersionSchema,
]);

/** A converted version of a resource. */
export type ResourceVersion = z.infer<typeof resourceVersionSchema>;

/** The kinds of version. */
export type ResourceVersionKind = ResourceVersion["kind"];

/** The version of a kind. */
export type ResourceVersionOf<K extends ResourceVersionKind> = Extract<ResourceVersion, { kind: K }>;

/** The kinds of version, in a fixed order. */
export const RESOURCE_VERSION_KINDS = resourceVersionSchema.options.map((option) => option.shape.kind.value);

/** Escapes a table cell for a markdown table: pipes are escaped and line breaks become spaces. */
function markdownCell(cell: string): string {
  return cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * A table as a GitHub markdown table. Blank headers become a single space, since a markdown table needs a header
 * row; rows are padded or cut to the header's width.
 */
export function tableToMarkdown(table: Table): string {
  const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
  const headers = Array.from({ length: width }, (_, i) => markdownCell(table.headers[i] ?? "") || " ");
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of table.rows) {
    lines.push(`| ${headers.map((_, i) => markdownCell(row[i] ?? "")).join(" | ")} |`);
  }
  return lines.join("\n");
}

/** The heading a table gets in a table version's text, when it has a name. */
export function tableHeading(table: Table): string | undefined {
  return table.name ? `## ${table.name}` : undefined;
}

/** A table as it appears in a table version's text: its heading (when named) and its markdown table. */
export function tableBlock(table: Table): string {
  const heading = tableHeading(table);
  return heading ? `${heading}\n\n${tableToMarkdown(table)}` : tableToMarkdown(table);
}

/** Separates blocks (tables, sections) in a version's text. */
export const BLOCK_SEPARATOR = "\n\n";

/** The LLM-ready text of a version: its text, its pages joined by {@link PAGE_BREAK}, or its tables as markdown. */
export function versionText(version: ResourceVersion): string {
  switch (version.kind) {
    case "markdown":
    case "text":
    case "code":
      return version.text;
    case "pages":
      return version.pages.join(PAGE_BREAK);
    case "table":
      return version.tables.map(tableBlock).join(BLOCK_SEPARATOR);
  }
}

/** Mime types of code languages a version may be in; others are `text/plain`. */
const CODE_MIME_TYPES: Readonly<Record<string, string>> = {
  json: "application/json",
  yaml: "application/yaml",
  xml: "application/xml",
};

/** The mime type of a version's text ({@link versionText}). */
export function versionMimeType(version: ResourceVersion): string {
  switch (version.kind) {
    case "markdown":
    case "table":
      return "text/markdown";
    case "code":
      return CODE_MIME_TYPES[version.language] ?? "text/plain";
    case "text":
    case "pages":
      return "text/plain";
  }
}

const BOOLEAN_CELL = /^(?:true|false|yes|no)$/i;
const INTEGER_CELL = /^[-+]?\d{1,15}$/;
const NUMBER_CELL = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[-+]?\d+)?%?$/i;
const DATE_CELL = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[-+]\d{2}:?\d{2})?)?$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

/** The kind of one non-empty cell. */
function cellKind(cell: string): Exclude<ColumnKind, "empty"> {
  if (BOOLEAN_CELL.test(cell)) return "boolean";
  if (INTEGER_CELL.test(cell)) return "integer";
  if (/\d/.test(cell) && NUMBER_CELL.test(cell)) return "number";
  if (DATE_CELL.test(cell) && !Number.isNaN(Date.parse(cell))) return "date";
  return "text";
}

/** How kinds widen when a column holds more than one: integers widen to numbers, anything else mixed is text. */
function widen(a: ColumnKind, b: Exclude<ColumnKind, "empty">): Exclude<ColumnKind, "empty"> {
  if (a === "empty" || a === b) return b;
  if ((a === "integer" && b === "number") || (a === "number" && b === "integer")) return "number";
  return "text";
}

/** The kind of value each column of a table holds, from its non-empty cells (`empty` when it has none). */
export function columnKinds(table: Table): ColumnKind[] {
  const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
  return Array.from({ length: width }, (_, column) => {
    let kind: ColumnKind = "empty";
    for (const row of table.rows) {
      const cell = (row[column] ?? "").trim();
      if (cell !== "") kind = widen(kind, cellKind(cell));
    }
    return kind;
  });
}

/** A typed table cell. */
export type CellValue = string | number | boolean | null;

/** A cell as a value of its column's kind: numbers and booleans parsed, empty cells null, the rest strings. */
function cellValue(cell: string, kind: ColumnKind): CellValue {
  const trimmed = cell.trim();
  if (trimmed === "") return null;
  switch (kind) {
    case "boolean":
      return /^(?:true|yes)$/i.test(trimmed);
    case "integer":
    case "number": {
      const percent = trimmed.endsWith("%");
      const value = Number(trimmed.replace(/[,%]/g, ""));
      return percent ? value / 100 : value;
    }
    default:
      return cell;
  }
}

/**
 * A table's rows as records keyed by header, with each cell typed by its column's kind ({@link columnKinds}).
 * Blank or repeated headers get a column name (`column 3`, `name 2`) so no cell is lost.
 */
export function tableRecords(table: Table): Record<string, CellValue>[] {
  const kinds = columnKinds(table);
  const seen = new Map<string, number>();
  const keys = kinds.map((_, i) => {
    const base = table.headers[i]?.trim() || `column ${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} ${count}`;
  });
  return table.rows.map((row) => Object.fromEntries(keys.map((key, i) => [key, cellValue(row[i] ?? "", kinds[i] ?? "text")])));
}
