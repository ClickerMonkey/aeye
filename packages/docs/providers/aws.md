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
| Anthropic | Claude 3.5 Sonnet, Claude 3 Haiku/Sonnet/Opus | Chat, Vision, Tools, Streaming, Reasoning |
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

## Model Access

As of 2025, Bedrock models auto-enable on first invocation in commercial regions. For Anthropic models, first-time users may need to submit use case details through the AWS console.
