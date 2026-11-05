# @aeye/openai

OpenAI provider for the @aeye (AI TypeScript) framework. This package provides a comprehensive integration with OpenAI's API, supporting the full range of capabilities including chat completions, image generation, speech synthesis, transcription, and embeddings.

## Features

- **Chat**: GPT-5.x, GPT-6, GPT-4.1 and other chat models, through Chat Completions or the Responses API
- **Vision**: Image and file (PDF) understanding
- **Reasoning**: Efforts `none` through `max`, reasoning summaries, and encrypted reasoning carried across turns
- **Hosted Tools**: Web search, file search, code interpreter, image generation, and remote MCP servers run by OpenAI
- **Image Generation**: GPT Image (`gpt-image-2` by default) for generating and editing images
- **Speech-to-Text**: `gpt-transcribe`, diarization with known speakers, and Whisper
- **Text-to-Speech**: TTS models with built-in or custom voices
- **Audio Output**: Spoken answers from audio-capable chat models
- **Embeddings**: Text embeddings for semantic search and similarity
- **Decisions**: Probabilities, choices, and scores from `/v1/decisions` (`gpt-6-luna`)
- **Batches**: Chat requests as one batch at about half the price
- **Function Calling**: Tool/function calling with automatic schema conversion, free-text and grammar tools, tool search, async tools, and allowed tools
- **Structured Outputs**: JSON mode and schema-based structured outputs
- **Streaming**: Real-time streaming responses for chat completions
- **Multi-modal**: Support for text, images, audio, and files in conversations
- **Extensible**: Base class for OpenAI-compatible providers (Azure OpenAI, OpenRouter, etc.)

## Installation

```bash
npm install @aeye/openai @aeye/ai @aeye/core openai zod
```

Requires Node >= 22 and the `openai` SDK v7.

## Quick Start

```typescript
import { OpenAIProvider } from '@aeye/openai';

// Create provider instance
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

// Create executor
const executor = provider.createExecutor();

// Make a request
const response = await executor(
  {
    messages: [
      { role: 'user', content: 'Tell me a joke about TypeScript' }
    ]
  },
  {},
  { model: 'gpt-5.4-mini' }
);

console.log(response.content);
```

## Configuration

### Basic Configuration

```typescript
import { OpenAIProvider, OpenAIConfig } from '@aeye/openai';

const config: OpenAIConfig = {
  apiKey: process.env.OPENAI_API_KEY!,
  organization: 'org-123456', // Optional: for multi-org accounts
};

const provider = new OpenAIProvider(config);
```

### Chat Completions or Responses API

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  api: 'auto', // 'auto' (default) | 'chat' | 'responses'
});
```

With `'auto'`, chat uses Chat Completions unless the model is Responses-only (codex, pre-5.6 pro models, deep-research, computer-use), the request has `hostedTools`, a tool sets `format`, `defer`, or `async`, or `reason` sets `mode`, `summary`, or `context`. Through Responses, reasoning comes back encrypted (unless `store` is on) and is replayed on later turns.

### Custom Base URL (for Azure OpenAI or compatible APIs)

```typescript
const provider = new OpenAIProvider({
  apiKey: process.env.AZURE_API_KEY!,
  baseURL: 'https://your-resource.openai.azure.com/openai/deployments/your-deployment',
});
```

## Usage Examples

### Chat Completions

#### Basic Chat

```typescript
const executor = provider.createExecutor();

const response = await executor(
  {
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is the capital of France?' }
    ],
    temperature: 0.7,
    maxTokens: 150,
  },
  {},
  { model: 'gpt-5.4-mini' }
);

console.log(response.content);
console.log('Tokens used:', response.usage.totalTokens);
```

#### Streaming Chat

```typescript
const streamer = provider.createStreamer();

for await (const chunk of streamer(
  {
    messages: [
      { role: 'user', content: 'Write a short story about a robot' }
    ]
  },
  {},
  { model: 'gpt-5.4-mini' }
)) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }
}
```

#### Multi-turn Conversation

```typescript
const conversation = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: 'What is TypeScript?' },
];

// First response
let response = await executor(
  { messages: conversation },
  {},
  { model: 'gpt-5.4-mini' }
);

