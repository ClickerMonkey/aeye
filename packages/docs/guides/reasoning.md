# Reasoning Models

Some models support extended thinking (reasoning) where the model shows its thought process before answering.

## Enabling Reasoning

```typescript
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Solve this step by step: 15! / 13!' }],
  reason: 'medium', // 'low' | 'medium' | 'high'
});

console.log(response.reasoning?.content); // thought process
console.log(response.content);            // final answer
```

## Reasoning Effort Levels

| Level | Description |
|-------|-------------|
| `low` | Minimal reasoning, faster response |
| `medium` | Balanced reasoning |
| `high` | Deep reasoning, slower but more thorough |

## In Prompts

```typescript
const solver = ai.prompt({
  name: 'solver',
  content: 'Solve this problem: {{problem}}',
  input: (input: { problem: string }) => input,
  config: {
    reason: 'high',
  },
  schema: z.object({
    solution: z.string(),
    confidence: z.number(),
  }),
});
```

## Streaming Reasoning

Reasoning traces stream incrementally:

```typescript
for await (const event of solver.run(input)) {
  if (event.type === 'reasonPartial') {
    process.stdout.write(event.value.content ?? '');
  }
  if (event.type === 'reason') {
    console.log('\n--- Reasoning complete ---');
  }
  if (event.type === 'textPartial') {
    process.stdout.write(event.value);
  }
}
```

## Reasoning Structure

```typescript
interface Reasoning {
  content?: string;           // full reasoning text
  details?: ReasoningDetail[]; // structured reasoning blocks
}

interface ReasoningDetail {
  id?: string;
  type: string;        // e.g., 'thinking', 'summary'
  format: string;      // e.g., 'text', 'markdown'
  text?: string;       // reasoning text content
  summary?: string;    // brief summary
  signature?: string;  // model signature
  data?: string;       // encoded data
}
```

## Provider Support

| Provider | Models |
|----------|--------|
| OpenAI | o1, o1-mini, o3-mini |
| OpenRouter | Any reasoning model (Claude 3.5 with thinking, etc.) |
| AWS Bedrock | Claude models with extended thinking |

Models with reasoning capability are selected automatically when `reason` is set:

```typescript
const response = await ai.chat.get(
  { messages, reason: 'high' },
  { metadata: { required: ['reasoning'] } }
);
```
