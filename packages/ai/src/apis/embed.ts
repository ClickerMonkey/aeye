/**
 * Embed API
 *
 * Embeddings of texts and, for models with the `imageEmbedding` capability,
 * images. One vector per input, in input order.
 *
 * Models with `crossModalEmbedding` put text and image vectors in one space,
 * so a text query finds images; other image models keep their own space.
 *
 * @example
 * ```typescript
 * const { embeddings } = await ai.embed.get({
 *   inputs: ['a red bicycle', { image: 'https://example.com/bike.jpg' }],
 * }, { metadata: { required: ['crossModalEmbedding'] } });
 * ```
 */

import { toBase64, toURL, type Usage } from '@aeye/core';
import type {
  AIBaseTypes,
  AIContext,
  EmbeddingImage,
  EmbeddingInput,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelCapability,
  ModelParameter,
  ModelHandlerFor,
  SelectedModelFor
} from '../types';
import { GetAPI } from './get';

/**
 * Images sent to a model that embeds text only.
 */
export class ImageEmbeddingError extends Error {
  override readonly name = 'ImageEmbeddingError';

  constructor(
    // The model that cannot embed images
    public readonly model: string,
  ) {
    super(`${model} embeds text only: send images to a model with the imageEmbedding capability`);
  }
}

/**
 * Whether an embedding input is an image.
 */
export function isEmbeddingImage(input: EmbeddingInput): input is EmbeddingImage {
  return typeof input === 'object' && input !== null && 'image' in input;
}

/**
 * What a request embeds, in order: its `inputs`, or its `texts`.
 *
 * @throws {Error} When the request gives both
 */
export function embeddingInputs(request: Pick<EmbeddingRequest, 'inputs' | 'texts'>): EmbeddingInput[] {
  if (request.inputs && request.texts) {
    throw new Error('An embedding request gives inputs or texts, not both');
  }
  return request.inputs ?? request.texts ?? [];
}

/**
 * The texts of a request for a model that embeds text only.
 *
 * @param request The embedding request
 * @param model The model's id, named in the error
 * @throws {ImageEmbeddingError} When the request has an image
 */
export function embeddingTexts(request: Pick<EmbeddingRequest, 'inputs' | 'texts'>, model: string): string[] {
  return embeddingInputs(request).map(input => {
    if (isEmbeddingImage(input)) {
      throw new ImageEmbeddingError(model);
    }
    return input;
  });
}

/**
 * The one input of a request for a model that embeds one input per call.
 *
 * @param request The embedding request
 * @param model The model's id, named in the error
 * @throws {Error} When the request has more or fewer than one input
 */
export function singleEmbeddingInput(request: Pick<EmbeddingRequest, 'inputs' | 'texts'>, model: string): EmbeddingInput {
  const inputs = embeddingInputs(request);
  if (inputs.length !== 1) {
    throw new Error(`${model} embeds one input per call, and this request has ${inputs.length}`);
  }
  return inputs[0];
}

/**
 * An embedding image as a URL: http(s) URLs pass through, anything else
 * becomes a data URL.
 */
export function embeddingImageURL(input: EmbeddingImage): Promise<string> {
  return toURL(input.image, input.mimeType ?? 'image/png');
}

/**
 * An embedding image's bytes, base64 encoded without the data URL prefix,
 * with its MIME type and short format (`png`, `jpeg`, ...).
 */
export async function embeddingImageBase64(input: EmbeddingImage): Promise<{ base64: string; mimeType: string; format: string }> {
  const url = await toBase64(input.image, input.mimeType ?? 'image/png');
  const comma = url.indexOf(',');
  const declared = url.slice('data:'.length, url.indexOf(';'));
  const mimeType = declared.startsWith('image/') ? declared : (input.mimeType ?? 'image/png');
  return { base64: url.slice(comma + 1), mimeType, format: mimeType.slice('image/'.length).replace('jpg', 'jpeg') };
}

/**
 * Estimated usage of embedding `inputs`: about four characters a text token,
 * and a count of images.
 */
export function estimateEmbeddingUsage(inputs: EmbeddingInput[]): Usage {
  const texts = inputs.filter((input): input is string => !isEmbeddingImage(input));
  const images = inputs.length - texts.length;
  return {
    embeddings: {
      count: inputs.length,
      tokens: Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 4),
      ...(images ? { images } : {}),
    },
  };
}

export class EmbedAPI<T extends AIBaseTypes> extends GetAPI<T, EmbeddingRequest, EmbeddingResponse> {
  protected getRequiredCapabilities(provided: ModelCapability[], request: EmbeddingRequest): ModelCapability[] {
    const inputs = embeddingInputs(request);
    const images = inputs.some(isEmbeddingImage);
    const texts = !images || inputs.some(input => !isEmbeddingImage(input));
    return [...new Set<ModelCapability>([
      ...(texts ? ['embedding' as const] : []),
      ...(images ? ['imageEmbedding' as const] : []),
      ...provided,
    ])];
  }

  protected getRequiredParameters(provided: ModelParameter[], request: EmbeddingRequest): ModelParameter[] {
    return request.dimensions !== undefined ? [...new Set<ModelParameter>([...provided, 'embeddingDimensions'])] : provided;
  }

  protected getNoModelFoundError(): string {
    return 'No compatible model found for embeddings';
  }

  protected getErrorType(): string {
    return 'embedding-generation-failed';
  }

  protected getErrorMessage(): string {
    return 'Embedding generation failed';
  }

  protected async executeRequest(
    request: EmbeddingRequest,
    selected: SelectedModelFor<T>,
    ctx: AIContext<T>
  ): Promise<EmbeddingResponse> {
    return await selected.provider.embed!(
      request,
      ctx,
      selected.providerConfig
    );
  }

  protected estimateRequestUsage(request: EmbeddingRequest): Usage {
    return estimateEmbeddingUsage(embeddingInputs(request));
  }

  protected getHandlerGetMethod(
    handler?: ModelHandlerFor<T>
  ): ((request: EmbeddingRequest, ctx: AIContext<T>) => Promise<EmbeddingResponse>) | undefined {
    return handler?.embed?.get;
  }

  protected hasProviderExecutor(selected: SelectedModelFor<T>): boolean {
    return !!selected.provider.embed;
  }
}
