import { createParsedResource } from "../registry";
import type { ResourceParser, ResourcePart, SupportContext } from "../types";
import {
  assertNotAborted,
  collectInput,
  createPartId,
  dedupeLinks,
  extractLinksFromText,
} from "../utils";

let pdfParse: ((buffer: Buffer) => Promise<{ text: string; numpages: number }>) | undefined;

async function loadPdfParse(): Promise<typeof pdfParse> {
  if (pdfParse) return pdfParse;
  try {
    const mod = await import("pdf-parse");
    pdfParse = mod.default ?? mod;
    return pdfParse;
  } catch {
    return undefined;
  }
}

export const pdfParser: ResourceParser = {
  id: "pdf-parser",
  supportedTypes: ["pdf"],
  defaultSlicer: "text",
  async isSupported(_type: string, _context: SupportContext) {
    return Boolean(await loadPdfParse());
  },
  async parse(source, context) {
    assertNotAborted(context.options.signal);
    const parse = await loadPdfParse();
    if (!parse) {
      throw new Error("pdf-parse is not installed. Install it to parse PDF resources: npm install pdf-parse");
    }

    const data = await collectInput(source.input);
    const { Buffer: NodeBuffer } = await import("node:buffer");
    const result = await parse(NodeBuffer.from(data));
    const resource = createParsedResource(source);
    resource.defaultSlicer = "text";

    const part: ResourcePart = {
      id: createPartId(resource, 0),
      location: `${resource.location}#part/0`,
      kind: "text",
      text: result.text,
      metadata: { pages: result.numpages },
      links: dedupeLinks([
        ...extractLinksFromText(result.text, `${resource.location}#part/0`)
      ])
    };
    resource.parts.push(part);
    resource.links = part.links ?? [];
    return resource;
  }
};
