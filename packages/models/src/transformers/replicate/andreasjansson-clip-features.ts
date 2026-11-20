import { embeddingInputs, isEmbeddingImage } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';
import { toURL } from '@aeye/core';

type Schemas = {
  Input: {
    inputs?: string;
  };
  Output: Schemas["NamedEmbedding"][];
  NamedEmbedding: {
    input: string;
    embedding: number[];
  };
};

export default {
  "andreasjansson/clip-features": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        // Newline-separated texts and image URLs, embedded in CLIP's shared space
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          const lines = await Promise.all(embeddingInputs(request).map(async (input) => {
            if (!isEmbeddingImage(input)) {
              return input;
            }
            const url = await toURL(input.image, input.mimeType ?? 'image/png');
            if (!/^https?:\/\//.test(url)) {
              throw new Error('andreasjansson/clip-features takes images as http(s) URLs only');
            }
            return url;
          }));
          return {
            inputs: lines.join('\n'),
            ...request.extra,
          };
        },
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          embeddings: response.map((item, index) => ({
            embedding: item.embedding,
            index,
          })),
        }),
      },
    };
    return transformer;
  })(),
}
