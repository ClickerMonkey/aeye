import { embeddingImageURL, isEmbeddingImage, singleEmbeddingInput } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    text?: string;
    image?: string;
  };
  Output: {
    embedding: number[];
  };
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
};

export default {
  "krthr/clip-embeddings": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        // One text or one image per call, both in CLIP's shared space
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          const input = singleEmbeddingInput(request, 'krthr/clip-embeddings');
          return {
            ...(isEmbeddingImage(input) ? { image: await embeddingImageURL(input) } : { text: input }),
            ...request.extra,
          };
        },
        parseResponse: async (response: Schemas["Output"], ctx) => {
          return {
            embeddings: [
              {
                embedding: response.embedding,
                index: 0,
              },
            ],
          };
        },
      },
    };
    return transformer;
  })(),
}
