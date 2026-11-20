/**
 * Bedrock embeddings: request bodies per family, response parsing, image
 * capabilities, and the provider's calls against a fake Bedrock client.
 */

import { AI, type AIContextAny, ImageEmbeddingError } from '@aeye/ai';
import { FoundationModelSummary } from '@aws-sdk/client-bedrock';
import { AWSBedrockProvider } from '../aws';
import { convertAWSModel, detectAWSCapabilities } from '../common';
import { awsEmbeddingCalls, awsEmbeddingFamily, COHERE_EMBED_BATCH, parseAWSEmbeddings } from '../embeddings';

const PNG = new Uint8Array([1, 2, 3]);
const PNG_BASE64 = Buffer.from(PNG).toString('base64');
const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };

const summary = (modelId: string, inputModalities: string[] = ['TEXT']): FoundationModelSummary => ({
  modelId,
  modelName: modelId,
  providerName: modelId.split('.')[0],
  inputModalities: inputModalities as FoundationModelSummary['inputModalities'],
  outputModalities: ['EMBEDDING'],
});

describe('Bedrock embedding families and capabilities', () => {
  it('names each family', () => {
    expect(awsEmbeddingFamily('amazon.titan-embed-text-v2:0')).toBe('titan-text');
    expect(awsEmbeddingFamily('amazon.titan-embed-image-v1')).toBe('titan-multimodal');
    expect(awsEmbeddingFamily('amazon.nova-2-multimodal-embeddings-v1:0')).toBe('nova-multimodal');
    expect(awsEmbeddingFamily('us.cohere.embed-v4:0')).toBe('cohere');
    expect(awsEmbeddingFamily('anthropic.claude-3-haiku-20240307-v1:0')).toBeUndefined();
  });

  it('flags image embedding, in the text space, on multimodal models only', () => {
    const caps = (id: string, modalities?: string[]) => [...detectAWSCapabilities(summary(id, modalities))].sort();
    expect(caps('amazon.titan-embed-text-v2:0')).toEqual(['embedding']);
    expect(caps('amazon.titan-embed-image-v1', ['TEXT', 'IMAGE'])).toEqual(['crossModalEmbedding', 'embedding', 'imageEmbedding']);
    expect(caps('amazon.nova-2-multimodal-embeddings-v1:0')).toEqual(['crossModalEmbedding', 'embedding', 'imageEmbedding']);
    expect(caps('cohere.embed-english-v3')).toEqual(['crossModalEmbedding', 'embedding', 'imageEmbedding']);
    expect(caps('cohere.embed-v4:0')).toEqual(['crossModalEmbedding', 'embedding', 'imageEmbedding']);
  });

  it('prices Titan Multimodal images per image', () => {
    expect(convertAWSModel(summary('amazon.titan-embed-image-v1', ['TEXT', 'IMAGE']))?.pricing.embeddings).toEqual({ cost: 0.8, perImage: 0.00006 });
  });
});

