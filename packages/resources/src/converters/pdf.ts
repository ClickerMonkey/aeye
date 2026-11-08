/** Pdf to page text, through pdf-parse (an optional peer dependency). Scanned pages without a text layer come out empty. */
import { z } from "zod";
import { missingDependency, optionalModule } from "../optional";
import type { ResourceConverter } from "../types";
import { assertNotAborted, collectInput } from "../utils";

/** What the pdf converter calls pdf-parse with and reads back. */
interface PdfTextExtractor {
  /**
   * pdf-parse types its input as a Buffer, but pdf.js reads any Uint8Array, and must get a plain one starting at
   * offset 0 of its own memory (it misreads Buffers). Declared as a method so pdf-parse's function fits it.
   */
  extract(data: Uint8Array, options: { pagerender: (page: unknown) => Promise<string> }): Promise<{ numpages: number; info: unknown }>;
}

/** Loads pdf-parse (an optional peer dependency) for pdfs. */
const loadPdfParse = optionalModule(async (): Promise<PdfTextExtractor> => ({ extract: (await import("pdf-parse")).default }));

/** A text item of a pdf.js page's text content; marked-content items have no `str` and are skipped. */
const textItemSchema = z.object({ str: z.string(), transform: z.array(z.number()), hasEOL: z.boolean().optional() });

/** A pdf.js page's text content. */
const textContentSchema = z.object({ items: z.array(z.unknown()) });

/** The part of a pdf.js page the converter reads. */
interface PdfPage {
  getTextContent(options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }): Promise<unknown>;
}

function isPdfPage(value: unknown): value is PdfPage {
  return typeof value === "object" && value !== null && "getTextContent" in value && typeof value.getTextContent === "function";
}

/** A pdf.js page's text: items on one baseline joined, a new line where the baseline changes or an item ends a line. */
export async function pdfPageText(page: unknown): Promise<string> {
  if (!isPdfPage(page)) return "";
  const content = textContentSchema.parse(await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }));
  let text = "";
  let lastY: number | undefined;
  let endedLine = false;
  for (const raw of content.items) {
    const item = textItemSchema.safeParse(raw);
    if (!item.success) continue;
    const y = item.data.transform[5];
    if (text !== "" && (endedLine || (y !== undefined && lastY !== undefined && y !== lastY))) text += "\n";
    text += item.data.str;
    lastY = y;
    endedLine = item.data.hasEOL === true;
  }
  return text.replace(/[ \t]+\n/g, "\n").trim();
}

/** Pdfs to text page by page (a `pages` version); the title comes from the document's info when it has one. */
export const pdfConverter: ResourceConverter = {
  id: "pdf-pages",
  supportedTypes: ["pdf"],
  async isSupported() {
    return (await loadPdfParse()) !== undefined;
  },
  async convert(source, context) {
    assertNotAborted(context.options.signal);
    const pdf = await loadPdfParse();
    if (!pdf) throw missingDependency("pdf-parse", "PDF");
    // A plain copy at offset 0 of its own memory, as pdf.js needs.
    const data = new Uint8Array(await collectInput(source.input));
    // pdf-parse renders pages one after another, so they arrive in order.
    const pages: string[] = [];
    const result = await pdf.extract(data, {
      pagerender: async (page: unknown) => {
        const text = await pdfPageText(page);
        pages.push(text);
        return text;
      },
    });
    const info = z.object({ Title: z.string().optional() }).loose().safeParse(result.info);
    const title = info.success ? info.data.Title?.trim() : undefined;
    return {
      kind: "pages",
      converter: "pdf-pages",
      from: "pdf",
      pages,
      ...(title ? { title } : {}),
      metadata: { pageCount: result.numpages },
    };
  },
};