conversation.push({ role: 'assistant', content: response.content });
conversation.push({ role: 'user', content: 'Can you give me an example?' });

// Second response
response = await executor(
  { messages: conversation },
  {},
  { model: 'gpt-5.4-mini' }
);
```

### Vision

#### Analyze an Image

```typescript
const response = await executor(
  {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', content: 'What is in this image?' },
          {
            type: 'image',
            content: 'https://example.com/image.jpg',
            // Or use base64: content: 'data:image/jpeg;base64,/9j/4AAQ...'
          }
        ]
      }
    ]
  },
  {},
  { model: 'gpt-5.4-mini' }
);
```

#### Multiple Images

```typescript
const response = await executor(
  {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', content: 'Compare these two images' },
          { type: 'image', content: 'https://example.com/image1.jpg' },
          { type: 'image', content: 'https://example.com/image2.jpg' }
        ]
      }
    ]
  },
  {},
  { model: 'gpt-5.4-mini' }
);
```

### Function Calling

#### Define and Use Tools

```typescript
import z from 'zod';

const response = await executor(
  {
    messages: [
      { role: 'user', content: 'What is the weather like in San Francisco?' }
    ],
    tools: [
      {
        name: 'get_current_weather',
        description: 'Get the current weather in a given location',
        parameters: z.object({
          location: z.string().describe('The city and state, e.g., San Francisco, CA'),
          unit: z.enum(['celsius', 'fahrenheit']).optional(),
        }),
      }
    ],
    toolChoice: 'auto', // 'auto', 'required', 'none', { tool: 'tool_name' }, or { allowed: ['tool_name'], required? }
  },
  {},
  { model: 'gpt-5.4-mini' }
);

if (response.toolCalls) {
  for (const toolCall of response.toolCalls) {
    console.log('Tool:', toolCall.name);
    console.log('Arguments:', JSON.parse(toolCall.arguments));

    // Execute the function and send result back
    const functionResult = await getWeather(JSON.parse(toolCall.arguments));

    const finalResponse = await executor(
      {
        messages: [
          { role: 'user', content: 'What is the weather like in San Francisco?' },
          { role: 'assistant', content: '', toolCalls: [toolCall] },
          {
            role: 'tool',
            content: JSON.stringify(functionResult),
            toolCallId: toolCall.id,
          }
        ]
      },
      {},
      { model: 'gpt-5.4-mini' }
    );
  }
}
```

#### Force Specific Tool

```typescript
const response = await executor(
  {
    messages: [
      { role: 'user', content: 'Get the weather for Boston' }
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather information',
        parameters: z.object({
          location: z.string(),
        }),
      }
    ],
    toolChoice: { tool: 'get_weather' }, // Force this specific tool
  },
  {},
  { model: 'gpt-5.4-mini' }
);
```

### Structured Outputs

#### JSON Mode

```typescript
const response = await executor(
  {
    messages: [
      {
        role: 'user',
        content: 'List three famous scientists and their main contributions in JSON format'
      }
    ],
    responseFormat: 'json', // Ensures valid JSON output
  },
  {},
  { model: 'gpt-5.4-mini' }
);

const scientists = JSON.parse(response.content);
```

#### Schema-based Structured Output

```typescript
import z from 'zod';

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
  occupation: z.string(),
  hobbies: z.array(z.string()),
});

const response = await executor(
  {
    messages: [
      {
        role: 'user',
        content: 'Generate a profile for a fictional software engineer'
      }
    ],
    responseFormat: PersonSchema, // Strict schema enforcement
  },
  {},
  { model: 'gpt-5.4-mini' }
);

// Response is guaranteed to match the schema
const person = JSON.parse(response.content);
console.log(person.name, person.age); // Type-safe
```

### Image Generation (GPT Image)

#### Generate an Image

```typescript
const imageResponse = await provider.generateImage(
  {
    prompt: 'A serene landscape with mountains and a lake at sunset',
    model: 'gpt-image-2', // the default
    size: '1024x1024',    // or 'auto'; other sizes snap to the nearest the model supports
    quality: 'high',      // 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' (per model)
    outputFormat: 'webp', // 'png' | 'jpeg' | 'webp'
    outputCompression: 80, // 0-100, for jpeg and webp
    background: 'transparent',
    n: 1,
  },
  {}
);

