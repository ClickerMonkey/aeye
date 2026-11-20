import { embeddingImageURL, isEmbeddingImage, singleEmbeddingInput } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    text?: string;
    image?: string;
    embedding_dim?: number;
    output_format?: Schemas["output_format"];
  };
  Output: (string | number[])[];
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
  output_format: "base64" | "array";
};

export default {
  "zsxkib/jina-clip-v2": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        // One text or one image per call, both in Jina CLIP's shared space
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          const input = singleEmbeddingInput(request, 'zsxkib/jina-clip-v2');
          return {
            ...(isEmbeddingImage(input) ? { image: await embeddingImageURL(input) } : { text: input }),
            embedding_dim: request.dimensions,
            output_format: "array",
            ...request.extra,
          };
        },
        parseResponse: async (response: Schemas["Output"], ctx) => {
          // We requested 'array', so each embedding is number[]
          const embeddings = response.map((emb, index) => ({
            embedding: emb as number[],
            index,
          }));
          return { embeddings };
        },
      },
    };
    return transformer;
  })(),
}
