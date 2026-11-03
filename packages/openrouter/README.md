# @aeye/openrouter

OpenRouter provider for the @aeye (AI TypeScript) framework. OpenRouter provides unified access to multiple AI providers through a single API, with automatic fallbacks, routing optimization, and competitive pricing.

## Features

- **Multi-Provider Access**: Access models from OpenAI, Anthropic, Google, xAI, Meta, and more through one API
- **Automatic Fallbacks**: Seamless failover to alternative providers if primary fails
- **Intelligent Routing**: Automatic selection of best provider for each request
- **Cost Tracking**: Built-in cost information in responses
- **ZDR Support**: Zero Data Retention mode for privacy-sensitive applications
- **Provider Preferences**: Control which providers to use, prefer, or avoid
- **Reasoning Models**: Effort or token-budget reasoning for GPT, Claude, Gemini, Grok, and others
- **Server Tools**: Web search, web fetch, and image generation run by OpenRouter
- **Media**: Image generation/editing, speech, transcription, and embeddings
- **Reranking, Decisions, Batches**: `/rerank` (Cohere, Voyage, Qwen, Nemotron), the alpha decisions endpoint (System One models such as Jev and Kev), and inline batches
- **Plugins & Fallback Models**: PDF parsing, response healing, context compression, and model fallbacks
- **Streaming**: Full streaming support across compatible models
- **Extends OpenAI**: Built on the OpenAI provider for compatibility

## Installation

```bash
npm install @aeye/openrouter @aeye/openai @aeye/ai @aeye/core openai zod
```

Requires Node >= 22 and the `openai` SDK v7.

## Quick Start

```typescript
import { OpenRouterProvider } from '@aeye/openrouter';
import { AI } from '@aeye/ai';

// Create provider instance
const openrouter = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    siteUrl: 'https://yourapp.com',
    appName: 'Your App Name',
  },
});

// Use with AI instance
const ai = AI.with()
  .providers({ openrouter })
  .create();

// Make a request (OpenRouter picks the best provider)
const response = await ai.chat.get([
  { role: 'user', content: 'Explain TypeScript generics' }
], {
  metadata: { model: 'openai/gpt-5.4-mini' }
});

console.log(response.content);
console.log('Cost:', response.usage.cost); // Actual cost from OpenRouter
```

## Configuration

### Basic Configuration

```typescript
import { OpenRouterProvider, OpenRouterConfig } from '@aeye/openrouter';

const config: OpenRouterConfig = {
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    siteUrl: 'https://yourapp.com', // Your app URL (helps with rankings)
    appName: 'My AI App', // Your app name (shown in OpenRouter dashboard)
  },
};

const provider = new OpenRouterProvider(config);
```

### Advanced Configuration

```typescript
const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    siteUrl: 'https://yourapp.com',
    appName: 'My AI App',

    // Provider routing (sent as OpenRouter's `provider` object)
    providers: {
      order: ['openai', 'anthropic'],        // Preferred order
      allowFallbacks: true,                  // Fall back to other providers
      only: ['openai', 'anthropic', 'google'], // Only use these providers
      ignore: ['low-quality-provider'],      // Never use these providers
      quantizations: ['int8', 'fp16'],       // Allowed quantization levels
      sort: { by: 'throughput', partition: 'none' }, // or 'price' | 'latency' | 'exacto'
      preferredMinThroughput: 50,            // tokens/s, median
      preferredMaxLatency: 2,                // seconds, median
      dataCollection: 'deny',                // or 'allow'
      zdr: true,                             // Zero data retention endpoints only
      enforceDistillableText: false,         // Only providers that allow training on outputs
      requireParameters: true,               // Only providers that support every parameter
      maxPrice: { prompt: 10, completion: 30 },
    },

    // Models to try, in order, when the requested one fails
    fallbackModels: ['openai/gpt-5.4-mini', 'anthropic/claude-sonnet-4.5'],

    // Plugins
    plugins: [
      { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } },
      { id: 'response-healing' },
      { id: 'context-compression', engine: 'middle-out' },
    ],
  },
});
```

