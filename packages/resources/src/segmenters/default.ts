import type { TextSegmenter } from "../types";
import { splitTextByBoundaries } from "../utils";

/**
 * The built-in segmenter: splits on boundary strings, producing contiguous, non-overlapping segments
 * with exact offsets. Concatenating the segments reproduces the input text exactly.
 */
export const defaultTextSegmenter: TextSegmenter = (text, context) =>
  splitTextByBoundaries(text, context.maxChars, context.minChars, context.boundaries);