const base64Image = imageResponse.images[0].b64_json;
```

#### Edit with Reference Images

```typescript
const edited = await provider.editImage(
  {
    prompt: 'Put the product from the second image on the table in the first',
    image: fs.readFileSync('room.png'),        // source image
    references: [fs.readFileSync('product.png')], // more input images
    mask: fs.readFileSync('mask.png'),         // optional, over the source image
    inputFidelity: 'high',                     // keep input details closely
  },
  {}
);
```

Usage reports the quality and size actually produced, so per-image pricing applies; GPT Image 2 and later report output image tokens in `usage.image.tokens`.

### Speech Synthesis (TTS)

#### Generate Speech

```typescript
import fs from 'fs';
import { Readable } from 'stream';

const speechResponse = await provider.generateSpeech(
  {
    text: 'Hello! This is a text-to-speech example using OpenAI.',
    model: 'gpt-4o-mini-tts', // the default
    voice: 'alloy', // any built-in voice name or a custom voice id
    instructions: 'Speak warmly and a little slowly.',
    speed: 1.0, // 0.25 to 4.0
    responseFormat: 'mp3', // mp3, opus, aac, flac, wav, pcm
  },
  {}
);

// Save to file
Readable.fromWeb(speechResponse.audio).pipe(fs.createWriteStream('output.mp3'));
console.log('Audio saved to output.mp3');
```

#### Different Voices

```typescript
const voices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

for (const voice of voices) {
  const response = await provider.generateSpeech(
    {
      text: `This is the ${voice} voice speaking.`,
      voice,
      model: 'gpt-4o-mini-tts',
    },
    {}
  );

  Readable.fromWeb(response.audio).pipe(fs.createWriteStream(`voice_${voice}.mp3`));
}
```

### Transcription

#### Transcribe Audio File

```typescript
import fs from 'fs';

const audioBuffer = fs.readFileSync('audio.mp3');

const transcription = await provider.transcribe(
  {
    audio: audioBuffer,
    model: 'gpt-transcribe', // the default
    language: 'en', // Optional: ISO-639-1 language code
    prompt: 'This is a podcast about AI and technology', // Optional: context
  },
  {}
);

console.log('Transcription:', transcription.text);
```

#### Transcribe with Timestamps

```typescript
const transcription = await provider.transcribe(
  {
    audio: audioBuffer,
    model: 'whisper-1',
    responseFormat: 'verbose_json',
    timestampGranularities: ['word', 'segment'],
  },
  {}
);

console.log('Full text:', transcription.text);

// Segment-level timestamps
transcription.segments?.forEach(segment => {
  console.log(`${segment.text}: ${segment.start}s - ${segment.end}s`);
});
```

#### Speaker Diarization

```typescript
const transcription = await provider.transcribe(
  {
    audio: fs.readFileSync('meeting.mp3'),
    model: 'gpt-4o-transcribe-diarize',
    responseFormat: 'diarized_json',
    knownSpeakers: [
      { name: 'Alice', audio: fs.readFileSync('alice.wav') },
      { name: 'Bob', audio: fs.readFileSync('bob.wav') },
    ],
  },
  {}
);

transcription.segments?.forEach(segment => {
  console.log(`${segment.speaker}: ${segment.text}`);
});
```

#### Different Output Formats

```typescript
// Plain text
const text = await provider.transcribe(
  { audio: audioBuffer, responseFormat: 'text' },
  {}
);

// SRT subtitles
const srt = await provider.transcribe(
  { audio: audioBuffer, responseFormat: 'srt' },
  {}
);

// VTT subtitles
const vtt = await provider.transcribe(
  { audio: audioBuffer, responseFormat: 'vtt' },
  {}
);
```

### Embeddings

#### Generate Embeddings

```typescript
const embeddingResponse = await provider.embed(
  {
    texts: [
      'The quick brown fox jumps over the lazy dog',
      'Machine learning is a subset of artificial intelligence',
      'OpenAI develops advanced AI models'
    ],
    model: 'text-embedding-3-small', // or 'text-embedding-3-large'
  },
  {}
);

