import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RenderedPage, RenderPdfPagesFn } from "../types";
import { assertNotAborted } from "../utils";

type PopplerInstance = {
  pdfToPpm: (file: string, outputPath: string, options?: Record<string, unknown>) => Promise<string>;
};

let popplerCtor: (new (binaryPath?: string) => PopplerInstance) | undefined;

async function loadPoppler(): Promise<typeof popplerCtor> {
  if (popplerCtor) return popplerCtor;
  try {
    const mod: any = await import("node-poppler");
    popplerCtor = mod.Poppler ?? mod.default?.Poppler ?? mod.default;
    return popplerCtor;
  } catch {
    return undefined;
  }
}

/** Output image format for poppler page rendering. */
export type PopplerImageFormat = "png" | "jpeg" | "tiff";

export interface PopplerRendererOptions {
  /** Path to the directory containing the poppler binaries, passed to the node-poppler constructor. */
  binaryPath?: string;
  /** Output image format. Defaults to "png". */
  format?: PopplerImageFormat;
  /** Enable/disable font anti-aliasing. Defaults to "yes". */
  antialiasFonts?: "yes" | "no";
  /** Enable/disable vector anti-aliasing. Defaults to "yes". */
  antialiasVectors?: "yes" | "no";
}

const FORMAT_CONFIG: Record<PopplerImageFormat, { flag: string; ext: string; mimeType: string }> = {
  png: { flag: "pngFile", ext: "png", mimeType: "image/png" },
  jpeg: { flag: "jpegFile", ext: "jpg", mimeType: "image/jpeg" },
  tiff: { flag: "tiffFile", ext: "tif", mimeType: "image/tiff" },
};

/**
 * Maps the raw image files produced by poppler into ordered {@link RenderedPage} entries. Poppler
 * names files "<base>-<pageNumber>.<ext>" (page number zero-padded by the total page count), so files
 * are filtered by extension, ordered by their numeric page number, and given a 1-based fallback.
 */
export function orderRenderedPages(files: string[], outputDir: string, format: PopplerImageFormat = "png"): RenderedPage[] {
  const { ext, mimeType } = FORMAT_CONFIG[format];
  const pageNumberPattern = new RegExp(`-(\\d+)\\.${ext}$`);

  return files
    .filter((file) => file.endsWith(`.${ext}`))
    .map((file) => ({ file, pageNumber: Number.parseInt(file.match(pageNumberPattern)?.[1] ?? "0", 10) }))
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((entry, index) => ({
      filePath: join(outputDir, entry.file),
      pageNumber: entry.pageNumber || index + 1,
      mimeType,
    }));
}

/** Returns true if node-poppler (and its underlying poppler binaries) can be loaded. */
export async function isPopplerAvailable(binaryPath?: string): Promise<boolean> {
  const Poppler = await loadPoppler();
  if (!Poppler) return false;
  try {
    new Poppler(binaryPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a {@link RenderPdfPagesFn} backed by poppler (via node-poppler's `pdfToPpm`). Pages are
 * written one image per page into the output directory and returned in page order.
 *
 * Requires the optional `node-poppler` dependency and the poppler binaries to be installed:
 * `npm install node-poppler`.
 *
 * @example
 * const registry = createDefaultResourceRegistry();
 * registry.configureType("pdf", {
 *   pdf: { renderPages: true, transcribePages: true },
 *   renderPdfPages: createPopplerRenderer(),
 *   transcribeImage: myTranscriber,
 * });
 */
export function createPopplerRenderer(options: PopplerRendererOptions = {}): RenderPdfPagesFn {
  const format = options.format ?? "png";
  const { flag } = FORMAT_CONFIG[format];

  return async (pdfFilePath, outputDir, dpi, signal): Promise<RenderedPage[]> => {
    assertNotAborted(signal);

    const Poppler = await loadPoppler();
    if (!Poppler) {
      throw new Error("node-poppler is not installed. Install it to render PDF pages: npm install node-poppler");
    }

    const poppler = new Poppler(options.binaryPath);
    await mkdir(outputDir, { recursive: true });

    const outputBase = join(outputDir, "page");
    await poppler.pdfToPpm(pdfFilePath, outputBase, {
      [flag]: true,
      singleFile: false,
      resolutionXYAxis: dpi,
      antialiasFonts: options.antialiasFonts ?? "yes",
      antialiasVectors: options.antialiasVectors ?? "yes",
      quiet: true,
    });

    assertNotAborted(signal);

    return orderRenderedPages(await readdir(outputDir), outputDir, format);
  };
}
