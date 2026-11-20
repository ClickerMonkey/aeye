/**
 * Embed API Tests
 *
 * Tests for the Embed API covering text embedding generation.
 */

import { models } from '@aeye/models';
import { AI } from '../ai';
import { createMockModels, createMockProvider } from './mocks/provider.mock';
import type { EmbeddingRequest, ModelInfo } from '../types';
import { embeddingImageBase64, embeddingInputs, embeddingTexts, estimateEmbeddingUsage, ImageEmbeddingError, isEmbeddingImage } from '../apis/embed';

describe('Embed API', () => {
  describe('Embedding Generation', () => {
    it('should generate embeddings for single text', async () => {
      const provider1 = createMockProvider({ name: 'provider1' });

      const ai = AI.with()
        .providers({ provider1 })
        .create({ models });

      await ai.models.refresh();

      const request: EmbeddingRequest = {
        texts: ['Hello world']
      };

      const response = await ai.embed.get(request);

      expect(response).toBeDefined();
      expect(response.embeddings).toBeDefined();
      expect(response.embeddings.length).toBe(1);
      expect(response.embeddings[0].embedding).toBeDefined();
      expect(Array.isArray(response.embeddings[0].embedding)).toBe(true);
    });

    it('should generate embeddings for multiple texts', async () => {
      const openai = createMockProvider({ name: 'provider1' });

      const ai = AI.with()
        .providers({ openai })
        .create({ models });

      const request: EmbeddingRequest = {
        texts: ['First text', 'Second text', 'Third text']
      };

      const response = await ai.embed.get(request);

      expect(response).toBeDefined();
      expect(response.embeddings.length).toBe(3);
      expect(response.embeddings[0].index).toBe(0);
      expect(response.embeddings[1].index).toBe(1);
      expect(response.embeddings[2].index).toBe(2);
    });

    it('should use specified embedding model', async () => {
      const provider1 = createMockProvider({ name: 'provider1' });

      const ai = AI.with()
        .providers({ provider1 })
        .create({ models });

      const request: EmbeddingRequest = {
        texts: ['Test']
      };

      const response = await ai.embed.get(request, {
        metadata: { model: 'provider1-embed-1' }
      });

      expect(response).toBeDefined();
    });

    it('should track usage for embeddings', async () => {
      const openai = createMockProvider({ name: 'provider1' });

      const ai = AI.with()
        .providers({ openai })
        .create({ models });

      const request: EmbeddingRequest = {
        texts: ['Hello', 'World']
      };

      const response = await ai.embed.get(request);

      expect(response.usage).toBeDefined();
      expect(response.usage?.embeddings?.tokens).toBeGreaterThan(0);
    });

    it('should call hooks for embeddings', async () => {
      const openai = createMockProvider({ name: 'provider1' });

      const beforeRequest = jest.fn();
      const afterRequest = jest.fn();

      const ai = AI.with()
        .providers({ openai })
        .create({ models })
        .withHooks({
          beforeRequest,
          afterRequest
        });

      const request: EmbeddingRequest = {
        texts: ['Test']
      };

      await ai.embed.get(request);

      expect(beforeRequest).toHaveBeenCalled();
      expect(afterRequest).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should throw when no embedding model available', async () => {
      const provider1 = createMockProvider({
        name: 'provider1',
        models: [] // No models
      });

      const ai = AI.with()
        .providers({ provider1 })
        .create({ models });

      const request: EmbeddingRequest = {
        texts: ['Test']
      };

      await expect(ai.embed.get(request)).rejects.toThrow();
    });

    it('should handle empty text array', async () => {
      const provider1 = createMockProvider({ name: 'provider1' });

      const ai = AI.with()
        .providers({ provider1 })
        .create({ models });

      const request: EmbeddingRequest = {
        texts: []
      };

      // Should handle gracefully or throw validation error
      try {
        await ai.embed.get(request);
      } catch (error) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('Image inputs', () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const imageModel: ModelInfo = {
      id: 'provider1-clip',
      provider: 'provider1',
      name: 'Image embedder',
      capabilities: new Set(['embedding', 'imageEmbedding', 'crossModalEmbedding']),
      tier: 'efficient',
      pricing: { embeddings: { cost: 0.8, perImage: 0.00006 } },
      contextWindow: 128,
    };

    function create() {
      const provider1 = createMockProvider({ name: 'provider1', models: [...createMockModels('provider1'), imageModel] });
      return AI.with().providers({ provider1 }).create({ models });
    }

    it('reads inputs, or texts, and refuses both', () => {
      expect(embeddingInputs({ texts: ['a'] })).toEqual(['a']);
      expect(embeddingInputs({ inputs: ['a', { image: PNG }] })).toEqual(['a', { image: PNG }]);
      expect(embeddingInputs({})).toEqual([]);
      expect(() => embeddingInputs({ texts: ['a'], inputs: ['b'] })).toThrow('not both');
      expect(isEmbeddingImage({ image: PNG })).toBe(true);
      expect(isEmbeddingImage('text')).toBe(false);
    });

    it('refuses images for a text-only model', () => {
      expect(embeddingTexts({ inputs: ['a', 'b'] }, 'm')).toEqual(['a', 'b']);
      expect(() => embeddingTexts({ inputs: ['a', { image: PNG }] }, 'text-model')).toThrow(ImageEmbeddingError);
    });

    it('encodes image bytes as base64 with a format', async () => {
      expect(await embeddingImageBase64({ image: PNG })).toEqual({ base64: Buffer.from(PNG).toString('base64'), mimeType: 'image/png', format: 'png' });
      expect(await embeddingImageBase64({ image: 'data:image/jpeg;base64,AAAA' })).toEqual({ base64: 'AAAA', mimeType: 'image/jpeg', format: 'jpeg' });
    });

    it('estimates text tokens and counts images', () => {
      expect(estimateEmbeddingUsage(['abcdefgh', { image: PNG }, { image: PNG }])).toEqual({ embeddings: { count: 3, tokens: 2, images: 2 } });
      expect(estimateEmbeddingUsage(['abcd'])).toEqual({ embeddings: { count: 1, tokens: 1 } });
    });

    it('selects an image embedding model for image inputs, estimating images', async () => {
      const beforeRequest = jest.fn();
      const ai = create().withHooks({ beforeRequest });
      await ai.models.refresh();
      const response = await ai.embed.get({ inputs: ['a bike', { image: PNG }] });
      const [, , selected, estimated, cost] = beforeRequest.mock.calls[0];
      expect(selected.model.id).toBe('provider1-clip');
      expect(estimated).toEqual({ embeddings: { count: 2, tokens: 2, images: 1 } });
      expect(cost).toBeCloseTo(2 * 0.8 / 1_000_000 + 0.00006);
      expect(response.embeddings).toHaveLength(2);
    });

    it('keeps text-only requests on text models', async () => {
      const beforeRequest = jest.fn();
      const ai = create().withHooks({ beforeRequest });
      await ai.models.refresh();
      await ai.embed.get({ texts: ['a bike'] }, { metadata: { model: 'provider1-embed-1' } });
      expect(beforeRequest.mock.calls[0][2].model.id).toBe('provider1-embed-1');
    });

    it('needs only imageEmbedding for images alone', async () => {
      const ai = create();
      await ai.models.refresh();
      const required = (ai.embed as any).getRequiredCapabilities([], { inputs: [{ image: PNG }] });
      expect(required).toEqual(['imageEmbedding']);
      expect((ai.embed as any).getRequiredCapabilities([], { texts: ['a'] })).toEqual(['embedding']);
      expect((ai.embed as any).getRequiredCapabilities(['crossModalEmbedding'], { inputs: ['a', { image: PNG }] }))
        .toEqual(['embedding', 'imageEmbedding', 'crossModalEmbedding']);
    });

    it('prices images per image', () => {
      const ai = create();
      expect(ai.calculateCost(imageModel, { embeddings: { tokens: 1_000_000, images: 10 } })).toBeCloseTo(0.8 + 0.0006);
    });
  });
});
