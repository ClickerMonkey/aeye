import type { ResourceType, SegmentContext, TextSegment, TextSegmenter } from "../types";
import { assertNotAborted } from "../utils";

let textSplitters: any;

async function loadTextSplitters(): Promise<any> {
  if (textSplitters) return textSplitters;
  try {
    textSplitters = await import("@langchain/textsplitters");
    return textSplitters;
  } catch {
    return undefined;
  }
}

/** True when `@langchain/textsplitters` can be loaded. */
export async function isLangchainSplittersAvailable(): Promise<boolean> {
  return Boolean(await loadTextSplitters());
}

/** Maps resource types to LangChain's supported splitter languages (for grammar-aware splitting). */
const TYPE_TO_LANGUAGE: Record<string, string> = {
  typescript: "js",
  tsx: "js",
  javascript: "js",
  jsx: "js",
  python: "python",
  go: "go",
  java: "java",
  c: "cpp",
  cpp: "cpp",
  php: "php",
  rust: "rust",
  ruby: "ruby",
  scala: "scala",
  swift: "swift",
  markdown: "markdown",
  html: "html",
};

function languageForType(type: ResourceType | undefined): string | undefined {
  return type ? TYPE_TO_LANGUAGE[type] : undefined;
}

export type LangchainSegmenterMode = "recursive" | "token";

export interface LangchainSegmenterOptions {
  /** "recursive" (RecursiveCharacterTextSplitter, char-sized) or "token" (TokenTextSplitter). Default "recursive". */
  mode?: LangchainSegmenterMode;
  /** Force a LangChain language grammar (recursive mode). Otherwise derived from the resource type. */
  language?: string;
  /** Disable deriving the language grammar from the resource type. Default false. */
  languageFromType?: boolean;
  /** Chunk size — characters in recursive mode, tokens in token mode. Defaults to the slicer's maxChars. */
  chunkSize?: number;
  /** Overlap between chunks (characters/tokens to match mode). Default 0. Any value > 0 relaxes the round-trip guarantee. */
  chunkOverlap?: number;
  /** Custom separators (recursive mode, when no language grammar is used). */
  separators?: string[];
  /** Keep separators attached to chunks. Default true (improves offset recovery). */
  keepSeparator?: boolean;
}

/**
 * Creates a {@link TextSegmenter} backed by `@langchain/textsplitters`, adding chunk overlap, optional
 * token-based sizing, and language-aware splitting for ~16 languages — features the built-in segmenter
 * lacks. Offsets are recovered by locating each chunk in the source and are best-effort; with overlap
 * (or token mode), segments may overlap/trim, so the lossless round-trip guarantee does not hold.
 *
 * Requires the optional `@langchain/textsplitters` dependency: `npm install @langchain/textsplitters`.
 *
 * @example
 * registry.configureType("typescript", { segmenter: createLangchainSegmenter({ chunkOverlap: 200 }) });
 */
export function createLangchainSegmenter(options: LangchainSegmenterOptions = {}): TextSegmenter {
  const overlap = options.chunkOverlap ?? 0;
  const keepSeparator = options.keepSeparator ?? true;

  return async (text: string, context: SegmentContext): Promise<TextSegment[]> => {
    assertNotAborted(context.signal);
    const mod = await loadTextSplitters();
    if (!mod) {
      throw new Error("@langchain/textsplitters is not installed. Install it to use the LangChain segmenter: npm install @langchain/textsplitters");
    }

    const chunkSize = options.chunkSize ?? context.maxChars;
    let splitter: { splitText(text: string): Promise<string[]> };

    if (options.mode === "token") {
      splitter = new mod.TokenTextSplitter({ chunkSize, chunkOverlap: overlap });
    } else {
      const language = options.language ?? (options.languageFromType === false ? undefined : languageForType(context.type));
      if (language && mod.SupportedTextSplitterLanguages.includes(language)) {
        splitter = mod.RecursiveCharacterTextSplitter.fromLanguage(language, { chunkSize, chunkOverlap: overlap, keepSeparator });
      } else {
        splitter = new mod.RecursiveCharacterTextSplitter({
          chunkSize,
          chunkOverlap: overlap,
          keepSeparator,
          ...(options.separators ? { separators: options.separators } : {}),
        });
      }
    }

    const chunks = await splitter.splitText(text);
    return locateSegments(text, chunks, overlap > 0);
  };
}

/**
 * Recovers offsets for chunks by locating each in the source text. With overlap the search advances by
 * one char so order is preserved; without overlap it advances past each match. Chunks that cannot be
 * located (heavily transformed) fall back to a sequential best-effort span.
 */
function locateSegments(text: string, chunks: string[], overlapping: boolean): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    let start = text.indexOf(chunk, cursor);
    if (start === -1) {
      start = text.indexOf(chunk);
    }
    if (start === -1) {
      const fallbackStart = Math.min(cursor, text.length);
      segments.push({ start: fallbackStart, end: Math.min(fallbackStart + chunk.length, text.length), text: chunk });
      continue;
    }
    const end = start + chunk.length;
    segments.push({ start, end, text: chunk });
    cursor = overlapping ? start + 1 : end;
  }

  return segments;
}