describe('awsEmbeddingCalls', () => {
  it('Titan Text: one text per call, with dimensions', async () => {
    expect(await awsEmbeddingCalls('amazon.titan-embed-text-v2:0', ['a', 'b'], { dimensions: 256 })).toEqual([
      { indices: [0], body: { inputText: 'a', dimensions: 256 } },
      { indices: [1], body: { inputText: 'b', dimensions: 256 } },
    ]);
  });

  it('Titan Text refuses images', async () => {
    await expect(awsEmbeddingCalls('amazon.titan-embed-text-v2:0', ['a', { image: PNG }])).rejects.toThrow(ImageEmbeddingError);
  });

  it('Titan Multimodal: text or base64 image per call, with the output length', async () => {
    expect(await awsEmbeddingCalls('amazon.titan-embed-image-v1', ['a', { image: PNG }], { dimensions: 384 })).toEqual([
      { indices: [0], body: { inputText: 'a', embeddingConfig: { outputEmbeddingLength: 384 } } },
      { indices: [1], body: { inputImage: PNG_BASE64, embeddingConfig: { outputEmbeddingLength: 384 } } },
    ]);
  });

  it('Nova Multimodal: single embeddings of text or image, extra merging into the params', async () => {
    const calls = await awsEmbeddingCalls('amazon.nova-2-multimodal-embeddings-v1:0', ['a', { image: 'data:image/jpeg;base64,AAAA' }], { dimensions: 1024, extra: { embeddingPurpose: 'GENERIC_RETRIEVAL' } });
    expect(calls).toEqual([
      { indices: [0], body: { taskType: 'SINGLE_EMBEDDING', singleEmbeddingParams: { embeddingPurpose: 'GENERIC_RETRIEVAL', embeddingDimension: 1024, text: { truncationMode: 'END', value: 'a' } } } },
      { indices: [1], body: { taskType: 'SINGLE_EMBEDDING', singleEmbeddingParams: { embeddingPurpose: 'GENERIC_RETRIEVAL', embeddingDimension: 1024, image: { format: 'jpeg', source: { bytes: 'AAAA' } } } } },
    ]);
  });

  it('Cohere: runs of texts batched, one call per image as a data URL', async () => {
    const calls = await awsEmbeddingCalls('cohere.embed-v4:0', ['a', 'b', { image: PNG }, 'c'], { dimensions: 512 });
    expect(calls).toEqual([
      { indices: [0, 1], body: { texts: ['a', 'b'], input_type: 'search_document', output_dimension: 512 } },
      { indices: [2], body: { images: [`data:image/png;base64,${PNG_BASE64}`], input_type: 'image', output_dimension: 512 } },
      { indices: [3], body: { texts: ['c'], input_type: 'search_document', output_dimension: 512 } },
    ]);
  });

  it('Cohere: splits long runs of texts and keeps images as images under extra', async () => {
    const texts = Array.from({ length: COHERE_EMBED_BATCH + 1 }, (_, i) => `t${i}`);
    const calls = await awsEmbeddingCalls('cohere.embed-english-v3', [...texts, { image: PNG }], { extra: { input_type: 'search_query' } });
    expect(calls.map(c => c.indices.length)).toEqual([COHERE_EMBED_BATCH, 1, 1]);
    expect(calls[0].body.input_type).toBe('search_query');
    expect(calls[2].body.input_type).toBe('image');
  });

  it('Cohere: fetches an http(s) image into a data URL, since Bedrock takes no image URLs', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob([PNG], { type: 'image/jpeg' })));
    try {
      const calls = await awsEmbeddingCalls('cohere.embed-v4:0', [{ image: 'https://example.com/bike.jpg' }]);
      expect(fetchSpy).toHaveBeenCalled();
      expect(calls[0].body.images).toEqual([`data:image/jpeg;base64,${PNG_BASE64}`]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('parseAWSEmbeddings', () => {
  it('reads each family', () => {
    expect(parseAWSEmbeddings('amazon.titan-embed-image-v1', { embedding: [1, 2], inputTextTokenCount: 3 })).toEqual({ vectors: [[1, 2]], tokens: 3 });
    expect(parseAWSEmbeddings('amazon.nova-2-multimodal-embeddings-v1:0', { embeddings: [{ embeddingType: 'IMAGE', embedding: [4] }] })).toEqual({ vectors: [[4]] });
    expect(parseAWSEmbeddings('cohere.embed-english-v3', { embeddings: [[1], [2]], response_type: 'embeddings_floats' })).toEqual({ vectors: [[1], [2]] });
    expect(parseAWSEmbeddings('cohere.embed-v4:0', { embeddings: { float: [[5]] }, response_type: 'embeddings_by_type' })).toEqual({ vectors: [[5]] });
  });
});

describe('AWSBedrockProvider.embed', () => {
  function provider(respond: (body: any) => any) {
    const p = new AWSBedrockProvider({ region: 'us-east-1', credentials: { accessKeyId: 'k', secretAccessKey: 's' }, modelPrefix: 'us.' });
    const send = jest.fn(async (command: any) => ({ body: new TextEncoder().encode(JSON.stringify(respond(JSON.parse(command.input.body)))) }));
    (p as any).bedrockRuntimeClient = { send };
    return { p, send };
  }

  it('embeds texts and images in input order with the selected model, counting images', async () => {
    const { p, send } = provider(body => body.inputImage ? { embedding: [9] } : { embedding: [body.inputText.length], inputTextTokenCount: 2 });
    const response = await p.embed!({ inputs: ['abc', { image: PNG }, 'a'] }, { ...ctx, metadata: { model: 'amazon.titan-embed-image-v1' } }, {} as any);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0].input.modelId).toBe('us.amazon.titan-embed-image-v1');
    expect(response.embeddings).toEqual([{ embedding: [3], index: 0 }, { embedding: [9], index: 1 }, { embedding: [1], index: 2 }]);
    expect(response.usage).toEqual({ embeddings: { count: 3, tokens: 4, images: 1 } });
  });

  it('keeps text-only requests working', async () => {
    const { p } = provider(body => ({ embeddings: body.texts.map((t: string) => [t.length]) }));
    const response = await p.embed!({ texts: ['ab', 'abcd'], model: 'cohere.embed-english-v3' }, ctx, {} as any);
    expect(response.embeddings).toEqual([{ embedding: [2], index: 0 }, { embedding: [4], index: 1 }]);
    expect(response.usage).toEqual({ embeddings: { count: 2 } });
  });

  it('refuses images for a text-only model before calling Bedrock', async () => {
    const { p, send } = provider(() => ({}));
    await expect(p.embed!({ inputs: [{ image: PNG }], model: 'amazon.titan-embed-text-v2:0' }, ctx, {} as any)).rejects.toThrow('embeds text only');
    expect(send).not.toHaveBeenCalled();
  });
});
