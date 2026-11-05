# Image Analysis (Vision)

Analyze images using AI models that support vision capabilities.

## Basic Usage

```typescript
const response = await ai.image.analyze.get({
  images: ['./photo.jpg'],
  prompt: 'Describe what you see in this image.',
});

console.log(response.content);
```

## Multiple Images

```typescript
const response = await ai.image.analyze.get({
  images: ['./before.jpg', './after.jpg'],
  prompt: 'Compare these two images and describe the differences.',
});
```

## Image Sources

Images can be provided as:

```typescript
// URL
{ images: ['https://example.com/image.jpg'] }

// Local file path
{ images: ['./photo.png'] }

// Base64 data URI
{ images: ['data:image/png;base64,iVBOR...'] }

// Buffer
{ images: [fs.readFileSync('./photo.png')] }
```

## Via Chat API

Vision works through the chat API with multi-modal messages:

```typescript
const response = await ai.chat.get({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', content: 'What breed is this dog?' },
      { type: 'image', content: './dog.jpg' },
    ],
  }],
});
```

Image and file parts take an optional `detail` (`'auto' | 'low' | 'high' | 'original'`) for how closely the model should look.

## In Tools

Process images within tool calls:

```typescript
const analyzeImage = ai.tool({
  name: 'analyzeImage',
  description: 'Analyze an image',
  schema: z.object({
    path: z.string(),
    question: z.string(),
  }),
  call: async ({ path, question }, _refs, ctx) => {
    const response = await ctx.ai.image.analyze.get({
      images: [path],
      prompt: question,
    });
    return { analysis: response.content };
  },
});
```

## Provider Support

| Provider | Models |
|----------|--------|
| OpenAI | GPT-5.x, GPT-6, GPT-4.1, GPT-4o (image analysis defaults to `gpt-5.4-mini`) |
| OpenRouter | Claude, Gemini, GPT, and more (image analysis defaults to `openai/gpt-5.4-mini`) |
| AWS Bedrock | Claude 3 (Sonnet, Haiku, Opus) |

Models are automatically selected when the `vision` capability is required:

```typescript
const response = await ai.chat.get(
  { messages: [{ role: 'user', content: [
    { type: 'text', content: 'Describe this' },
    { type: 'image', content: imageUrl },
  ]}]},
  { metadata: { required: ['vision'] } }
);
```
