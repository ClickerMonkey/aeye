import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { createParsedResource } from "../registry";
import type { ExtractedTable, ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
  toFilePath,
} from "../utils";

let xlsxModule: any;

async function loadXlsx(): Promise<any> {
  if (xlsxModule) return xlsxModule;
  try {
    xlsxModule = await import("xlsx");
    return xlsxModule;
  } catch {
    return undefined;
  }
}

/**
 * Detects separate table regions within a sheet's row data.
 * A table region is delimited by one or more fully empty rows.
 * The first non-empty row of each region is treated as headers.
 */
function extractTablesFromRows(rows: string[][], sheetName: string, sheetIndex: number): ExtractedTable[] {
  const tables: ExtractedTable[] = [];
  let regionStart = -1;

  for (let i = 0; i <= rows.length; i++) {
    const isEmpty = i === rows.length || rows[i].every((cell) => cell === "");

    if (isEmpty) {
      if (regionStart !== -1) {
        const regionRows = rows.slice(regionStart, i);
        if (regionRows.length >= 1) {
          const headers = regionRows[0];
          const dataRows = regionRows.slice(1);
          tables.push({
            name: tables.length === 0 ? sheetName : `${sheetName} - Table ${tables.length + 1}`,
            headers,
            rows: dataRows,
            sheetName,
            sheetIndex,
          });
        }
        regionStart = -1;
      }
    } else if (regionStart === -1) {
      regionStart = i;
    }
  }

  return tables;
}

/** Renders a table into a markdown table string. */
function tableToMarkdown(table: ExtractedTable): string {
  const lines: string[] = [];
  const headers = table.headers.map((h) => h || " ");
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of table.rows) {
    const cells = headers.map((_, ci) => (row[ci] ?? "").replace(/\|/g, "\\|"));
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

/**
 * Higher-priority spreadsheet parser that converts to PDF and delegates to the PDF parser stack when
 * PDF rendering is enabled. Declines (falls back to {@link excelParser}) when conversion/rendering is
 * not configured or conversion fails.
 */
export const excelPdfParser: ResourceParser = {
  id: "excel-pdf-parser",
  supportedTypes: ["excel", "csv", "tsv"],
  defaultSlicer: "text",
  priority: 10,
  async isSupported(_type: string, context: SupportContext) {
    const config = context.registry.getTypeConfig?.(_type);
    return Boolean(config?.convertToPdf && config?.pdf?.renderPages);
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);

    // Only convert when both conversion and PDF rendering are enabled; otherwise decline.
    if (!context.options.convertToPdf || !context.options.pdf?.renderPages) {
      return undefined;
    }

    const sourceFilePath = toFilePath(source.location);
    const pdfPath = await context.options.convertToPdf(sourceFilePath, context.options.signal);
    const pdfSource = {
      ...source,
      location: pdfPath,
      type: "pdf" as const,
      mimeType: "application/pdf",
      input: (() => createReadStream(pdfPath) as unknown as AsyncIterable<Uint8Array>)(),
      metadata: { ...source.metadata, convertedFrom: source.location },
    };
    // Delegate through the registry so the full PDF parser stack (render + text) applies.
    const result = await context.registry.parseSource(pdfSource, context.options);
    result.location = source.location;
    result.name = source.name ?? result.name;
    result.metadata = { ...result.metadata, convertedFrom: source.type, pdfPath };
    return result;
  }
};

export const excelParser: ResourceParser = {
  id: "excel-parser",
  supportedTypes: ["excel", "csv", "tsv"],
  defaultSlicer: "text",
  async isSupported(_type: string, _context: SupportContext) {
    return Boolean(await loadXlsx());
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);

    const XLSX = await loadXlsx();
    if (!XLSX) {
      throw new Error("xlsx is not installed. Install it to parse Excel/CSV resources: npm install xlsx");
    }

    const data = await collectInput(source.input);
    const workbook = XLSX.read(Buffer.from(data), { type: "buffer" });
    const resource = createParsedResource(source);
    resource.defaultSlicer = "text";

    const allTables: ExtractedTable[] = [];

    for (let i = 0; i < workbook.SheetNames.length; i++) {
      assertNotAborted(context.options.signal);
      const sheetName = workbook.SheetNames[i];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData: string[][] = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: "",
        raw: false
      });

      const rows = jsonData.filter((row) => row.some((cell) => cell !== ""));
      if (rows.length === 0) continue;

      // Extract structured tables from this sheet
      const tables = extractTablesFromRows(jsonData, sheetName, i);
      allTables.push(...tables);

      // Render tables as markdown for the text part
      const text = tables.length > 0
        ? tables.map((t) => tableToMarkdown(t)).join("\n\n")
        : rows.map((row) => row.join("\t")).join("\n");

      const part: ResourcePart = {
        id: createPartId(resource, resource.parts.length),
        location: `${resource.location}#sheet/${i}`,
        kind: "text",
        text,
        metadata: {
          sheetName,
          sheetIndex: i,
          tables: tables.map((t) => ({ name: t.name, headers: t.headers, rowCount: t.rows.length })),
        },
        links: dedupeLinks([
          ...extractLinksFromText(text, `${resource.location}#sheet/${i}`)
        ])
      };
      resource.parts.push(part);
    }

    resource.metadata = {
      ...resource.metadata,
      structuredTables: allTables,
    };
    resource.links = dedupeLinks(resource.parts.flatMap((part) => part.links ?? []));
    return resource;
  }
};
