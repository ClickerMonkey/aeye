import { embeddingTexts } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    task?: string;
    query?: string;
    document: string;
    normalize?: boolean;
  };
  Output: Record<string, never>;
};

export default {
  "adirik/e5-mistral-7b-instruct": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          // The model expects a single document string for the main input.
          // We map the first text in the request to 'document'.
          // 'task' and 'query' can be passed via extra if needed for asymmetric tasks.
          return {
            document: embeddingTexts(request, 'adirik/e5-mistral-7b-instruct')[0],
            ...request.extra,
          };
        },
        parseResponse: async (response: Schemas["Output"], ctx) => {
          // Cast response to any to access the embeddings property not defined in the strict schema type
          const output = response as any;
          return {
            embeddings: (output.embeddings || []).map((embedding: number[], index: number) => ({
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