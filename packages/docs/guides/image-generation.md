# Image Generation

Generate and edit images using AI models through a unified API.

## Generate Images

```typescript
const response = await ai.image.generate.get({
  prompt: 'A serene mountain landscape at sunset, digital art',
  size: '1024x1024',
  quality: 'high',
  n: 1,
});

console.log(response.images[0].url);
// or response.images[0].b64_json for base64-encoded images
```

## Request Options

Generation and editing share `ImageOutputOptions`:

```typescript
interface ImageOutputOptions {
  prompt: string;           // description of the image or edit
  n?: number;               // number of images
  size?: string;            // WIDTHxHEIGHT or 'auto'; the nearest size the model supports is used
  quality?: ImageQuality;   // 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  background?: 'transparent' | 'opaque' | 'auto';
  outputFormat?: 'png' | 'jpeg' | 'webp';
  outputCompression?: number; // 0-100, for jpeg and webp
  responseFormat?: 'url' | 'b64_json'; // for models that can return URLs
  streamCount?: number;     // partial images to stream
  seed?: number;
  userIdentifier?: string;
}

interface ImageGenerationRequest extends ImageOutputOptions {
  style?: 'vivid' | 'natural';   // for models that have styles
  moderation?: 'auto' | 'low';   // content moderation strictness
}
```

Models accept different subsets of the quality levels.

## Edit Images

```typescript
const response = await ai.image.edit.get({
  image: './photo.png',               // source image
  references: ['./style.png'],        // optional extra input images
  prompt: 'Add a rainbow in the sky in the style of the reference',
  mask: './mask.png',                 // optional mask over the source image
  inputFidelity: 'high',              // 'low' | 'high': how closely to keep input details
  size: '1024x1024',
});
```

## Streaming

Image generation supports streaming for progress updates:

```typescript
for await (const chunk of ai.image.generate.stream({
  prompt: 'A cat wearing a hat',
  streamCount: 2,
})) {
  // Chunks may include partial images or progress info
  console.log(chunk);
}
```

## Provider Support

| Provider | Models | Features |
|----------|--------|----------|
| OpenAI | GPT Image (default `gpt-image-2`) | Generate, edit with references and mask, stream, output format/compression |
| OpenRouter | Image-output models (default `google/gemini-2.5-flash-image`) | Generate and edit through chat with the image modality; `size` becomes an aspect ratio; no streaming |
| Replicate | SDXL, Flux, etc. | Generate (via adapters) |
| AWS Bedrock | Stability AI SD3, SDXL | Generate |

## Model Selection

```typescript
// Use a specific model
const response = await ai.image.generate.get(
  { prompt: 'A sunset' },
  { metadata: { model: 'gpt-image-2' } }
);

// Let @aeye select based on capabilities
const response = await ai.image.generate.get(
  { prompt: 'A sunset' },
  { metadata: { required: ['image'] } }
);
```
