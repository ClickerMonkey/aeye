# ImageAPI

Image generation, editing, and analysis APIs.

## `ai.image.generate`

### `get(request, ctx?)`

```typescript
const response = await ai.image.generate.get({
  prompt: 'A sunset over mountains',
  size: '1024x1024',
  quality: 'high',
  n: 1,
});
```

### `stream(request, ctx?)`

Stream image generation progress.

### Request: `ImageGenerationRequest`

```typescript
interface ImageGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  size?: string;
  quality?: string;
  style?: string;
  format?: string;
  n?: number;
  background?: string;
}
```

### Response: `ImageGenerationResponse`

```typescript
interface ImageGenerationResponse {
  images: Array<{
    url?: string;
    base64?: string;
    revisedPrompt?: string;
  }>;
  usage?: Usage;
}
```

## `ai.image.edit`

### `get(request, ctx?)`

```typescript
const response = await ai.image.edit.get({
  image: './photo.png',
  prompt: 'Add a hat to the person',
  mask: './mask.png',
  size: '1024x1024',
});
```

### Request: `ImageEditRequest`

```typescript
interface ImageEditRequest {
  image: Resource;
  prompt: string;
  mask?: Resource;
  size?: string;
  quality?: string;
  n?: number;
}
```

## `ai.image.analyze`

### `get(request, ctx?)`

```typescript
const response = await ai.image.analyze.get({
  images: ['./photo.jpg'],
  prompt: 'Describe this image',
});
```

### Request: `ImageAnalyzeRequest`

```typescript
interface ImageAnalyzeRequest {
  images: Resource[];
  prompt: string;
  maxCharacters?: number;
}
```