embeddingResponse.embeddings.forEach((item, i) => {
  console.log(`Embedding ${i}:`, item.embedding.length, 'dimensions');
});

console.log('Tokens used:', embeddingResponse.usage?.text?.input);
```

#### Custom Dimensions (for smaller embeddings)

```typescript
const embeddingResponse = await provider.embed(
  {
    texts: ['Some text to embed'],
    model: 'text-embedding-3-large',
    dimensions: 256, // Reduce from default 3072 to 256
  },
  {}
);
```

#### Calculate Similarity

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (magnitudeA * magnitudeB);
}

const response = await provider.embed(
  {
    texts: [
      'I love programming in TypeScript',
      'TypeScript is my favorite language',
      'I enjoy cooking Italian food'
    ],
    model: 'text-embedding-3-small',
  },
  {}
);

const [emb1, emb2, emb3] = response.embeddings.map(e => e.embedding);

console.log('Similarity 1-2:', cosineSimilarity(emb1, emb2)); // High similarity
console.log('Similarity 1-3:', cosineSimilarity(emb1, emb3)); // Low similarity
```

### Reasoning

```typescript
const response = await executor(
  {
    messages: [
      {
        role: 'user',
        content: 'Solve this logic puzzle: There are 100 doors, all closed. You make 100 passes. On pass 1, toggle all doors. On pass 2, toggle every 2nd door. On pass 3, toggle every 3rd door, etc. Which doors are open after 100 passes?'
      }
    ],
    reason: {
      effort: 'high',     // 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      summary: 'auto',    // a readable summary (uses the Responses API)
    },
  },
  {},
  { model: 'gpt-5.5' }
);

console.log('Reasoning:', response.reasoning?.content);
console.log('Answer:', response.content);
```

- The effort is clamped to the model's accepted efforts when its `ModelInfo.reasoningEfforts` lists them.
- `mode`, `summary`, or `context` send the request to the Responses API. There, reasoning comes back encrypted (`openai-responses-v1` details) unless `store` is on; keep the assistant message's `reasoning` in the conversation and it is replayed on the next turn.
- `reason.maxTokens` and `reason.exclude` are not used by OpenAI.

### Hosted Tools

Tools OpenAI runs itself go in `hostedTools` and use the Responses API:

```typescript
const response = await executor(
  {
    messages: [{ role: 'user', content: 'Summarize this week\'s TypeScript news.' }],
    hostedTools: [
      { type: 'web_search', allowedDomains: ['devblogs.microsoft.com'] },
      { type: 'code_interpreter' },
      { type: 'file_search', vectorStoreIds: ['vs_123'], maxResults: 5 },
      { type: 'mcp', label: 'docs', url: 'https://example.com/mcp', allowedTools: ['search'] },
      { type: 'image_generation' },
    ],
  },
  {},
  { model: 'gpt-5.4-mini' }
);

console.log(response.citations); // [{ url, title, start, end }]
console.log(response.usage?.tools); // { web_search: 1, ... }
```

`web_fetch` is not available on OpenAI (web search fetches pages itself), and web search can only allow domains, not block them (`blockedDomains` is rejected). Images from `image_generation` come back on `response.images`.

### Audio Output

```typescript
const response = await executor(
  {
    messages: [{ role: 'user', content: 'Say hello in French.' }],
    modalities: ['text', 'audio'],
    audio: { voice: 'alloy', format: 'mp3' }, // streaming defaults to pcm
  },
  {},
  { model: 'gpt-audio-1.5' }
);

console.log(response.audio?.transcript); // response.audio.data is base64
```

### Other Request Options

- `seed`, `verbosity` (`'low' | 'medium' | 'high'`), `serviceTier` (`'auto' | 'default' | 'flex' | 'fast' | 'scale'`), and `metadata` are passed through. Chat Completions sends `metadata` only when `store` is on.
- `moderate: true` runs inline moderation (`omni-moderation-latest`); verdicts come back on `response.moderation`.
- Content parts take `cacheBreakpoint` (a prompt cache breakpoint), `detail` for images, and `name` for files.
- `response.serviceTier` reports the tier used (`priority` reads as `fast`).

