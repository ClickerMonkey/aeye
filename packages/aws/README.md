# @aeye/aws - AWS Bedrock Provider

AWS Bedrock integration for the [@aeye](https://github.com/ClickerMonkey/aeye) framework, providing seamless access to Claude, Llama, Mistral, Cohere, Stability AI, and Amazon Titan models.

## Features

- 🤖 **Multi-Model Support** - Access to all AWS Bedrock foundation models
- 🔐 **Automatic Authentication** - Uses AWS SDK credential chain for seamless authentication
- 🌊 **Streaming** - Full streaming support for real-time responses
- 🧠 **Reasoning** - Claude adaptive and budgeted thinking, Nova and gpt-oss reasoning, with reasoning blocks replayed across turns
- 📐 **Structured Output** - Converse JSON-schema output and strict tools
- 💾 **Prompt Caching** - Cache points from `cacheBreakpoint`, with cache read/write usage
- 📄 **Documents, Images, Video** - Bytes or S3 locations
- 🎨 **Image Generation** - Stability AI models for image creation
- 📊 **Embeddings** - Amazon Titan embeddings for semantic search
- 🔧 **Type-Safe** - Full TypeScript support with type inference
- ⚡ **Regional Flexibility** - Deploy across any AWS region with Bedrock

## Supported Models

### Chat Models
- **Anthropic Claude** - Claude 3.x through 5.x
- **Amazon Nova** - Nova and Nova 2
- **OpenAI** - gpt-oss
- **Open-weight models** - DeepSeek, Qwen, Kimi, MiniMax, and more
- **Meta Llama** - Llama 2, Llama 3, Llama 3.1, Llama 3.2
- **Mistral AI** - Mistral 7B, Mixtral 8x7B, Mistral Large
- **Cohere** - Command, Command Light, Command R, Command R+
- **AI21 Labs** - Jurassic-2 models

### Image Models
- **Stability AI** - Stable Diffusion XL, Stable Diffusion 3

### Embedding Models
- **Amazon Titan** - Titan Text Embeddings v1 and v2

## Installation

```bash
npm install @aeye/aws @aeye/ai @aeye/core zod
```

## Prerequisites

### AWS Credentials

The provider uses the AWS SDK v3 credential chain to automatically discover credentials:

1. **Environment variables** - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
2. **Shared credentials file** - `~/.aws/credentials`
3. **IAM roles** - When running on EC2, ECS, Lambda, etc.

### AWS Bedrock Access

Ensure you have:
1. Access to AWS Bedrock in your target region
2. Permissions to invoke foundation models
3. Model access enabled in the AWS Bedrock console

## Quick Start

### Basic Chat Completion

```typescript
import { AI } from '@aeye/ai';
import { AWSBedrockProvider } from '@aeye/aws';

// Create provider (credentials picked up automatically)
const aws = new AWSBedrockProvider({
  region: 'us-east-1',
});

// Create AI instance
const ai = AI.with()
  .providers({ aws })
  .create();

// Chat with Claude
const response = await ai.chat.get([
  { role: 'user', content: 'What is AWS Bedrock?' }
], {
  model: 'anthropic.claude-3-sonnet-20240229-v1:0'
});

console.log(response.content);
```

### Streaming Responses

```typescript
// Stream responses in real-time
for await (const chunk of ai.chat.stream([
  { role: 'user', content: 'Write a poem about AI' }
], {
  model: 'anthropic.claude-3-haiku-20240307-v1:0'
})) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }
}
```

### Image Generation

```typescript
import { AWSBedrockProvider } from '@aeye/aws';

const aws = new AWSBedrockProvider({
  region: 'us-east-1',
  defaultModels: {
    imageGenerate: 'stability.stable-diffusion-xl-v1',
  },
});

const ai = AI.with()
  .providers({ aws })
  .create();

const result = await ai.image.generate({
  prompt: 'A serene mountain landscape at sunset',
  size: { width: 1024, height: 1024 },
});

console.log('Image URL:', result.images[0].url);
```

### Text Embeddings

```typescript
const aws = new AWSBedrockProvider({
  region: 'us-east-1',
  defaultModels: {
    embedding: 'amazon.titan-embed-text-v1',
  },
});

const ai = AI.with()
  .providers({ aws })
  .create();

const embeddings = await ai.embed.get({
  input: 'AWS Bedrock is a fully managed service',
  model: 'amazon.titan-embed-text-v1',
});

console.log('Embedding dimensions:', embeddings.embeddings[0].length);
```

## Configuration

### Provider Configuration

```typescript
import { AWSBedrockProvider, type AWSBedrockConfig } from '@aeye/aws';

const config: AWSBedrockConfig = {
  // AWS region (defaults to AWS_REGION env var or 'us-east-1')
  region: 'us-west-2',
  
  // Optional: Explicit credentials (if not using default chain)
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    sessionToken: process.env.AWS_SESSION_TOKEN, // Optional
  },
  
  // Optional: Inference profile prefix. Without one, models served only
  // through inference profiles use the region's geography (or global) profile
  modelPrefix: 'us.',

  // Optional: Latency-optimized inference, where the model offers it
  latency: 'optimized',

  // Optional: Guardrail applied to every chat request
  guardrail: { guardrailIdentifier: 'gr-abc123', guardrailVersion: '1' },

  // Optional: Default models for different capabilities
  defaultModels: {
    chat: 'anthropic.claude-3-sonnet-20240229-v1:0',
    imageGenerate: 'stability.stable-diffusion-xl-v1',
    embedding: 'amazon.titan-embed-text-v2:0',
  },
};

const provider = new AWSBedrockProvider(config);
```

### Using with Multiple Providers

```typescript
import { AI } from '@aeye/ai';
import { AWSBedrockProvider } from '@aeye/aws';
import { OpenAIProvider } from '@aeye/openai';

const aws = new AWSBedrockProvider({ region: 'us-east-1' });
const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });

const ai = AI.with()
  .providers({ aws, openai })
  .create({
    // Automatic model selection across all providers
    defaultMetadata: {
      required: ['chat', 'streaming'],
      weights: {
        cost: 0.5,
        speed: 0.3,
        quality: 0.2,
      },
    },
  });

// AI instance will automatically select the best model across AWS and OpenAI
const response = await ai.chat.get([
  { role: 'user', content: 'Hello!' }
]);
```

## Model IDs

### Anthropic Claude Models

```typescript
// Claude 3.5
'anthropic.claude-3-5-sonnet-20240620-v1:0'
'anthropic.claude-3-5-sonnet-20241022-v2:0'

// Claude 3
'anthropic.claude-3-opus-20240229-v1:0'
'anthropic.claude-3-sonnet-20240229-v1:0'
'anthropic.claude-3-haiku-20240307-v1:0'

// Claude 2.x
'anthropic.claude-v2:1'
'anthropic.claude-v2'
'anthropic.claude-instant-v1'
```

### Meta Llama Models

```typescript
'meta.llama3-2-1b-instruct-v1:0'
'meta.llama3-2-3b-instruct-v1:0'
'meta.llama3-2-11b-instruct-v1:0'
'meta.llama3-2-90b-instruct-v1:0'
'meta.llama3-1-8b-instruct-v1:0'
'meta.llama3-1-70b-instruct-v1:0'
'meta.llama3-1-405b-instruct-v1:0'
'meta.llama3-8b-instruct-v1:0'
'meta.llama3-70b-instruct-v1:0'
'meta.llama2-13b-chat-v1'
'meta.llama2-70b-chat-v1'
```

### Mistral AI Models

```typescript
'mistral.mistral-7b-instruct-v0:2'
'mistral.mixtral-8x7b-instruct-v0:1'
'mistral.mistral-large-2402-v1:0'
'mistral.mistral-large-2407-v1:0'
```

### Cohere Models

```typescript
'cohere.command-text-v14'
'cohere.command-light-text-v14'
'cohere.command-r-v1:0'
'cohere.command-r-plus-v1:0'
```

### Stability AI Models

```typescript
'stability.stable-diffusion-xl-v1'
'stability.sd3-large-v1:0'
```

### Amazon Titan Models

```typescript
// Embeddings
'amazon.titan-embed-text-v1'
'amazon.titan-embed-text-v2:0'

// Image Generation
'amazon.titan-image-generator-v1'
'amazon.titan-image-generator-v2:0'
```

## Advanced Features

### Vision with Claude 3

```typescript
const response = await ai.chat.get([
  {
    role: 'user',
    content: [
      { type: 'text', content: 'What do you see in this image?' },
      { type: 'image', content: 'https://example.com/image.jpg' },
    ],
  },
], {
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
});
```

### Documents, Video, and S3

```typescript
const response = await ai.chat.get([
  {
    role: 'user',
    content: [
      { type: 'text', content: 'Summarize the report and the clip.' },
      { type: 'file', content: 's3://my-bucket/q3-report.pdf', name: 'Q3 report.pdf' },
      { type: 'video', content: 's3://my-bucket/clip.mp4' },
    ],
  },
], {
  model: 'amazon.nova-pro-v1:0',
});
```

`s3://` URIs are sent as S3 locations; other content is sent as bytes. The
format comes from `format`, the MIME type, or the file extension.

### Reasoning

```typescript
const response = await ai.chat.get([
  { role: 'user', content: 'Prove that there are infinitely many primes.' },
], {
  model: 'anthropic.claude-opus-4-7',
  reason: { effort: 'high' },
});

console.log(response.reasoning?.content);
```

Claude 4.6+ thinks adaptively (`thinking.type: 'adaptive'` with
`outputConfig.effort`), earlier Claude takes a thinking budget, Nova 2 takes
`reasoningConfig`, and gpt-oss takes `reasoning_effort`. Reasoning blocks keep
their signatures and redacted content, and are sent back with the assistant
message on later turns, as Claude requires while it uses tools. Reasoning is
marked `provider: 'aws-bedrock'`, so OpenAI and OpenRouter don't replay it.

- Efforts are clamped to what the model accepts (Claude 4.6 gets `high` for `xhigh`).
- Claude can't think on a turn that forces a tool, so that turn is sent with
  thinking disabled.
- Claude that always thinks (Opus 5.5, Sonnet 5.5, Fable) rejects both thinking
  disabled and a forced tool choice: it is never sent `disabled`, and a forced
  turn offers it only the forced tools with an automatic choice.

### Structured Output

On Claude 4.5 and later, a tool or response schema goes strict (`strict: true`,
or `outputConfig.textFormat`) when it fits Anthropic's strict subset and
limits. Recursive schemas, open values and tuples, and requests past 24
optional or 16 union-typed parameters go non-strict instead, and a response
schema then goes in the prompt.

### Prompt Caching

```typescript
const response = await ai.chat.get([
  { role: 'system', content: [{ type: 'text', content: longInstructions, cacheBreakpoint: true }] },
  { role: 'user', content: 'First question' },
], {
  model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
});

console.log(response.usage?.text?.cached, response.usage?.text?.cacheWrite);
```

Models without prompt caching (gpt-oss, Llama, DeepSeek, Nemotron, ...) reject
cache points, so they're left out for models whose registry pricing has no
cache reads.

### Custom Request Parameters

```typescript
const response = await ai.chat.get([
  { role: 'user', content: 'Hello!' }
], {
  model: 'anthropic.claude-3-haiku-20240307-v1:0',
  temperature: 0.7,
  maxTokens: 2048,
  topP: 0.9,
  stop: ['Human:', 'Assistant:'],
  serviceTier: 'flex',            // Converse serviceTier (fast → priority)
  metadata: { team: 'search' },   // Converse requestMetadata
  extra: { top_k: 50 },           // additionalModelRequestFields
});
```

### Multi-Region Setup

```typescript
// Primary region
const awsEast = new AWSBedrockProvider({
  region: 'us-east-1',
});

// Fallback region
const awsWest = new AWSBedrockProvider({
  region: 'us-west-2',
});

const ai = AI.with()
  .providers({ awsEast, awsWest })
  .create();
```

### Inference Profiles

Without a `modelPrefix`, a model the registry marks as served only through
inference profiles is called by the profile for the region's geography (`us.`,
`eu.`, `apac.`), or its `global.` profile. When Bedrock answers that a model's
"on-demand throughput isn't supported" in this region, the request is sent
again by profile, and that model is called by profile from then on.

