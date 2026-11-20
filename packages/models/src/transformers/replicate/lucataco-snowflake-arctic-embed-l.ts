import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    prompt?: string;
  };
  Output: number[];
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
};

export default {
  "lucataco/snowflake-arctic-embed-l": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          prompt: embeddingTexts(request, 'lucataco/snowflake-arctic-embed-l')[0],
          ...request.extra,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          embeddings: [
            {
              embedding: response,
              index: 0,
            },
          ],
        }),
      },
    };
    return transformer;
  })(),
}