import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    prompts: string;
    prompt_separator?: string;
  };
  Output: number[][];
};

export default {
  "andreasjansson/llama-2-13b-embeddings": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          const separator = (request.extra?.prompt_separator as string) || "\n\n";
          return {
            prompts: embeddingTexts(request, 'andreasjansson/llama-2-13b-embeddings').join(separator),
            prompt_separator: separator,
            ...request.extra,
          };
        },
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