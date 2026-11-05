# AWS Bedrock Provider

AWS Bedrock provides access to foundation models from Anthropic, Meta, Mistral, Cohere, AI21, Amazon, and Stability AI through the Converse API.

## Installation

```bash
npm install @aeye/aws
```

The AWS SDK v3 is included as a dependency.

## Configuration

```typescript
import { AWSBedrockProvider } from '@aeye/aws';

const aws = new AWSBedrockProvider({
  region: 'us-east-1',  // optional, defaults to AWS_REGION env var
  credentials: {         // optional, uses AWS credential chain by default
    accessKeyId: '...',
    secretAccessKey: '...',
    sessionToken: '...',  // for temporary credentials
  },
  modelPrefix: 'us.',   // optional, for cross-region inference
  latency: 'optimized', // optional, latency-optimized inference where offered
  guardrail: {          // optional, a guardrail on every chat request
    guardrailIdentifier: 'gr-abc123',
    guardrailVersion: '1',
    streamProcessingMode: 'async', // streaming only
  },
  defaultModels: {
    chat: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    imageGenerate: 'stability.stable-diffusion-xl-v1',
    embedding: 'amazon.titan-embed-text-v1',
  },
  hooks: {
    chat: {
      beforeRequest: (request, command, ctx) => {},
      afterRequest: (request, command, response, ctx) => {},
    },
  },
});
```

## Credential Chain

AWS Bedrock automatically discovers credentials in this order:

1. **Explicit credentials** in config
2. **Environment variables** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
3. **Shared credentials file** (`~/.aws/credentials`)
4. **IAM roles** (EC2, ECS, Lambda)
5. **SSO** (`aws sso login`)

Most setups need no explicit credentials:

```typescript
const aws = new AWSBedrockProvider({
  region: 'us-east-1',
  // credentials discovered automatically
});
```

## Supported Model Families

| Family | Models | Capabilities |
|--------|--------|-------------|
| Anthropic | Claude 3.x through 5.x | Chat, Vision, Documents, Tools, Streaming, Reasoning, Structured output, Caching |
| Amazon | Nova, Nova 2 | Chat, Vision, Video, Documents, Tools, Streaming, Reasoning, Caching |
| OpenAI | gpt-oss | Chat, Tools, Streaming, Reasoning |
| DeepSeek, Qwen, Kimi, MiniMax | Open-weight chat models | Chat, Tools, Streaming, Reasoning (model dependent) |
| Meta | Llama 3, 3.1, 3.2 | Chat, Streaming |
| Mistral | Mistral 7B, Mixtral, Mistral Large | Chat, Streaming |
| Cohere | Command R, Command R+ | Chat, Streaming |
| AI21 | Jurassic-2 | Chat |
| Stability AI | SDXL, SD3 | Image Generation |
| Amazon | Titan Text Embeddings | Embeddings |

## Cross-Region Inference

Access models in other regions using a model prefix:

```typescript
const aws = new AWSBedrockProvider({
  region: 'us-east-1',
  modelPrefix: 'us.', // routes to US-based endpoints
});
```

Without a prefix, a model the registry marks as served only through
[inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
(`metadata.inRegion: false`, with `metadata.inferenceIds`) is called by the
profile for the client region's geography (`us.` in `us-east-1`, `eu.` in
`eu-west-1`, `apac.` in `ap-*`), or by its `global.` profile when the geography
has none. Other models are called by their plain id.

The registry's `inRegion` holds for the region it was gathered in, so a model
can still need a profile elsewhere (Nova Micro does in `us-east-2`). When
Bedrock answers that a model's "on-demand throughput isn't supported", the
provider sends the request again by profile and calls that model by profile
from then on.

## Chat Features

