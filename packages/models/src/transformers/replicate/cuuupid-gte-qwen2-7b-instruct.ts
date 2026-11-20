import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    text: string[];
  };
  Output: number[];
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
};

export default {
  "cuuupid/gte-qwen2-7b-instruct": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          text: embeddingTexts(request, 'cuuupid/gte-qwen2-7b-instruct'),
          ...request.extra,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => {
          // Runtime output is number[][] (batch of embeddings) despite schema definition
          const embeddings = response as unknown as number[][];
          return {
            embeddings: embeddings.map((embedding, index) => ({
              embedding,
              index,
            })),
          };
        },
      },
    };
    return transformer;
  })(),
}