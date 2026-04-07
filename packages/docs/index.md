---
layout: home
hero:
  name: '@aeye'
  text: Multi-Provider AI for TypeScript
  tagline: Intelligent model selection, type-safe context management, and comprehensive provider support.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/ClickerMonkey/aeye
features:
  - icon: "\U0001F3AF"
    title: Multi-Provider
    details: Single interface for OpenAI, OpenRouter, Replicate, AWS Bedrock, and custom OpenAI-compatible providers.
  - icon: "\U0001F916"
    title: Intelligent Model Selection
    details: Automatic model selection based on capabilities, cost, speed, and quality with weighted scoring.
  - icon: "\U0001F6E1\uFE0F"
    title: Type-Safe
    details: Strongly-typed context and metadata with full compiler validation. Zod schemas for tool inputs and structured outputs.
  - icon: "\U0001F9E9"
    title: Composable Components
    details: Build sophisticated AI workflows with Tools, Prompts, and Agents that compose together naturally.
  - icon: "\U0001F4B0"
    title: Cost Tracking
    details: Built-in token usage and cost calculation with budget enforcement hooks.
  - icon: "\U0001F30A"
    title: Full Streaming
    details: Streaming support across all APIs with rich event system for real-time UI updates.
---

## Quick Example

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import z from 'zod';

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
const ai = AI.with().providers({ openai }).create();

// Define a tool
const getWeather = ai.tool({
  name: 'getWeather',
  description: 'Get weather for a city',
  schema: z.object({ city: z.string() }),
  call: async ({ city }) => ({ temp: 72, condition: 'sunny' }),
});

// Create a prompt that uses the tool
const advisor = ai.prompt({
  name: 'advisor',
  description: 'Travel advisor',
  content: 'Check the weather in {{city}} and suggest what to wear.',
  input: (input: { city: string }) => input,
  tools: [getWeather],
  schema: z.object({ suggestion: z.string() }),
});

const result = await advisor.get('result', { city: 'Paris' });
console.log(result?.suggestion);
```

## Packages

| Package | Description |
|---------|-------------|
| [`@aeye/core`](/reference/core/types) | Core primitives: Tool, Prompt, Agent, and shared types |
| [`@aeye/ai`](/reference/ai/ai-class) | Main AI library with model selection, APIs, and hooks |
| [`@aeye/openai`](/providers/openai) | OpenAI provider (chat, images, speech, transcription, embeddings) |
| [`@aeye/openrouter`](/providers/openrouter) | OpenRouter multi-provider gateway |
| [`@aeye/replicate`](/providers/replicate) | Replicate open-source model provider |
| [`@aeye/aws`](/providers/aws) | AWS Bedrock provider (Converse API) |
| `@aeye/models` | Auto-generated model registry with pricing and capabilities |
