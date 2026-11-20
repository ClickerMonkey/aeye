import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    path?: string;
    texts?: string;
    batch_size?: number;
    convert_to_numpy?: boolean;
    normalize_embeddings?: boolean;
  };
  Output: string[] | string;
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
};

export default {
  "nateraw/bge-large-en-v1.5": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          texts: JSON.stringify(embeddingTexts(request, 'nateraw/bge-large-en-v1.5')),
          ...request.extra,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => {
          // The schema defines output as string[] | string, but the model returns number[][] for embeddings in JSON mode.
          // We cast to unknown to handle the discrepancy between the OpenAPI definition and actual runtime behavior.
          const data = response as unknown as number[][];
          return {
            embeddings: data.map((embedding, index) => ({
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