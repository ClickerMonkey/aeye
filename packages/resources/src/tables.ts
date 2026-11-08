/**
 * Tables from delimited text and from sheets of rows: an RFC 4180 csv reader (quoted fields, doubled quotes, line
 * breaks inside quotes, CRLF, a byte order mark) and the split of a sheet's rows into tables at blank rows.
 */
import type { Table } from "./versions";

/** Delimiters a csv file may use, most likely first. */
const CSV_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * The delimiter a csv file most likely uses: of `,` `;` tab and `|`, the one that splits the first lines into the
 * most consistent, widest rows (outside quotes).
 */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((line) => line.trim() !== "").slice(0, 10);
  let best: { delimiter: string; score: number } = { delimiter: ",", score: 0 };
  for (const delimiter of CSV_DELIMITERS) {
    const counts = sample.map((line) => line.replace(/"[^"]*"/g, "").split(delimiter).length - 1);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((count) => count === first).length;
    const score = consistent * 1000 + first;
    if (score > best.score) best = { delimiter, score };
  }
  return best.delimiter;
}

/** Reads delimited text into rows of fields (RFC 4180). Blank lines are kept as rows with one empty field. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const input = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < input.length) {
    const char = input[i];
    if (quoted) {
      if (char === "\"") {
        if (input[i + 1] === "\"") {
          field += "\"";
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }
    if (char === "\"" && field === "") {
      quoted = true;
      i++;
    } else if (input.startsWith(delimiter, i)) {
      row.push(field);
      field = "";
      i += delimiter.length;
    } else if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += char === "\r" && input[i + 1] === "\n" ? 2 : 1;
    } else {
      field += char;
      i++;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** True for a row with no non-blank cell. */
function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

/**
 * Splits a sheet's rows into tables at runs of blank rows; the first row of each table is its headers. The first
 * table is named after the sheet, later ones `Sheet - Table 2` and so on. Trailing empty cells are trimmed.
 */
export function tablesFromRows(rows: readonly (readonly string[])[], sheet: { name?: string; index?: number } = {}): Table[] {
  const tables: Table[] = [];
  let region: string[][] = [];
  const flush = () => {
    const [headers, ...data] = region;
    region = [];
    if (headers === undefined) return;
    const table: Table = { headers, rows: data };
    const name = sheet.name === undefined ? undefined : tables.length === 0 ? sheet.name : `${sheet.name} - Table ${tables.length + 1}`;
    if (name !== undefined) table.name = name;
    if (sheet.name !== undefined && sheet.index !== undefined) {
      table.sheetName = sheet.name;
      table.sheetIndex = sheet.index;
    }
    tables.push(table);
  };
  for (const row of rows) {
    if (isBlankRow(row)) {
      flush();
      continue;
    }
    let end = row.length;
    while (end > 0 && (row[end - 1] ?? "").trim() === "") end--;
    region.push(row.slice(0, end));
  }
  flush();
  return tables;
}
