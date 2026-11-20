import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    texts?: string;
    batch_size?: number;
    normalize_embeddings?: boolean;
  };
  Output: number[][];
};

export default {
  "beautyyuyanli/multilingual-e5-large": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          texts: JSON.stringify(embeddingTexts(request, 'beautyyuyanli/multilingual-e5-large')),
          batch_size: request.extra?.batch_size,
          normalize_embeddings: request.extra?.normalize_embeddings,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          embeddings: response.map((embedding, index) => ({
            embedding,
            index,
          })),
        }),
      },
    };
    return transformer;
  })(),
}