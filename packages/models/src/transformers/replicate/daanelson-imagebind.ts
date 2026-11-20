import { embeddingImageURL, isEmbeddingImage, singleEmbeddingInput } from '@aeye/ai';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    input?: string;
    modality?: Schemas["modality"];
    text_input?: string;
  };
  Output: number[];
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
  modality: "text" | "vision" | "audio";
};

export default {
  "daanelson/imagebind": (() => {
    const transformer: ReplicateTransformer = {
      embed: {
        // One text or one image per call, in ImageBind's shared space
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          const input = singleEmbeddingInput(request, 'daanelson/imagebind');
          return {
            ...(isEmbeddingImage(input)
              ? { input: await embeddingImageURL(input), modality: "vision" }
              : { text_input: input, modality: "text" }),
            ...request.extra,
          };
        },
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          embeddings: [{
            embedding: response,
            index: 0
          }],
        }),
      },
    };
    return transformer;
  })()
}
