/**
 * Replicate embeddings: image embedding capabilities, and the CLIP-style
 * transformers' inputs, run through the provider with a fake client.
 */

import { AI, type AIContextAny, type EmbeddingRequest } from '@aeye/ai';
import { replicateTransformers } from '@aeye/models';
import { convertReplicateModel, ReplicateProvider, type ReplicateModel } from '../replicate';

const mockRun = jest.fn();
jest.mock('replicate', () => jest.fn().mockImplementation(() => ({ run: mockRun })));

const ctx: AIContextAny = { ai: AI.with().providers({}).create({}), metadata: {} };
const PNG = new Uint8Array([1, 2, 3]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;

beforeEach(() => jest.clearAllMocks());

/** Embed with a model's transformer, returning what Replicate was sent and the response. */
async function embed(model: string, request: EmbeddingRequest, output: unknown) {
  mockRun.mockReset().mockResolvedValue(output);
  const provider = new ReplicateProvider({ apiKey: 'k', transformers: replicateTransformers });
  const response = await provider.embed!({ ...request, model }, ctx);
  return { input: mockRun.mock.calls[0]?.[1].input, response };
}

describe('image embedding capabilities', () => {
  const model = (name: string, description: string): ReplicateModel => ({
    url: '', owner: 'o', name, description, visibility: 'public', github_url: null, paper_url: null, license_url: null,
    run_count: 10, cover_image_url: null, default_example: null, latest_version: null,
  });

  it('flags CLIP-like embedders as embedding images in the text space', () => {
    expect([...convertReplicateModel(model('clip-embeddings', 'CLIP embeddings')).capabilities])
      .toEqual(expect.arrayContaining(['embedding', 'imageEmbedding', 'crossModalEmbedding']));
    expect(convertReplicateModel(model('bge-embed', 'text embedding model')).capabilities.has('imageEmbedding')).toBe(false);
  });
});

describe('CLIP-style transformers', () => {
  it('krthr/clip-embeddings sends one text or one image', async () => {
    expect((await embed('krthr/clip-embeddings', { inputs: ['a cat'] }, { embedding: [1] })).input).toEqual({ text: 'a cat' });
    const { input, response } = await embed('krthr/clip-embeddings', { inputs: [{ image: PNG }] }, { embedding: [2] });
    expect(input).toEqual({ image: PNG_URL });
    expect(response.embeddings).toEqual([{ embedding: [2], index: 0 }]);
    await expect(embed('krthr/clip-embeddings', { inputs: ['a', 'b'] }, {})).rejects.toThrow('one input per call');
  });

  it('andreasjansson/clip-features sends texts and image URLs as lines, in order', async () => {
    const { input, response } = await embed('andreasjansson/clip-features', { inputs: ['a cat', { image: 'https://example.com/cat.png' }] },
      [{ input: 'a cat', embedding: [1] }, { input: 'https://example.com/cat.png', embedding: [2] }]);
    expect(input).toEqual({ inputs: 'a cat\nhttps://example.com/cat.png' });
    expect(response.embeddings).toEqual([{ embedding: [1], index: 0 }, { embedding: [2], index: 1 }]);
    await expect(embed('andreasjansson/clip-features', { inputs: [{ image: PNG }] }, [])).rejects.toThrow('http(s) URLs only');
  });

  it('zsxkib/jina-clip-v2 sends an image with its dimensions', async () => {
    const { input } = await embed('zsxkib/jina-clip-v2', { inputs: [{ image: PNG }], dimensions: 512 }, [[1]]);
    expect(input).toEqual({ image: PNG_URL, embedding_dim: 512, output_format: 'array' });
  });

  it('daanelson/imagebind sends an image as vision, a text as text', async () => {
    expect((await embed('daanelson/imagebind', { inputs: [{ image: PNG }] }, [1])).input).toEqual({ input: PNG_URL, modality: 'vision' });
    expect((await embed('daanelson/imagebind', { texts: ['hi'] }, [1])).input).toEqual({ text_input: 'hi', modality: 'text' });
  });

  it('text-only models keep taking texts and refuse images', async () => {
    const { input } = await embed('replicate/all-mpnet-base-v2', { texts: ['a', 'b'] }, [{ embedding: [1] }, { embedding: [2] }]);
    expect(input).toEqual({ text_batch: JSON.stringify(['a', 'b']) });
    await expect(embed('replicate/all-mpnet-base-v2', { inputs: [{ image: PNG }] }, [])).rejects.toThrow('embeds text only');
  });
});