### Tool Features

- `toolChoice: { allowed: [...], required? }` is sent as `allowed_tools` on both APIs: every tool is still sent (keeping the prompt cacheable), but only the allowed ones may be called.
- A tool with `format: { type: 'text' }` or `format: { type: 'grammar', syntax: 'lark' | 'regex', definition }` is a Responses custom tool: the model writes free text, constrained by the grammar, and it arrives as `{ input }` arguments (`TEXT_TOOL_SCHEMA` from `@aeye/core`). With `api: 'chat'` it is a one-field function whose description carries the grammar.
- `defer: true` sends the tool with `defer_loading` and adds the hosted `tool_search` tool, so it is loaded only when the model searches for it.
- `async: true` marks an async tool; the model keeps working while it runs.

```typescript
import { TEXT_TOOL_SCHEMA } from '@aeye/core';

const response = await executor(
  {
    messages: [{ role: 'user', content: 'How many orders did customer 42 place?' }],
    tools: [{
      name: 'sql',
      description: 'Run a read-only SQL query',
      parameters: TEXT_TOOL_SCHEMA,
      format: { type: 'grammar', syntax: 'regex', definition: 'SELECT [^;]+;' },
    }],
  },
  {},
  { model: 'gpt-5.4-mini' }
);

console.log(response.toolCalls?.[0]?.arguments); // {"input":"SELECT COUNT(*) FROM orders WHERE customer_id = 42;"}
```

### Decisions

Typed answers from `/v1/decisions` (default model `gpt-6-luna`, or `defaultModels.decision`), through `ai.decide`:

```typescript
import { AI } from '@aeye/ai';

const ai = AI.with().providers({ openai: provider }).create({});

const { answers } = await ai.decide.get({
  input: 'I was charged twice for my order.',
  questions: {
    billing: { type: 'predicate', instructions: 'Is this a billing problem?' },
    urgency: { type: 'score', instructions: 'How urgent is it?', levels: ['Can wait', 'This week', 'Now'] },
  },
});
```

Decisions report through the `decide` hooks.

### Batches

`ai.batch` uploads chat requests as a JSONL file and runs them as one batch with a 24 hour window, at about half the price. Results come back in request order; a failed request has `error`.

```typescript
const job = await ai.batch.submit(
  questions.map(question => ({ messages: [{ role: 'user', content: question }] })),
  { metadata: { model: 'gpt-5.4-mini' } },
);

const done = await ai.batch.wait(job, {});
done.results?.forEach(result => console.log(result.response?.content ?? result.error));
```

### Advanced Features

#### Abort Requests

```typescript
const controller = new AbortController();

// Set timeout
setTimeout(() => controller.abort(), 5000);

try {
  const response = await executor(
    { messages: [{ role: 'user', content: 'Tell me a long story' }] },
    {},
    { model: 'gpt-5.4-mini' },
    controller.signal
  );
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Request was aborted');
  }
}
```

#### List Available Models

```typescript
const models = await provider.listModels();

models.forEach(model => {
  console.log(`${model.id}: ${model.capabilities}`);
  console.log(`  Context window: ${model.contextWindow}`);
  console.log(`  Pricing: $${model.pricing.text.input}/1M input tokens`);
});
```

#### Check Provider Health

```typescript
const isHealthy = await provider.checkHealth();
console.log('OpenAI API is', isHealthy ? 'accessible' : 'not accessible');
```

#### Default Metadata

```typescript
// Set default metadata for all requests
provider.defaultMetadata = {
  model: 'gpt-5.4-mini',
  user: 'user-123',
};

// Now model is automatically set
const response = await executor(
  { messages: [{ role: 'user', content: 'Hello' }] },
  {}
  // No need to pass { model: 'gpt-5.4-mini' }
);
```

## Extending for Custom Providers

The `OpenAIProvider` class can be extended to support OpenAI-compatible APIs like Azure OpenAI, OpenRouter, or custom deployments.

### Example: Custom Provider

