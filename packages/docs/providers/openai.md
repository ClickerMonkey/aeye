# OpenAI Provider

The OpenAI provider supports the full range of OpenAI's API capabilities, through both Chat Completions and the Responses API.

## Installation

```bash
npm install @aeye/openai openai
```

Requires Node >= 22 (the `openai` SDK v7 needs it).

## Configuration

```typescript
import { OpenAIProvider } from '@aeye/openai';

const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: 'https://api.openai.com/v1',  // optional, default
  organization: 'org-xxx',                // optional
  project: 'proj-xxx',                    // optional
  store: true,                            // optional, allow storage (default false)
  api: 'auto',                            // optional: 'auto' | 'chat' | 'responses'
  retry: {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    jitter: true,
    retryableStatuses: [429, 500, 502, 503, 504],
    timeout: 60000,
  },
  defaultModels: {
    chat: 'gpt-5.4-mini',
    imageGenerate: 'gpt-image-2',          // default
    imageEdit: 'gpt-image-2',              // default
    imageAnalyze: 'gpt-5.4-mini',          // default
    transcription: 'gpt-transcribe',       // default
    speech: 'gpt-4o-mini-tts',             // default
    embedding: 'text-embedding-3-small',   // default
    decision: 'gpt-6-luna',                // default
  },
  hooks: {
    chat: {
      beforeRequest: (request, params, ctx, metadata) => {},
      afterRequest: (request, params, response, ctx, metadata) => {},
      onError: (request, params, error, ctx, metadata) => {},
    },
  },
});
```

Hooks exist for `chat`, `responses`, `imageGenerate`, `imageEdit`, `transcribe`, `speech`, `embed`, and `decide`. Image analysis runs as chat and reports through the chat (or responses) hooks.

### Chat Completions or Responses

With `api: 'auto'` (the default), chat requests use Chat Completions unless they need the Responses API:

