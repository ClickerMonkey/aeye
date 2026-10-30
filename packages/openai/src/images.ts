/**
 * GPT Image request parameters and usage, shared by generation and editing.
 * DALL·E models were retired, so every image model takes the GPT Image shape.
 */

import type { ImageOutputOptions, ModelInfo } from '@aeye/ai';
import type { Usage } from '@aeye/core';

interface Size {
  width: number;
  height: number;
}

/**
 * Sizes every GPT Image model accepts, for models the registry has no sizes for.
 */
const DEFAULT_SIZES: Size[] = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
];

/**
 * Most images one request may produce.
 */
const MAX_IMAGES = 10;

/**
 * Most partial images a streaming request may produce.
 */
const MAX_PARTIAL_IMAGES = 3;

/**
 * The size closest in aspect ratio to the requested one, then the largest.
 */
function nearestSize(requested: string, sizes: Size[]): string {
  const [width, height] = requested.split('x').map(Number);
  const ratio = width / height;
  const [closest] = [...sizes].sort((a, b) =>
    Math.abs(a.width / a.height - ratio) - Math.abs(b.width / b.height - ratio) ||
    b.width * b.height - a.width * a.height
  );
  return `${closest.width}x${closest.height}`;
}

/**
 * The sizes the registry prices for a model.
 */
function pricedSizes(model: ModelInfo | undefined): Size[] {
  return model?.pricing.image?.output?.flatMap(quality => quality.sizes) ?? [];
}

/**
 * Parameters shared by image generation and editing. `auto` and exact
 * sizes pass through; other sizes snap to the nearest one the model takes.
 */
export function imageParams(request: ImageOutputOptions, modelId: string, model: ModelInfo | undefined) {
  const sizes = pricedSizes(model);
  return {
    model: modelId,
    prompt: request.prompt,
    n: request.n === undefined ? undefined : Math.min(Math.max(request.n, 1), MAX_IMAGES),
    size: !request.size || request.size === 'auto' ? request.size : nearestSize(request.size, sizes.length ? sizes : DEFAULT_SIZES),
    quality: request.quality,
    background: request.background,
    output_format: request.outputFormat,
    output_compression: request.outputCompression,
    user: request.userIdentifier,
  };
}

/**
 * How many partial images a streaming request asks for.
 */
export function partialImages(request: ImageOutputOptions): number {
  return Math.max(1, Math.min(MAX_PARTIAL_IMAGES, request.streamCount ?? 2));
}

/**
 * What image responses and completed stream events report about the image.
 */
interface ImageResult {
  usage?: { input_tokens_details: { image_tokens: number; text_tokens: number } };
  quality?: string;
  size?: string;
}

/**
 * Usage of an image response: input tokens as reported, plus one output
 * entry per image priced by the quality and size actually produced.
 */
export function imageUsage(response: ImageResult, count: number): Usage {
  const [width, height] = (response.size ?? '').split('x').map(Number);
  const details = response.usage?.input_tokens_details;
  return {
    text: details && { input: details.text_tokens },
    image: {
      input: details?.image_tokens,
      output: response.quality && width && height
        ? [{ quality: response.quality, size: { width, height }, count }]
        : undefined,
    },
  };
}
