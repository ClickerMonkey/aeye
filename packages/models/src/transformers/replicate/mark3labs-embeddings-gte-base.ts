import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    text: string;
  };
  Output: {
    text: string;
    vectors: number[];
  };
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
};

export default {
  "mark3labs/embeddings-gte-base": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          text: embeddingTexts(request, 'mark3labs/embeddings-gte-base')[0],
          ...request.extra,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          embeddings: [{
            embedding: response.vectors,
            index: 0,
          }],
        }),
      },
    };
    return transformer;
  })(),
}