# Quick Start

This guide walks you through your first @aeye application.

## Setup

```bash
npm install @aeye/ai @aeye/core @aeye/openai openai zod
```

## Basic Chat

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';

// 1. Create a provider
const openai = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});

// 2. Create an AI instance
const ai = AI.with()
  .providers({ openai })
  .create();

// 3. Make a chat request
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'What is TypeScript?' }],
});

console.log(response.content);
```

## Streaming

```typescript
for await (const chunk of ai.chat.stream({
  messages: [{ role: 'user', content: 'Write a haiku about coding' }],
})) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }
}
```

## Using Tools

```typescript
import z from 'zod';

const getWeather = ai.tool({
  name: 'getWeather',
  description: 'Get current weather for a city',
  schema: z.object({
    city: z.string().describe('City name'),
  }),
  call: async ({ city }) => {
    return { temperature: 72, condition: 'sunny', city };
  },
});

const weatherBot = ai.prompt({
  name: 'weatherBot',
  description: 'Answers weather questions',
  content: 'Help the user with weather questions. Use the getWeather tool.',
  tools: [getWeather],
});

// The prompt automatically calls tools and returns the final response
for await (const event of weatherBot.run({ })) {
  if (event.type === 'text') {
    console.log(event.value);
  }
}
```

## Structured Output

```typescript
import z from 'zod';

const analyzer = ai.prompt({
  name: 'analyzer',
  description: 'Analyzes sentiment',
  content: 'Analyze the sentiment of: {{text}}',
  input: (input: { text: string }) => ({ text: input.text }),
  schema: z.object({
    sentiment: z.enum(['positive', 'negative', 'neutral']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  }),
});

const result = await analyzer.get('result', {
  text: 'I absolutely love this library!',
});

console.log(result?.sentiment);    // 'positive'
console.log(result?.confidence);   // 0.95
```

## Next Steps

- [Multi-Provider Setup](/getting-started/multi-provider) — use multiple AI providers together
- [Core Concepts](/concepts/ai-instance) — understand how @aeye works
- [Components](/components/tools) — deep dive into Tools, Prompts, and Agents
