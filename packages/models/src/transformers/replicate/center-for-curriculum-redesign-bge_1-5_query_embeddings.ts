import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    normalize?: boolean;
    precision?: Schemas["precision"];
    query_texts?: string;
    batchtoken_max?: number;
  };
  Output: {
    extra_metrics: string;
    query_embeddings: number[][];
  };
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
  precision: "full" | "half";
};

export default {
  "center-for-curriculum-redesign/bge_1-5_query_embeddings": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          query_texts: JSON.stringify(embeddingTexts(request, 'center-for-curriculum-redesign/bge_1-5_query_embeddings')),
          ...request.extra,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          embeddings: response.query_embeddings.map((embedding, index) => ({
            embedding,
            index,
          })),
        }),
      },
    };
    return transformer;
  })(),
}