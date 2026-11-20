import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    texts?: string[];
  };
  Output: number[][];
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
};

export default {
  "ibm-granite/granite-embedding-278m-multilingual": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          texts: embeddingTexts(request, 'ibm-granite/granite-embedding-278m-multilingual'),
          ...request.extra,
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