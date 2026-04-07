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
// or response.images[0].base64 for base64-encoded images
```

## Request Options

```typescript
interface ImageGenerationRequest {
  prompt: string;           // description of the image
  negativePrompt?: string;  // what to avoid
  size?: string;            // e.g., '1024x1024', '1024x1792'
  quality?: string;         // 'standard', 'high', 'hd'
  style?: string;           // 'vivid', 'natural'
  format?: string;          // 'png', 'jpeg', 'webp'
  n?: number;               // number of images
  background?: string;      // background color/style
}
```

## Edit Images

```typescript
const response = await ai.image.edit.get({
  image: './photo.png',       // original image
  prompt: 'Add a rainbow in the sky',
  mask: './mask.png',         // optional mask for inpainting
  size: '1024x1024',
});
```

## Streaming

Image generation supports streaming for progress updates:

```typescript
for await (const chunk of ai.image.generate.stream({
  prompt: 'A cat wearing a hat',
})) {
  // Chunks may include partial images or progress info
  console.log(chunk);
}
```

## Provider Support

| Provider | Models | Features |
|----------|--------|----------|
| OpenAI | DALL-E 2, DALL-E 3 | Generate, edit, variations |
| Replicate | SDXL, Flux, etc. | Generate (via adapters) |
| AWS Bedrock | Stability AI SD3, SDXL | Generate |

## Model Selection

```typescript
// Use a specific model
const response = await ai.image.generate.get(
  { prompt: 'A sunset' },
  { metadata: { model: 'dall-e-3' } }
);

// Let @aeye select based on capabilities
const response = await ai.image.generate.get(
  { prompt: 'A sunset' },
  { metadata: { required: ['image'] } }
);
```
