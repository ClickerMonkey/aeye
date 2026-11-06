import { createReadStream } from "node:fs";
import path from "node:path";
import type { ParsedResource, ParserContext, ResourceSource } from "../types";
import { withLocalFile } from "../utils";

const DEFAULT_EXTENSIONS: Record<string, string> = {
  docx: ".docx",
  excel: ".xlsx",
  csv: ".csv",
  tsv: ".tsv",
};

/**
 * Converts a source to PDF with `convertToPdf` and parses the PDF through the registry's PDF parser
 * stack. Sources that aren't local files (in memory, URLs, zip entries) are written to a temporary
 * file first; the PDF is parsed before that file is removed, in case the converter wrote next to it.
 */
export async function parseViaPdf(source: ResourceSource, context: ParserContext): Promise<ParsedResource | undefined> {
  const convertToPdf = context.options.convertToPdf;
  if (!convertToPdf) {
    return undefined;
  }

  const extension = path.extname(source.name ?? "") || DEFAULT_EXTENSIONS[source.type ?? ""] || "";
  return withLocalFile(source, extension, async (sourceFilePath) => {
    const pdfPath = await convertToPdf(sourceFilePath, context.options.signal);
    const pdfSource: ResourceSource = {
      ...source,
      location: pdfPath,
      type: "pdf",
      mimeType: "application/pdf",
      // A factory, so the file is only opened if a parser actually reads it.
      input: () => createReadStream(pdfPath) as AsyncIterable<Uint8Array>,
      metadata: { ...source.metadata, convertedFrom: source.location },
    };
    // Delegate through the registry so the full PDF parser stack (render + text) applies.
    const result = await context.registry.parseSource(pdfSource, context.options);
    result.location = source.location;
    result.name = source.name ?? result.name;
    result.metadata = { ...result.metadata, convertedFrom: source.type, pdfPath };
    return result;
  });
}
