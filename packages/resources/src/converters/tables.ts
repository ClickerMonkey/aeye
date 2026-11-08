/** Converters to tables: csv and tsv (read here, no dependency) and workbooks (through xlsx, an optional peer). */
import { Buffer } from "node:buffer";
import { missingDependency, optionalModule } from "../optional";
import { detectDelimiter, parseDelimited, tablesFromRows } from "../tables";
import type { ResourceConverter } from "../types";
import { assertNotAborted, basenameFromLocation, collectInput } from "../utils";
import type { ResourceVersionOf, Table } from "../versions";

/** Loads xlsx (an optional peer dependency) for workbooks. */
const loadXlsx = optionalModule(async (): Promise<typeof import("xlsx")> => import("xlsx"));

/** A table version of tables. */
function tableVersion(converter: string, from: string, tables: Table[], metadata?: Record<string, unknown>): ResourceVersionOf<"table"> {
  return { kind: "table", converter, from, tables, ...(metadata ? { metadata } : {}) };
}

/** A cell from a sheet as text. */
function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return typeof cell === "string" ? cell : String(cell);
}

/**
 * Csv and tsv files to tables. Tsv splits on tabs; csv on the delimiter its first lines use most consistently (`,`
 * `;` tab or `|`). Blank rows separate tables; each table's first row is its headers. The table is named after the file.
 */
export const delimitedConverter: ResourceConverter = {
  id: "delimited-tables",
  supportedTypes: ["csv", "tsv"],
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const text = Buffer.from(await collectInput(source.input)).toString("utf8");
    const delimiter = source.type === "tsv" ? "\t" : detectDelimiter(text);
    const name = source.name ?? basenameFromLocation(source.location);
    const tables = tablesFromRows(parseDelimited(text, delimiter), { name });
    return tableVersion("delimited-tables", source.type ?? "csv", tables, { delimiter });
  },
};

/**
 * Workbooks (xlsx, xls, ods) to tables, sheet by sheet, with each cell as the workbook shows it (formatted). Blank rows
 * separate tables on a sheet; the first table is named after the sheet.
 */
export const workbookConverter: ResourceConverter = {
  id: "workbook-tables",
  supportedTypes: ["excel"],
  async isSupported() {
    return (await loadXlsx()) !== undefined;
  },
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const XLSX = await loadXlsx();
    if (!XLSX) throw missingDependency("xlsx", "Excel");
    const workbook = XLSX.read(Buffer.from(await collectInput(source.input)), { type: "buffer" });
    const tables: Table[] = [];
    workbook.SheetNames.forEach((sheetName, index) => {
      assertNotAborted(context.options.signal);
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return;
      // With `header: 1` each row is an array of cells.
      const rows = XLSX.utils.sheet_to_json<unknown>(sheet, { header: 1, defval: "", raw: false, blankrows: true });
      const cells = rows.map((row) => (Array.isArray(row) ? row.map(cellText) : []));
      tables.push(...tablesFromRows(cells, { name: sheetName, index }));
    });
    return tableVersion("workbook-tables", "excel", tables, { sheets: workbook.SheetNames });
  },
};
