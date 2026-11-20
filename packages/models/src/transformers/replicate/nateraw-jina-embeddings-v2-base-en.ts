import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';



export default {
  "nateraw/jina-embeddings-v2-base-en": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx) => ({
          texts: JSON.stringify(embeddingTexts(request, 'nateraw/jina-embeddings-v2-base-en')),
          ...request.extra,
        }),
        parseResponse: async (response, ctx) => ({
          embeddings: (response as number[][]).map((embedding, index) => ({
            embedding,
            index,
          })),
        }),
      },
    };
    return transformer;
  })(),
}