```typescript
import type { Request } from '@aeye/core';
import { OpenAIProvider, OpenAIConfig } from '@aeye/openai';
import OpenAI from 'openai';

interface CustomConfig extends OpenAIConfig {
  customOption?: string;
}

class CustomProvider extends OpenAIProvider<CustomConfig> {
  readonly name = 'custom-provider';

  protected createClient(config: CustomConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://api.custom-provider.com/v1',
      defaultHeaders: {
        'X-Custom-Header': config.customOption || '',
      },
    });
  }

  protected augmentChatRequest<TParams extends OpenAI.Chat.ChatCompletionCreateParams>(
    params: TParams,
    request: Request,
    config: CustomConfig,
  ) {
    // Add custom parameters (mutate in place)
    Object.assign(params, { custom_param: config.customOption });
  }
}

// Use the custom provider
const customProvider = new CustomProvider({
  apiKey: process.env.CUSTOM_API_KEY!,
  customOption: 'value',
});
```

### Example: Azure OpenAI

```typescript
class AzureOpenAIProvider extends OpenAIProvider {
  readonly name = 'azure-openai';

  protected createClient(config: OpenAIConfig): OpenAI {
    return new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL, // Azure endpoint
      defaultQuery: { 'api-version': '2024-02-01' },
    });
  }
}

const azureProvider = new AzureOpenAIProvider({
  apiKey: process.env.AZURE_OPENAI_KEY!,
  baseURL: 'https://your-resource.openai.azure.com/openai/deployments/your-deployment',
});
```

## Configuration Options

### OpenAIConfig

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `apiKey` | `string` | Yes | OpenAI API key |
| `baseURL` | `string` | No | Custom base URL for API endpoint |
| `organization` | `string` | No | OpenAI organization ID |
| `project` | `string` | No | OpenAI project ID |
| `store` | `boolean` | No | Let OpenAI store requests (default `false`) |
| `api` | `'auto' \| 'chat' \| 'responses'` | No | Which API chat uses (default `'auto'`) |
| `retry` / `retryEvents` | `RetryConfig` / `RetryEvents` | No | Retry behavior and events |
| `hooks` | `OpenAIHooks` | No | `beforeRequest` / `afterRequest` / `onError` for `chat`, `responses`, `imageGenerate`, `imageEdit`, `transcribe`, `speech`, `embed` |
| `defaultModels` | `object` | No | Per-operation defaults; built in: `gpt-image-2` (generate, edit), `gpt-5.4-mini` (image analysis), `gpt-transcribe`, `gpt-4o-mini-tts`, `text-embedding-3-small`, `gpt-6-luna` (decision); `rerank` has no OpenAI default |

### Request Parameters

#### Chat Completion Request

| Parameter | Type | Description |
|-----------|------|-------------|
| `messages` | `Message[]` | Array of conversation messages |
| `temperature` | `number` | Sampling temperature (0-2) |
| `topP` | `number` | Nucleus sampling parameter |
| `maxTokens` | `number` | Maximum tokens to generate |
| `stop` | `string \| string[]` | Stop sequences |
| `tools` | `Tool[]` | Function definitions for tool calling |
| `toolChoice` | `'auto' \| 'required' \| 'none' \| { tool: string } \| { allowed: string[]; required?: boolean }` | Tool selection mode |
| `responseFormat` | `'text' \| 'json' \| ZodSchema` | Response format constraint |
| `reason` | `Reason` | `{ effort, summary, mode, context }` |
| `seed` / `verbosity` / `serviceTier` / `metadata` | | Passed through |
| `modalities` / `audio` | | Audio output |
| `hostedTools` | `HostedTool[]` | Tools OpenAI runs (Responses API) |
| `moderate` | `boolean` | Inline moderation |

#### Image Generation Request

