# @aeye/aws

One-line purpose: AWS Bedrock provider for `@aeye/ai` — chat (Claude, Llama, Mistral, Cohere, etc.) through the unified **Converse API**, plus Stability AI image generation and Amazon Titan embeddings, using AWS SDK v3 credential discovery.

## When to use

- You want Bedrock-hosted foundation models behind the `@aeye/ai` interface.
- You need AWS-native auth (IAM roles, SSO, env credentials) rather than a single API key.
- You want one request/response shape across model families (the Converse API handles this).

## Install / import

```bash
npm install @aeye/aws
```

The AWS SDK v3 clients (`@aws-sdk/client-bedrock`, `@aws-sdk/client-bedrock-runtime`) ship as dependencies — no separate peer install.

```typescript
import {
  AWSBedrockProvider,
  type AWSBedrockConfig,
  // errors
  AWSError,
  AWSAuthError,
  AWSRateLimitError,
  AWSQuotaError,
  AWSContextWindowError,
  // model family typing
  type BedrockModelFamily,
  type ModelFamilyConfig,
} from '@aeye/aws';
```

The provider's registry name is `aws-bedrock`.

## Register with an `@aeye/ai` instance

```typescript
import { AI } from '@aeye/ai';
import { AWSBedrockProvider } from '@aeye/aws';

const aws = new AWSBedrockProvider({
  region: 'us-east-1', // optional; falls back to AWS_REGION env, then 'us-east-1'
});

const ai = AI.with()
  .providers({ aws })
  .create({ /* ... */ });

// Chat with Claude on Bedrock (model id selected via metadata)
const response = await ai.chat.get(
  { messages: [{ role: 'user', content: 'Hello' }] },
  { metadata: { model: 'anthropic.claude-3-5-sonnet-20241022-v2:0' } }
);
```

Direct (no facade):

```typescript
const executor = aws.createExecutor();
await executor(
  { messages: [{ role: 'user', content: 'Hi' }] },
  {},
  { model: 'anthropic.claude-3-sonnet-20240229-v1:0' }
);
```

## Authentication / credentials

The provider builds AWS SDK clients and relies on the **default AWS credential chain**. Explicit credentials are only applied when both `accessKeyId` **and** `secretAccessKey` are present in config; otherwise the SDK resolves credentials automatically:

1. Explicit `config.credentials` (requires both access key + secret key).
2. Environment variables `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ optional `AWS_SESSION_TOKEN`).
3. Shared credentials file `~/.aws/credentials`.
4. IAM roles (EC2 / ECS / Lambda).
5. SSO (`aws sso login`).

Region resolution: `config.region` → `process.env.AWS_REGION` → `'us-east-1'`.

```typescript
// Explicit (temporary) credentials
const aws = new AWSBedrockProvider({
  region: 'us-west-2',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN, // optional
  },
});
```

## Configuration (`AWSBedrockConfig`)

| Field | Type | Notes |
|-------|------|-------|
| `region` | `string` | AWS region; defaults to `AWS_REGION` then `us-east-1` |
| `credentials` | `{ accessKeyId?, secretAccessKey?, sessionToken? }` | Only used when access key + secret are both set |
| `modelPrefix` | `string` | Prepended to every model id — for cross-region inference (`'us.'`, `'eu.'`, `'apac.'`) |
| `modelFamilies` | `Record<string, ModelFamilyConfig>` | Per-family enable/disable and model-id mapping |
| `defaultModels` | `{ chat?, imageGenerate?, embedding? }` | Fallback model per capability |
| `hooks` | `AWSBedrockHooks` | `chat` / `imageGenerate` / `embed` with `beforeRequest` / `afterRequest` |

Hooks receive the AWS SDK command object (e.g. `ConverseCommand`, `InvokeModelCommand`), so you can inspect/log the exact request.

## Cross-region inference

```typescript
const aws = new AWSBedrockProvider({ region: 'us-east-1', modelPrefix: 'us.' });
// model 'anthropic.claude-...' is sent as 'us.anthropic.claude-...'
```

## Supported capabilities

| Capability | Implementation | Models |
|-----------|----------------|--------|
| Chat (+ streaming) | `ConverseCommand` / `ConverseStreamCommand` | Anthropic Claude, Meta Llama, Mistral, Cohere, AI21, Amazon Titan, etc. |
| Tools / function calling | Converse `toolConfig` | Claude and other tool-capable families |
| Vision | Converse image content blocks | Claude 3+ (see gotcha — base64 only) |
| Reasoning | Converse `reasoningContent` | Reasoning-capable Claude models |
| Image generation | `InvokeModelCommand` | Stability AI (SDXL / SD3) |
| Embeddings | `InvokeModelCommand` | Amazon Titan text embeddings |

There is **no** transcription or speech support in this provider.

Strict-schema families supported: `openai`, `anthropic`, `google`. Strict mode engages only when the resolved model's family is supported and the model declares `toolsStrict` / `structured`; otherwise it silently degrades to lenient schemas under a shared `SchemaBudget` (which respects Anthropic-style per-request limits).

## Usage examples

```typescript
// Streaming chat
for await (const chunk of ai.chat.stream(
  { messages: [{ role: 'user', content: 'Write a haiku' }] },
  { metadata: { model: 'anthropic.claude-3-5-sonnet-20241022-v2:0' } }
)) {
  process.stdout.write(chunk.content ?? '');
}

// Image generation (Stability AI)
const image = await ai.image.generate.get(
  { prompt: 'A mountain landscape', size: '1024x1024' },
  { metadata: { model: 'stability.stable-diffusion-xl-v1' } }
);

// Embeddings (Titan)
const embeddings = await ai.embed.get(
  { texts: ['Hello world'] },
  { metadata: { model: 'amazon.titan-embed-text-v1' } }
);
```

## Error types

```typescript
import {
  AWSError,            // base
  AWSAuthError,        // UnrecognizedClientException / InvalidSignatureException
  AWSRateLimitError,   // ThrottlingException / TooManyRequestsException
  AWSQuotaError,       // ServiceQuotaExceededException
  AWSContextWindowError, // "context length" / "token limit" in message
} from '@aeye/aws';
```

## Gotchas

- **Vision is base64-only.** The Converse conversion only accepts `data:<type>;base64,...` image content (png/jpeg/gif/webp). Plain image URLs are dropped — fetch the bytes yourself and pass a data URI.
- **Titan embeddings only embed the first text.** The provider sends `request.texts[0]` and returns that single embedding duplicated once per input text. Call once per text if you need distinct vectors.
- **Model is always required** (no implicit default unless you set `defaultModels`); missing model throws `AWSError`.
- Consecutive same-role messages are merged automatically (Converse requirement); an empty conversation gets a synthetic user message.
- Image generation/embeddings use fixed defaults in the Stability payload (`cfg_scale: 7`, `steps: 30`); only `prompt`, `size`, and `seed` flow through.
- Model access must be enabled in your AWS account/region (some families, e.g. Anthropic, require a use-case submission in the Bedrock console).