- the model is Responses-only (its registry entry's `metadata.responsesOnly`, or by id: codex, pre-5.6 pro models, deep-research, computer-use),
- the request has `hostedTools`,
- a tool sets `format`, `defer`, or `async` (see [Tool Features](#tool-features)), or
- `reason` sets `mode`, `summary`, or `context`.

`'chat'` or `'responses'` forces one API. Through Responses, reasoning comes back encrypted (unless `store` is on) and is replayed on later turns, so multi-turn reasoning works without stored responses.

## Capabilities

| Capability | Models | API Method |
|-----------|--------|------------|
| Chat | GPT-5.x, GPT-6, GPT-4.1 | `ai.chat` |
| Vision | GPT-5.x, GPT-6, GPT-4.1 | `ai.chat` with images, `ai.image.analyze` |
| Reasoning | GPT-5.x, GPT-6, o3 | `ai.chat` with `reason` |
| Tools | GPT-5.x, GPT-6, GPT-4.1 | `ai.chat` with tools |
| Hosted tools | Responses models | `ai.chat` with `hostedTools` |
| Structured Output | GPT-5.x, GPT-6, GPT-4.1 | `ai.chat` with schema |
| Audio output | gpt-audio | `ai.chat` with `modalities: ['text', 'audio']` |
| Image Generation | GPT Image (gpt-image-2) | `ai.image.generate` |
| Image Editing | GPT Image (gpt-image-2) | `ai.image.edit` |
| Speech (TTS) | gpt-4o-mini-tts, tts-1 | `ai.speech` |
| Transcription | gpt-transcribe, gpt-4o-transcribe-diarize | `ai.transcribe` |
| Embeddings | text-embedding-3-* | `ai.embed` |
| Decisions | gpt-6-luna | `ai.decide` |
| Batches | Chat and Responses models | `ai.batch` |

## Request Features

Beyond the common chat fields, OpenAI sends:

| Request field | Sent as |
|---|---|
| `reason.effort` (`none`..`max`) | `reasoning_effort`, clamped to the model's accepted efforts when the registry lists them |
| `seed`, `verbosity`, `serviceTier`, `metadata` | `seed`, `verbosity`, `service_tier`, `metadata` (Chat Completions sends `metadata` only when `store` is on) |
| `modalities` + `audio` | audio output (`{ voice, format }`; format defaults to mp3, or PCM when streaming) |
| `moderate: true` | inline moderation with `omni-moderation-latest`; verdicts come back as `response.moderation` |
| `hostedTools` | Responses tools: `web_search` (`allowedDomains`; `blockedDomains` is rejected), `file_search`, `code_interpreter`, `image_generation`, `mcp`. `web_fetch` is rejected. |
| `cacheBreakpoint` on content | a prompt cache breakpoint |
| `toolChoice: { allowed, required? }` | `allowed_tools` (`mode` `required` or `auto`), on both APIs |
| `detail` / `name` on content | image detail / file name |

Responses carry `citations`, `images`, `audio`, `moderation`, and `serviceTier` when present, and `usage.tools` counts hosted tool calls.

## Tool Features

| Tool option | Sent as |
|---|---|
| `format: { type: 'text' }` | a Responses custom tool; the text comes back as `{ input }` arguments |
| `format: { type: 'grammar', syntax, definition }` | a Responses custom tool constrained by the Lark or regex grammar. On Chat Completions (`api: 'chat'`) it is a one-field function whose description carries the grammar. |
| `defer: true` | `defer_loading` on the tool, plus the hosted `tool_search` tool |
| `async: true` | the Responses `async` flag |

Custom tool calls stream as tool call arguments and replay on later turns as `custom_tool_call` items. See [Tool Calling](/guides/tool-calling#free-text-and-grammar-tools).

## Decisions

`ai.decide` calls `/v1/decisions` (default model `gpt-6-luna`). A conversation `input` is sent as Responses input; choices and levels go as `{ value, description }` and `{ label }` lists, and answers come back keyed by question name. Usage is priced from the model's token pricing. See [Decisions](/guides/decisions).

```typescript
const { answers } = await ai.decide.get({
  input: 'Cancel my subscription right now.',
  questions: { churn: { type: 'predicate', instructions: 'Does the user want to cancel?' } },
});
```

## Batches

`ai.batch.submit` uploads the requests as a JSONL file (`purpose: 'batch'`) and creates a batch with a 24 hour completion window, billed at about half the normal price. The requests go to `/v1/chat/completions`, or to `/v1/responses` when any of them needs the Responses API. Once the batch completes, `ai.batch.get` reads its output and error files and returns the results in request order. See [Batches](/guides/batch).

## Usage

```typescript
const ai = AI.with()
  .providers({ openai })
  .create();

// Chat
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Hello' }],
});

// With vision
const response = await ai.chat.get({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', content: 'Describe this image' },
      { type: 'image', content: 'https://example.com/img.png', detail: 'high' },
    ],
  }],
});

// Web search (uses the Responses API)
const answer = await ai.chat.get({
  messages: [{ role: 'user', content: 'What changed in the latest Node release?' }],
  hostedTools: [{ type: 'web_search' }],
});
console.log(answer.citations);

// Image generation
const img = await ai.image.generate.get({
  prompt: 'A sunset over mountains',
  size: '1024x1024',
  quality: 'high',
  outputFormat: 'webp',
  outputCompression: 80,
});
```

## Error Types

```typescript
import {
  ProviderError,
  ProviderAuthError,
  RateLimitError,
  ProviderRateLimitError,
  ProviderQuotaError,
  ContextWindowError,
} from '@aeye/openai';
```

## As Base Class

`OpenAIProvider` can be extended for OpenAI-compatible APIs:

```typescript
class AzureProvider extends OpenAIProvider {
  readonly name = 'azure';
  // customize as needed, e.g. override the protected `defaults` model ids
}
```

See [Custom Providers](/guides/custom-providers) for details.