| Parameter | Type | Description |
|-----------|------|-------------|
| `prompt` | `string` | Text description of desired image |
| `model` | `string` | GPT Image model (default gpt-image-2) |
| `size` | `string` | `WIDTHxHEIGHT` or `'auto'`; snaps to the model's sizes |
| `quality` | `'auto' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | Image quality (models accept subsets) |
| `background` | `'transparent' \| 'opaque' \| 'auto'` | Background |
| `outputFormat` | `'png' \| 'jpeg' \| 'webp'` | Encoding |
| `outputCompression` | `number` | 0-100, for jpeg and webp |
| `moderation` | `'auto' \| 'low'` | Moderation strictness (generate) |
| `references` / `mask` / `inputFidelity` | | Extra input images, mask, and detail preservation (edit) |
| `n` | `number` | Number of images to generate |
| `streamCount` | `number` | Partial images to stream |

#### Transcription Request

| Parameter | Type | Description |
|-----------|------|-------------|
| `audio` | `Buffer \| string \| Blob` | Audio file to transcribe |
| `model` | `string` | Model to use (default gpt-transcribe) |
| `language` | `string` | ISO-639-1 language code |
| `prompt` | `string` | Context for better accuracy |
| `responseFormat` | `'json' \| 'text' \| 'srt' \| 'vtt' \| 'verbose_json' \| 'diarized_json'` | Output format |
| `knownSpeakers` | `{ name, audio }[]` | Reference clips for diarization |
| `timestampGranularities` | `('word' \| 'segment')[]` | Timestamp detail level |
| `temperature` | `number` | Sampling temperature |

#### Speech Synthesis Request

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | `string` | Text to convert to speech |
| `model` | `string` | Model to use (default gpt-4o-mini-tts) |
| `voice` | `string` | Built-in voice name or custom voice id (default alloy) |
| `instructions` | `string` | Style instructions |
| `speed` | `number` | Playback speed (0.25-4.0) |
| `responseFormat` | `'mp3' \| 'opus' \| 'aac' \| 'flac' \| 'wav' \| 'pcm'` | Audio format |

#### Embedding Request

| Parameter | Type | Description |
|-----------|------|-------------|
| `texts` | `string[]` | Texts to embed |
| `model` | `string` | Model to use (text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002) |
| `dimensions` | `number` | Output dimensions (embedding-3 models only) |
| `encodingFormat` | `'float' \| 'base64'` | Encoding format |

## Error Handling

The provider throws specific error types for different failure scenarios:

```typescript
import { ProviderError, RateLimitError, ProviderAuthError } from '@aeye/openai';

