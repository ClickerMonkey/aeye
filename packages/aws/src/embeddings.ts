/**
 * Bedrock embedding models: which take images, and the InvokeModel bodies
 * and responses of each family.
 *
 * - Titan Text Embeddings: one text per call.
 * - Titan Multimodal Embeddings: one text or image per call, one space.
 * - Nova Multimodal Embeddings: one text or image per call, one space.
 * - Cohere Embed v3/v4: texts in batches, an image per call, one space.
 */

import {
  embeddingImageBase64,
  type EmbeddingInput,
  type EmbeddingRequest,
  ImageEmbeddingError,
  isEmbeddingImage,
  type ModelCapability,
} from '@aeye/ai';

/**
 * How a Bedrock embedding model is called.
 */
export type AWSEmbeddingFamily = 'titan-text' | 'titan-multimodal' | 'nova-multimodal' | 'cohere';

/**
 * Most texts one Cohere Embed call takes.
 */
export const COHERE_EMBED_BATCH = 96;

/**
 * The embedding family of a Bedrock model id (with or without a region
 * prefix), or undefined for a model that does not embed.
 */
export function awsEmbeddingFamily(modelId: string): AWSEmbeddingFamily | undefined {
  if (modelId.includes('titan-embed-image')) return 'titan-multimodal';
  if (modelId.includes('titan-embed')) return 'titan-text';
  if (modelId.includes('nova') && modelId.includes('embed')) return 'nova-multimodal';
  if (modelId.includes('cohere.embed')) return 'cohere';
  return undefined;
}

/**
 * The embedding capabilities of a Bedrock model. Every Bedrock family that
 * embeds images puts them in the space of its texts.
 */
export function awsEmbeddingCapabilities(modelId: string): ModelCapability[] {
  const family = awsEmbeddingFamily(modelId);
  if (!family) return [];
  return family === 'titan-text' ? ['embedding'] : ['embedding', 'imageEmbedding', 'crossModalEmbedding'];
}

/**
 * One InvokeModel call: its body, and which request inputs its vectors are.
 */
export interface AWSEmbeddingCall {
  body: Record<string, unknown>;
  indices: number[];
}

/**
 * The InvokeModel calls that embed `inputs` with a model, in order. A
 * request's `extra` merges into each body (into `singleEmbeddingParams` for
 * Nova), so it can set e.g. Cohere's `input_type` or Nova's
 * `embeddingPurpose`.
 *
 * @throws {ImageEmbeddingError} When the model embeds text only and an input is an image
 */
export async function awsEmbeddingCalls(
  modelId: string,
  inputs: EmbeddingInput[],
  request: Pick<EmbeddingRequest, 'dimensions' | 'extra'> = {},
): Promise<AWSEmbeddingCall[]> {
  const family = awsEmbeddingFamily(modelId) ?? 'titan-text';
  const { dimensions, extra } = request;

  if (family === 'titan-text' && inputs.some(isEmbeddingImage)) {
    throw new ImageEmbeddingError(modelId);
  }
  if (family === 'cohere') {
    return cohereCalls(inputs, dimensions, extra);
  }

  return Promise.all(inputs.map(async (input, index): Promise<AWSEmbeddingCall> => {
    const image = isEmbeddingImage(input) ? await embeddingImageBase64(input) : undefined;
    switch (family) {
      case 'titan-text':
        return { indices: [index], body: { inputText: input, ...(dimensions ? { dimensions } : {}), ...extra } };
      case 'titan-multimodal':
        return { indices: [index], body: {
          ...(image ? { inputImage: image.base64 } : { inputText: input }),
          ...(dimensions ? { embeddingConfig: { outputEmbeddingLength: dimensions } } : {}),
          ...extra,
        } };
      case 'nova-multimodal':
        return { indices: [index], body: {
          taskType: 'SINGLE_EMBEDDING',
          singleEmbeddingParams: {
            embeddingPurpose: 'GENERIC_INDEX',
            ...(dimensions ? { embeddingDimension: dimensions } : {}),
            ...(image
              ? { image: { format: image.format, source: { bytes: image.base64 } } }
              : { text: { truncationMode: 'END', value: input } }),
            ...extra,
          },
        } };
    }
  }));
}

/**
 * Cohere Embed calls: runs of texts in batches, and one call per image.
 */
async function cohereCalls(inputs: EmbeddingInput[], dimensions: number | undefined, extra: Record<string, any> | undefined): Promise<AWSEmbeddingCall[]> {
  const shared = { ...(dimensions ? { output_dimension: dimensions } : {}) };
  const calls: AWSEmbeddingCall[] = [];
  let texts: { text: string; index: number }[] = [];
  const flush = () => {
    if (texts.length) {
      calls.push({ indices: texts.map(t => t.index), body: { texts: texts.map(t => t.text), input_type: 'search_document', ...shared, ...extra } });
      texts = [];
    }
  };
  for (const [index, input] of inputs.entries()) {
    if (isEmbeddingImage(input)) {
      flush();
      // Bedrock's Cohere takes images as data URLs only, so http(s) URLs are fetched
      const image = await embeddingImageBase64(input);
      calls.push({ indices: [index], body: { ...extra, images: [`data:${image.mimeType};base64,${image.base64}`], input_type: 'image', ...shared } });
    } else {
      texts.push({ text: input, index });
      if (texts.length === COHERE_EMBED_BATCH) flush();
    }
  }
  flush();
  return calls;
}

/**
 * The vectors of an InvokeModel embedding response, in the order of the
 * call's inputs, and the text tokens it reports.
 */
export function parseAWSEmbeddings(modelId: string, body: any): { vectors: number[][]; tokens?: number } {
  switch (awsEmbeddingFamily(modelId) ?? 'titan-text') {
    case 'cohere': {
      const embeddings = Array.isArray(body.embeddings) ? body.embeddings : body.embeddings?.float;
      return { vectors: embeddings ?? [] };
    }
    case 'nova-multimodal':
      return { vectors: (body.embeddings ?? []).slice(0, 1).map((e: { embedding: number[] }) => e.embedding) };
    default:
      return { vectors: [body.embedding], tokens: body.inputTextTokenCount };
  }
}
