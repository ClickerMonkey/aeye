import { toURL } from '@aeye/core';
import { ReplicateTransformer } from '@aeye/replicate';

type Schemas = {
  Input: {
    seed?: number;
    steps?: number;
    width?: number;
    height?: number;
    prompt: string;
    guidance?: number;
    interval?: number;
    aspect_ratio?: Schemas["aspect_ratio"];
    image_prompt?: string;
    output_format?: Schemas["output_format"];
    output_quality?: number;
    safety_tolerance?: number;
    prompt_upsampling?: boolean;
  };
  Output: string;
  aspect_ratio: "custom" | "1:1" | "16:9" | "3:2" | "2:3" | "4:5" | "5:4" | "9:16" | "3:4" | "4:3";
  output_format: "webp" | "jpg" | "png";
};

export default {
  "black-forest-labs/flux-pro": (() => {
    const transformer: ReplicateTransformer = {
      imageGenerate: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          const input: Schemas["Input"] = {
            prompt: request.prompt,
            ...request.extra,
          };
          if (request.seed !== undefined) {
            input.seed = request.seed;
          }
          if (request.size) {
            const parts = request.size.split('x').map(Number);
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
              input.width = parts[0];
              input.height = parts[1];
              input.aspect_ratio = "custom";
            }
          }
          if (request.quality) {
            const qualityMap = { auto: 80, low: 60, medium: 80, high: 100, xhigh: 100, max: 100 };
            input.output_quality = qualityMap[request.quality] || 80;
          }
          return input;
        },
        parseResponse: async (response: Schemas["Output"], ctx) => {
          return {
            images: [{ url: await toURL(response) }],
          };
        },
      },
      imageEdit: {
        convertRequest: async (request, ctx): Promise<Schemas["Input"]> => {
          const input: Schemas["Input"] = {
            prompt: request.prompt,
            image_prompt: await toURL(request.image),
            ...request.extra,
          };
          if (request.seed !== undefined) {
            input.seed = request.seed;
          }
          return input;
        },
        parseResponse: async (response: Schemas["Output"], ctx) => {
          return {
            images: [{ url: await toURL(response) }],
          };
        },
      },
    };
    return transformer;
  })()
}