try {
  const response = await executor(
    { messages: [{ role: 'user', content: 'Hello' }] },
    {},
    { model: 'gpt-5.4-mini' }
  );
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error('Rate limit exceeded');
    if (error.retryAfter) {
      console.log(`Retry after ${error.retryAfter} seconds`);
    }
  } else if (error instanceof ProviderAuthError) {
    console.error('Authentication failed - check your API key');
  } else if (error instanceof ProviderError) {
    console.error(`Provider error: ${error.message}`);
    console.error('Original error:', error.cause);
  }
}
```

### Error Types

- **`ProviderError`**: Base error for all provider-related errors
- **`ProviderAuthError`**: Authentication/authorization failures
- **`RateLimitError`**: Rate limit exceeded (includes `retryAfter` if available)
- **`ProviderRateLimitError`**: Specialized rate limit error
- **`ProviderQuotaError`**: Quota/usage limit exceeded

## API Reference

### OpenAIProvider

Main provider class implementing the @aeye Provider interface.

**Constructor**: `new OpenAIProvider(config: OpenAIConfig)`

**Methods**:
- `listModels(config?: TConfig): Promise<ModelInfo[]>` - List available models
- `checkHealth(config?: TConfig): Promise<boolean>` - Check API health
- `createExecutor<TContext, TMetadata>(config?: TConfig): Executor` - Create chat executor
- `createStreamer<TContext, TMetadata>(config?: TConfig): Streamer` - Create streaming executor
- `generateImage<TContext>(request, ctx, config?): Promise<ImageGenerationResponse>` - Generate images
- `editImage<TContext>(request, ctx, config?): Promise<ImageGenerationResponse>` - Edit images
- `transcribe<TContext>(request, ctx, config?): Promise<TranscriptionResponse>` - Transcribe audio
- `speech(request, ctx, config?): Promise<SpeechResponse>` - Generate speech
- `embed<TContext>(request, ctx, config?): Promise<EmbeddingResponse>` - Generate embeddings
- `decide(request, ctx, config?): Promise<DecisionResponse>` - Answer decision questions
- `submitBatch(requests, ctx, config?): Promise<BatchJob>` / `getBatch(job, ctx, config?): Promise<BatchJob>` - Run and read batches

**Protected Methods** (for extending):
- `createClient(config): OpenAI` - Create OpenAI client
- `convertModel(model): ModelInfo` - Convert model format
- `convertMessages(request): OpenAI.ChatCompletionMessageParam[]` - Convert messages
- `convertTools(request): OpenAI.ChatCompletionTool[]` - Convert tools
- `convertToolChoice(request): OpenAI.ChatCompletionToolChoiceOption` - Convert tool choice
- `convertResponseFormat(request): ResponseFormat` - Convert response format
- `augmentChatRequest(params, request, config)` - Add to Chat Completions params (mutate in place)
- `augmentChatMessage(chatMessage, message, config)` / `augmentChatContent(...)` - Add to converted messages and content parts
- `augmentChatResponse(completion, response, config)` / `augmentChatChunk(chunk, ...)` - Read extra fields from responses and chunks
- `augmentImageGenerateRequest?` / `augmentImageEditRequest?` / `augmentTranscriptionRequest?` / `augmentSpeechRequest?` / `augmentEmbeddingRequest?` `(params, request, config)` - Optional hooks to add to those params
- `usesResponses(request, modelId, config, model?)` - Whether a chat request goes to the Responses API
- `createBatch(batch, run)` / `retrieveBatch(job, run)` - Submit and read batches (OpenRouter overrides these for inline batches)

## Model Support

### Chat Models

- **GPT-6**: `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`
- **GPT-5.x**: `gpt-5.6-*`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `chat-latest`
- **Pro and codex** (Responses API): `gpt-5.5-pro`, `gpt-5.4-pro`, `gpt-5.3-codex`
- **GPT-4.1 / GPT-4o** (retiring): `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o`, `gpt-4o-mini`
- **Audio**: `gpt-audio-1.5`

### Image Models

- **GPT Image**: `gpt-image-2`, `gpt-image-2.5-*`

### Audio Models

- **Transcription**: `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-transcribe-diarize`, `whisper-1`
- **TTS**: `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`

The `@aeye/models` registry records each model's `retiresAt` date; retired models are never selected.

### Embedding Models

- **Embedding v3**: `text-embedding-3-small`, `text-embedding-3-large`
- **Embedding v2**: `text-embedding-ada-002`

## Best Practices

1. **API Key Security**: Never hardcode API keys. Use environment variables or secure key management.

2. **Error Handling**: Always wrap API calls in try-catch blocks and handle rate limits gracefully.

3. **Streaming for Long Responses**: Use streaming for better user experience with lengthy responses.

4. **Token Management**: Monitor token usage to control costs. Use `maxTokens` to limit response length.

5. **Model Selection**: Choose the appropriate model for your use case:
   - GPT-6 or GPT-5.5 for complex tasks requiring high accuracy
   - `gpt-5.4-mini` / `gpt-5.4-nano` for simpler tasks and faster responses
   - A higher `reason.effort` for reasoning-heavy problems

6. **Function Calling**: Use structured schemas with Zod for type-safe function definitions.

7. **Retry Logic**: Implement exponential backoff for rate limit errors.

8. **Context Window**: Be aware of model context limits and truncate messages if needed.

## Related Packages

- **[@aeye/core](../core)**: Core @aeye framework types and interfaces
- **[@aeye/ai](../ai)**: AI abstractions and utilities
- **[@aeye/anthropic](../anthropic)**: Anthropic Claude provider
- **[@aeye/openrouter](../openrouter)**: OpenRouter multi-provider gateway

## License

GPL-3.0

## Contributing

Contributions are welcome! Please see the main [@aeye repository](https://github.com/ClickerMonkey/aeye) for contribution guidelines.

## Support

For issues and questions:
- GitHub Issues: https://github.com/ClickerMonkey/aeye/issues
- Documentation: https://github.com/ClickerMonkey/aeye

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history and updates.