`transforms` is deprecated: OpenRouter replaced transforms with plugins, and `transforms: ['middle-out']` is sent as the `context-compression` plugin. `OpenRouterConfig` has no `api` option; requests always go through Chat Completions.

## Usage Examples

### Basic Chat with Cost Tracking

```typescript
const response = await ai.chat.get([
  { role: 'user', content: 'What is the capital of France?' }
], {
  metadata: { model: 'openai/gpt-5.4-nano' }
});

console.log(response.content);
console.log('Tokens:', response.usage.totalTokens);
console.log('Cost: $', response.usage.cost); // Actual cost from OpenRouter
```

### Using Multiple Models

OpenRouter allows you to access models from different providers using the format `provider/model`:

```typescript
// OpenAI GPT-4
const gpt4 = await ai.chat.get(messages, {
  metadata: { model: 'openai/gpt-5.4-mini' }
});

// Anthropic Claude
const claude = await ai.chat.get(messages, {
  metadata: { model: 'anthropic/claude-opus-4.5' }
});

// Google Gemini
const gemini = await ai.chat.get(messages, {
  metadata: { model: 'google/gemini-pro' }
});

// Meta Llama
const llama = await ai.chat.get(messages, {
  metadata: { model: 'meta-llama/llama-3-70b' }
});
```

### Automatic Model Selection

Let OpenRouter choose the best model based on your criteria:

```typescript
const ai = AI.with()
  .providers({ openrouter })
  .create({
    defaultMetadata: {
      required: ['chat', 'streaming'],
      weights: {
        speed: 0.3,
        cost: 0.4,
        quality: 0.3,
      },
    },
  });

// OpenRouter will select the best model matching criteria
const response = await ai.chat.get([
  { role: 'user', content: 'Explain quantum computing' }
]);
```

### Provider Fallbacks

```typescript
// Primary provider fails? OpenRouter automatically falls back
const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    allowFallbacks: true,
    providers: {
      order: ['openai', 'anthropic', 'google'], // Try in this order
    },
  },
});

// If OpenAI is down, automatically tries Anthropic, then Google
const response = await ai.chat.get(messages, {
  metadata: { model: 'openai/gpt-5.4-mini' }
});
```

### Zero Data Retention (ZDR)

```typescript
// Only use ZDR-compliant models
const ai = AI.with()
  .providers({ openrouter })
  .create({
    defaultMetadata: {
      required: ['chat', 'zdr'], // Require ZDR support
    },
  });

// Also configure at provider level
const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    dataCollection: 'deny', // Ensure no data collection
  },
});
```

### Streaming with Cost Tracking

```typescript
let totalCost = 0;

for await (const chunk of ai.chat.stream([
  { role: 'user', content: 'Write a story about a robot' }
], {
  metadata: { model: 'anthropic/claude-sonnet-4.5' }
})) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }

  // Cost is sent in final chunk
  if (chunk.usage?.cost) {
    totalCost = chunk.usage.cost;
  }
}

console.log(`\n\nTotal cost: $${totalCost}`);
```

### Reasoning Models

```typescript
// Reason with an effort, or a token budget via reason.maxTokens (never both)
const response = await ai.chat.get({
  messages: [{
    role: 'user',
    content: 'Solve: If a train leaves NYC at 3pm going 60mph, and another leaves Boston at 4pm going 80mph, when do they meet?'
  }],
  reason: { effort: 'high', exclude: false },
}, {
  metadata: { model: 'openai/gpt-5.5' }
});

console.log('Reasoning:', response.reasoning);
console.log('Answer:', response.content);
console.log('Cost:', response.usage.cost);
```

### Server Tools

```typescript
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'What did the TypeScript team ship this month?' }],
  hostedTools: [
    { type: 'web_search', maxResults: 5, allowedDomains: ['devblogs.microsoft.com'], blockedDomains: ['example.com'] },
    { type: 'web_fetch' },
  ],
}, {
  metadata: { model: 'openai/gpt-5.4-mini' }
});

console.log(response.citations);
console.log(response.usage?.tools); // { web_search: 1 }
```

