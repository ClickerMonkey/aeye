import { toURL } from '@aeye/core';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    prompt: string;
    quality?: Schemas["quality"];
    user_id?: string | null;
    background?: Schemas["background"];
    moderation?: Schemas["moderation"];
    aspect_ratio?: Schemas["aspect_ratio"];
    input_images?: string[] | null;
    output_format?: Schemas["output_format"];
    input_fidelity?: Schemas["input_fidelity"];
    openai_api_key: string;
    number_of_images?: number;
    output_compression?: number;
  };
  Output: string[];
  Status: "starting" | "processing" | "succeeded" | "canceled" | "failed";
  quality: "low" | "medium" | "high" | "auto";
  background: "auto" | "transparent" | "opaque";
  moderation: "auto" | "low";
  aspect_ratio: "1:1" | "3:2" | "2:3";
  output_format: "png" | "jpeg" | "webp";
  input_fidelity: "low" | "high";
};

export default {
  "openai/gpt-image-1": (() => {
    const transformer: ReplicateTransformer = {
      imageGenerate: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          prompt: request.prompt,
          number_of_images: request.n,
          quality: request.quality === 'xhigh' || request.quality === 'max' ? 'high' : request.quality,
          user_id: request.userIdentifier,
          ...request.extra,
          openai_api_key: request.extra?.openai_api_key,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          images: response.map((url) => ({ url })),
        }),
      },
      imageEdit: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => ({
          prompt: request.prompt,
          input_images: [await toURL(request.image)],
          number_of_images: request.n,
          user_id: request.userIdentifier,
          ...request.extra,
          openai_api_key: request.extra?.openai_api_key,
        }),
        parseResponse: async (response: Schemas["Output"], ctx) => ({
          images: response.map((url) => ({ url })),
        }),
      },
    };
    return transformer;
  })(),
}