## Error Handling

```typescript
import {
  AWSError,
  AWSAuthError,
  AWSRateLimitError,
  AWSQuotaError,
  AWSContextWindowError,
} from '@aeye/aws';

try {
  const response = await ai.chat.get([
    { role: 'user', content: 'Hello!' }
  ]);
} catch (error) {
  if (error instanceof AWSAuthError) {
    console.error('Authentication failed. Check your AWS credentials.');
  } else if (error instanceof AWSRateLimitError) {
    console.error('Rate limit exceeded. Retry after:', error.retryAfter);
  } else if (error instanceof AWSQuotaError) {
    console.error('AWS quota exceeded. Request quota increase.');
  } else if (error instanceof AWSContextWindowError) {
    console.error('Input too long for model context window.');
  } else if (error instanceof AWSError) {
    console.error('AWS Bedrock error:', error.message);
  }
}
```

`AccessDeniedException` (including a model the account can't use) throws
`AWSAuthError`; `ServiceUnavailableException` throws `AWSRateLimitError`; Claude's
"prompt is too long" and Nova's "Input Tokens Exceeded" throw `AWSContextWindowError`.

## Health Check

```typescript
const isHealthy = await aws.checkHealth();
console.log('AWS Bedrock is accessible:', isHealthy);
```

## List Available Models

```typescript
const models = await aws.listModels();
console.log('Available models:', models.map(m => m.id));

// Filter by capability
const chatModels = models.filter(m => m.capabilities.has('chat'));
const imageModels = models.filter(m => m.capabilities.has('image'));
const embeddingModels = models.filter(m => m.capabilities.has('embedding'));
```

## Best Practices

1. **Use IAM Roles** - When running on AWS infrastructure (EC2, ECS, Lambda), use IAM roles instead of hardcoded credentials
2. **Region Selection** - Choose regions close to your users for lower latency
3. **Model Selection** - Use smaller models (Haiku, 7B) for faster, cheaper responses when appropriate
4. **Streaming** - Enable streaming for better user experience with long responses
5. **Error Handling** - Implement proper error handling and retry logic for production use
6. **Cost Management** - Monitor usage through AWS Cost Explorer and set up billing alerts

## Environment Variables

```bash
# AWS credentials (if not using IAM roles)
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_SESSION_TOKEN=your_session_token  # Optional

# AWS region
AWS_REGION=us-east-1
```

## Links

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [Model IDs Reference](https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html)
- [@aeye Framework](https://github.com/ClickerMonkey/aeye)
- [AWS SDK for JavaScript](https://docs.aws.amazon.com/sdk-for-javascript/v3/)

## License

GPL-3.0 - See [LICENSE](../../LICENSE) file for details.

## Contributing

Issues and pull requests are welcome! See the [main repository](https://github.com/ClickerMonkey/aeye) for contribution guidelines.