`web_search`, `web_fetch`, and `image_generation` run as `openrouter:*` server tools; `file_search`, `code_interpreter`, and `mcp` are rejected.

### Images, Speech, Transcription, Embeddings

```typescript
// Images go through chat with the image modality; size becomes an aspect ratio
const image = await ai.image.generate.get({ prompt: 'A lighthouse at dusk', size: '1536x1024' });

// Embeddings, speech, and transcription use OpenRouter's OpenAI-compatible endpoints
const { embeddings } = await ai.embed.get({ texts: ['hello'] });
const transcript = await ai.transcribe.get({ audio: fs.readFileSync('note.mp3') });
```

Defaults: `google/gemini-2.5-flash-image` for images, `openai/gpt-transcribe`, `openai/text-embedding-3-small`, and `openai/gpt-5.4-mini` for image analysis; speech has no default model. Image and transcription streaming fall back to the non-streaming methods.

### Reranking, Decisions, Batches

```typescript
// Order documents by relevance (default cohere/rerank-v3.5)
const { results } = await ai.rerank.get({ query: 'refund policy', documents, topN: 3 });

// Typed answers from a decision model (default typesafe/jev-1.14)
const { answers } = await ai.decide.get({
  input: 'I was charged twice for my order.',
  questions: {
    billing: { type: 'predicate', instructions: 'Is this a billing problem?' },
    team: { type: 'choice', instructions: 'Which team handles it?', choices: { payments: 'Charges and refunds', web: 'Website bugs' } },
  },
});

// Chat requests as one batch, posted inline to /batches
const job = await ai.batch.submit(requests, { metadata: { model: 'openai/gpt-5.4-mini' } });
const done = await ai.batch.wait(job, {});
```

Rerank and decision costs come back as `usage.cost`. Decisions use OpenRouter's alpha endpoint, outside the versioned API. Change the defaults with `defaultModels.rerank` and `defaultModels.decision`.

### Function Calling

```typescript
import z from 'zod';

const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: z.object({
        location: z.string(),
        unit: z.enum(['celsius', 'fahrenheit']).optional(),
      }),
    }
  ],
  toolChoice: 'auto',
}, {
  metadata: { model: 'openai/gpt-5.4-mini' },
});
```

`toolChoice: { allowed: [...], required? }` is emulated by sending only the allowed tools, because OpenRouter ignores `allowed_tools`. Free-text tools (`format`) go as one-field functions with any grammar in the description; `defer` and `async` are not sent.

### Fetching Available Models

OpenRouter provides a model source that can fetch all available models:

```typescript
import { OpenRouterModelSource } from '@aeye/openrouter';

const source = new OpenRouterModelSource({
  apiKey: process.env.OPENROUTER_API_KEY,
  includeZDR: true, // Include ZDR information
});

const models = await source.fetchModels();

models.forEach(model => {
  console.log(`${model.id}`);
  console.log(`  Pricing: $${model.pricing.text.input}/1M input tokens`);
  console.log(`  Context: ${model.contextWindow} tokens`);
  console.log(`  ZDR: ${model.capabilities.has('zdr')}`);
});
```

### Automatic Model Registration

```typescript
// Automatically fetch and register OpenRouter models
const ai = AI.with()
  .providers({ openrouter })
  .create({
    fetchOpenRouterModels: true, // Auto-fetch all available models
  });

// Now all OpenRouter models are available for automatic selection
const response = await ai.chat.get(messages);
```

## Configuration Options

### OpenRouterConfig