Chat runs on the [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
and [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html) APIs.

| Request field | Converse |
|---------------|----------|
| `maxTokens`, `temperature`, `topP`, `stop` | `inferenceConfig` (defaults `maxTokens` to the model's output limit) |
| `reason` | Per model family, see [Reasoning](#reasoning) |
| `responseFormat` (schema) | `outputConfig.textFormat` JSON schema, for models with structured output |
| `tools`, `toolChoice` | `toolConfig`; strict tools set `strict: true` |
| `serviceTier` | `serviceTier`: `default`, `flex`, `fast` → `priority`, `scale` → `reserved` |
| `metadata` | `requestMetadata`, for filtering invocation logs |
| `extra` | `additionalModelRequestFields`, merged over the provider's own fields |

### Reasoning

| Models | `reason` maps to |
|--------|------------------|
| Claude 4.6 and later | `thinking: { type: 'adaptive', display: 'summarized' }` (`'omitted'` with `exclude`) and `outputConfig.effort` |
| Earlier Claude (3.7 – 4.5) | `thinking: { type: 'enabled', budget_tokens }`, from `maxTokens` or the effort (`low` 2048 … `max` 65536), kept under the output limit |
| Amazon Nova 2 | `reasoningConfig: { type: 'enabled', maxReasoningEffort }` |
| gpt-oss and models with `reasoningEfforts` | `reasoning_effort` |

`effort: 'none'` turns Claude and Nova thinking off. Claude thinking clears
`temperature` and `topP`, and Nova's `high` effort also clears `maxTokens`,
since those models reject them together. Efforts are clamped to what the model
accepts: Claude 4.6 rejects `xhigh` (added with Opus 4.7), so it gets `high`.
Claude can't think on a turn that forces a tool, so that turn is sent with
thinking disabled. Claude that always thinks (Opus 5.5, Sonnet 5.5, Fable) rejects both
thinking disabled and a forced tool choice, so it is never sent `disabled`, and a
forced turn offers it only the forced tools with an automatic choice.

Claude's effort goes in Converse's own `outputConfig.effort`, which Bedrock
passes to the model and validates (an `output_config` in
`additionalModelRequestFields`, as AWS's example has it, works the same).
`display: 'summarized'` and `'omitted'` are both accepted.

What comes back differs by model:

| Models | Reasoning |
|--------|-----------|
| Claude | Text with a signature; redacted reasoning as one `reasoning.encrypted` detail per block, streamed as one or more deltas |
| Nova 2 | The text `[REDACTED]`, unsigned |
| gpt-oss, DeepSeek R1 | Plain reasoning text, unsigned |
| Nemotron | Nothing, though it takes `reasoning_effort` |

Reasoning comes back as `response.reasoning` (streamed as `chunk.reasoning`),
with one `ReasoningDetail` per reasoning block in the `bedrock-converse-v1`
format: `reasoning.text` with its `signature`, or `reasoning.encrypted` with
redacted content as base64 `data`. When the assistant message is sent back,
signed and redacted blocks are replayed before its text and tool calls, as
Claude requires while it uses tools. Unsigned reasoning isn't replayed.

### Prompt Caching

A `MessageContent` with `cacheBreakpoint: true` adds a
[`cachePoint`](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
after that part, in system prompts, messages, and tool results. Cache reads and
writes are reported as `usage.text.cached` and `usage.text.cacheWrite`;
`usage.text.input` counts only uncached input.

Models without prompt caching (gpt-oss, Llama, DeepSeek, Nemotron, ...) reject
cache points with an `AccessDeniedException`, so they're left out for models
whose registry pricing has no cache reads. A prefix shorter than the model's
minimum (about 4k tokens on Claude Haiku 4.5) isn't cached. Nova may take a
few seconds before it serves a prefix it just wrote.

### Content

| Part | Converse block |
|------|----------------|
| `image` | `image` (png, jpeg, gif, webp) |
| `file` | `document` (pdf, csv, doc, docx, xls, xlsx, html, txt, md), named from `name` |
| `video` | `video` (mp4, mov, mkv, webm, flv, mpeg, mpg, wmv, 3gp) |
| `audio` | `audio`, for models that take it |

The format comes from `format`, the data URL's MIME type, or the file
extension. An `s3://bucket/key` URI is sent as an S3 location instead of
bytes; other URLs are downloaded. Tool results can carry text, images,
documents, and video. Unsupported content becomes a short note in its place.
Web citations in responses (`citationsContent`) become `response.citations`.

### Tools

`toolChoice` maps to `auto`, `any` (`'required'`), or `tool`. `{ allowed }` is
emulated by sending only the allowed tools, and `'none'` leaves the tools out
unless the conversation already used them. Free-text tools (`format`) are sent
as their one-field function with any grammar appended to the description.
Tool calls Bedrock runs itself (`server_tool_use`) aren't returned as tool calls.

On Claude 4.5 and later, a tool or response schema goes strict (`strict: true`,
or `outputConfig.textFormat`) when it fits Anthropic's strict subset and
limits. Recursive schemas, open values and tuples, and requests past 24
optional or 16 union-typed parameters go non-strict instead (a response schema
then goes in the prompt). The first request with a new strict schema can take
several seconds while Bedrock compiles it.

### Stop Reasons

`guardrail_intervened` and `content_filtered` finish as `content_filter`;
`max_tokens` and `model_context_window_exceeded` as `length`; `tool_use` as
`tool_calls`; everything else, including `malformed_model_output` and
`malformed_tool_use`, as `stop`.

## Model Family Configuration

Enable/disable specific model families and customize model ID mappings:

```typescript
const aws = new AWSBedrockProvider({
  region: 'us-east-1',
  modelFamilies: {
    anthropic: {
      enabled: true,
      modelIdMap: {
        'claude-3-sonnet': 'anthropic.claude-3-sonnet-20240229-v1:0',
      },
    },
    meta: { enabled: false }, // disable Llama models
  },
});
```

## Usage

```typescript
const ai = AI.with()
  .providers({ aws })
  .create();

// Chat with Claude on Bedrock
const response = await ai.chat.get(
  { messages },
  { metadata: { model: 'anthropic.claude-3-5-sonnet-20241022-v2:0' } }
);

// Image generation with Stability AI
const image = await ai.image.generate.get({
  prompt: 'A mountain landscape',
});

// Embeddings with Titan
const embeddings = await ai.embed.get({
  texts: ['Hello world'],
});
```

## Error Types

```typescript
import {
  AWSError,
  AWSAuthError,
  AWSRateLimitError,
  AWSQuotaError,
  AWSContextWindowError,
} from '@aeye/aws';
```

Throttling and busy capacity (`ThrottlingException`, `ServiceUnavailableException`)
throw `AWSRateLimitError`; rejected credentials (including `AccessDeniedException`)
throw `AWSAuthError`, as does a model the account can't use; prompts the
model reports as too long (Claude's "prompt is too long", Nova's "Input Tokens
Exceeded") throw `AWSContextWindowError`. Errors a stream reports mid-way are thrown the same way.

## Model Access

As of 2025, Bedrock models auto-enable on first invocation in commercial regions. For Anthropic models, first-time users may need to submit use case details through the AWS console.
