import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
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

export const excelParser: ResourceParser = {
  id: "excel-parser",
  supportedTypes: ["excel"],
  defaultSlicer: "text",
  async isSupported(_type: string, _context: SupportContext) {
    return Boolean(await loadXlsx());
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const XLSX = await loadXlsx();
    if (!XLSX) {
      throw new Error("xlsx is not installed. Install it to parse Excel resources: npm install xlsx");
    }

    const data = await collectInput(source.input);
    const { Buffer: NodeBuffer } = await import("node:buffer");
    const workbook = XLSX.read(NodeBuffer.from(data), { type: "buffer" });
    const resource = createParsedResource(source);
    resource.defaultSlicer = "text";

    for (let i = 0; i < workbook.SheetNames.length; i++) {
      const sheetName = workbook.SheetNames[i];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData: string[][] = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: "",
        raw: false
      });

      const rows = jsonData.filter((row) => row.some((cell) => cell !== ""));
      if (rows.length === 0) continue;

      const text = rows.map((row) => row.join("\t")).join("\n");
      const part: ResourcePart = {
        id: createPartId(resource, resource.parts.length),
        location: `${resource.location}#sheet/${i}`,
        kind: "text",
        text,
        metadata: { sheetName, sheetIndex: i },
        links: dedupeLinks([
          ...extractLinksFromText(text, `${resource.location}#sheet/${i}`)
        ])
      };
      resource.parts.push(part);
    }

    resource.links = dedupeLinks(resource.parts.flatMap((part) => part.links ?? []));
    return resource;
  }
};