Extends `OpenAIConfig` from `@aeye/openai`, minus its `api` option.

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `apiKey` | `string` | Yes | OpenRouter API key |
| `baseURL` | `string` | No | Custom base URL (defaults to https://openrouter.ai/api/v1) |
| `defaultParams` | `object` | No | Default parameters for all requests |
| `defaultModels` | `object` | No | Per-operation defaults; built in: `cohere/rerank-v3.5` (rerank), `typesafe/jev-1.14` (decision), plus the image, transcription, and embedding defaults above |

### defaultParams

| Property | Type | Description |
|----------|------|-------------|
| `siteUrl` | `string` | Your app URL, sent as `HTTP-Referer` |
| `appName` | `string` | Your app name, sent as `X-Title` |
| `providers` | `object` | Provider routing (see below) |
| `fallbackModels` | `string[]` | Models to fall back to, in order (sent as `models`) |
| `plugins` | `OpenRouterPlugin[]` | `file-parser`, `response-healing`, `context-compression` |
| `transforms` | `string[]` | Deprecated; `middle-out` is sent as the `context-compression` plugin |

### providers Options

| Property | Type | Description |
|----------|------|-------------|
| `order` | `string[]` | Explicit provider order |
| `allowFallbacks` | `boolean` | Fall back to other providers |
| `requireParameters` | `boolean` | Only providers that support every parameter; auto-on for strict `json_schema` when unset |
| `dataCollection` | `'deny' \| 'allow'` | Provider data collection |
| `zdr` | `boolean` | Zero data retention endpoints only |
| `enforceDistillableText` | `boolean` | Only providers that allow training on outputs |
| `only` | `string[]` | Whitelist of providers |
| `ignore` | `string[]` | Providers to skip |
| `quantizations` | `OpenRouterQuantization[]` | Allowed quantization levels |
| `sort` | `'price' \| 'throughput' \| 'latency' \| 'exacto' \| { by, partition? }` | Sort providers; `exacto` prefers the best tool-calling accuracy, `partition: 'none'` sorts across fallback models together |
| `preferredMinThroughput` | `number` | Preferred median throughput floor (tokens/s) |
| `preferredMaxLatency` | `number` | Preferred median latency ceiling (seconds) |
| `maxPrice` | `{ prompt?, completion?, image?, audio?, request? }` | Price ceilings |

## Cost Information

OpenRouter includes actual cost information in every response:

```typescript
const response = await ai.chat.get(messages, {
  metadata: { model: 'openai/gpt-5.4-mini' }
});

// Cost is automatically included
console.log('Input tokens:', response.usage.text.input);
console.log('Output tokens:', response.usage.text.output);
console.log('Cost: $', response.usage.cost); // Actual USD cost

// Cost calculation is skipped when provider returns cost
// No need to manually calculate costs!
```

The cost is provided by OpenRouter's API in the `total_cost` field and automatically extracted into the `usage.cost` field.

## Model Format

OpenRouter uses the format `provider/model-name`:

- `openai/gpt-5.4-mini`
- `anthropic/claude-opus-4.5`
- `google/gemini-2.5-flash`
- `x-ai/grok-4.3`
- `meta-llama/llama-3-70b-instruct`
- `mistralai/mistral-large`
- `cohere/command-r-plus`

See the [OpenRouter Models](https://openrouter.ai/models) page for the full list.

## Privacy & Data Retention

### Zero Data Retention (ZDR)

OpenRouter supports ZDR mode where your data is not stored:

```typescript
// Require ZDR-compliant models
const ai = AI.with()
  .providers({ openrouter })
  .create({
    defaultMetadata: {
      required: ['chat', 'zdr'],
    },
  });

// Or configure at provider level
const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultParams: {
    dataCollection: 'deny',
    providers: {
      dataCollection: 'deny',
    },
  },
});
```

Models with ZDR support have the `zdr` capability tag.

## Error Handling

OpenRouter uses the same error types as the OpenAI provider:

```typescript
import { ProviderError, RateLimitError } from '@aeye/openrouter';

try {
  const response = await ai.chat.get(messages, {
    metadata: { model: 'openai/gpt-5.4-mini' }
  });
} catch (error) {
  if (error instanceof RateLimitError) {
    console.error('Rate limit exceeded');
    console.log(`Retry after ${error.retryAfter} seconds`);
  } else if (error instanceof ProviderError) {
    console.error(`Provider error: ${error.message}`);
  }
}
```

## Best Practices

1. **Set Site URL and App Name**: This helps with OpenRouter rankings and analytics
   ```typescript
   defaultParams: {
     siteUrl: 'https://yourapp.com',
     appName: 'Your App',
   }
   ```

2. **Use Cost Tracking**: Monitor costs with the built-in `usage.cost` field
   ```typescript
   console.log('Cost: $', response.usage.cost);
   ```

3. **Enable Fallbacks**: Use automatic fallbacks for reliability
   ```typescript
   defaultParams: {
     providers: {
       allowFallbacks: true,
       order: ['openai', 'anthropic', 'google'],
     },
     fallbackModels: ['openai/gpt-5.4-mini'],
   }
   ```

4. **Specify Provider Preferences**: Control which providers are used
   ```typescript
   providers: {
     only: ['openai', 'anthropic'],
     ignore: ['low-quality-provider'],
   }
   ```

5. **Use ZDR for Sensitive Data**: Enable Zero Data Retention for privacy
   ```typescript
   defaultParams: {
     providers: { dataCollection: 'deny', zdr: true },
   }
   ```

6. **Monitor Model Availability**: OpenRouter's model list changes frequently
   ```typescript
   fetchOpenRouterModels: true // Auto-fetch latest models
   ```

## API Reference

### OpenRouterProvider

Extends `OpenAIProvider` from `@aeye/openai`.

**Constructor**: `new OpenRouterProvider(config: OpenRouterConfig)`

**Methods**:
- Inherits all methods from `OpenAIProvider`
- `createExecutor<TContext, TMetadata>(config?)` - Returns executor with cost tracking
- `createStreamer<TContext, TMetadata>(config?)` - Returns streamer with cost tracking
- `listModels(config?)` - Fetches models from OpenRouter API with ZDR info

**Overridden Methods**:
- `createClient(config)` - Creates OpenAI client with OpenRouter endpoint
- `augmentChatRequest(params, request, config)` - Adds OpenRouter-specific params
- `buildChatParams(request, run, streaming)` - Sends only the allowed tools for `{ allowed }` tool choices
- `createBatch(batch, run)` / `retrieveBatch(job, run)` - Inline batches through `/batches`

**Added Methods**:
- `rerank(request, ctx, config?)` - `/rerank`
- `decide(request, ctx, config?)` - alpha decisions endpoint

### OpenRouterModelSource

Model source for fetching OpenRouter models.

**Constructor**: `new OpenRouterModelSource(config?: OpenRouterSourceConfig)`

**Methods**:
- `fetchModels(config?): Promise<ModelInfo[]>` - Fetch all available models

**Config Options**:
- `apiKey?: string` - OpenRouter API key (optional for public models)
- `includeZDR?: boolean` - Include ZDR information (default: true)

## Supported Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Function calling
- ✅ Vision (for supported models)
- ✅ Reasoning models
- ✅ Cost tracking
- ✅ Automatic fallbacks
- ✅ Provider routing
- ✅ ZDR mode
- ✅ Multi-modal (for supported models)
- ✅ Server tools (web search, web fetch, image generation)
- ✅ Prompt caching (`cacheBreakpoint` → `cache_control`)
- ✅ Image generation and editing (through chat; no streaming)
- ✅ Speech synthesis
- ✅ Transcription (no streaming)
- ✅ Embeddings
- ✅ Reranking
- ✅ Decisions (alpha endpoint)
- ✅ Batches

## Related Packages

- **[@aeye/core](../core)**: Core @aeye framework types and interfaces
- **[@aeye/ai](../ai)**: AI abstractions and utilities
- **[@aeye/openai](../openai)**: OpenAI provider (base class)
- **[@aeye/anthropic](../anthropic)**: Anthropic Claude provider
- **[@aeye/google](../google)**: Google AI provider

## Links

- [OpenRouter Website](https://openrouter.ai)
- [OpenRouter Models](https://openrouter.ai/models)
- [OpenRouter Documentation](https://openrouter.ai/docs)
- [OpenRouter API Keys](https://openrouter.ai/keys)

## License

GPL-3.0

## Contributing

Contributions are welcome! Please see the main [@aeye repository](https://github.com/ClickerMonkey/aeye) for contribution guidelines.

## Support

For issues and questions:
- GitHub Issues: https://github.com/ClickerMonkey/aeye/issues
- Documentation: https://github.com/ClickerMonkey/aeye
- OpenRouter Discord: https://discord.gg/openrouter
