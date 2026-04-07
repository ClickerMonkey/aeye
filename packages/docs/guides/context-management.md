# Context Management

Manage conversation history, token limits, and context window optimization.

## Conversation History

Pass messages through context:

```typescript
const messages: Message[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi! How can I help?' },
  { role: 'user', content: 'What did I just say?' },
];

const response = await ai.chat.get({ messages });
```

## Context in Prompts

Prompts access context messages via `ctx.messages`:

```typescript
const chatbot = ai.prompt({
  name: 'chatbot',
  content: 'You are a helpful assistant.',
  tools: [myTool],
});

// Messages are included automatically
const ctx = { messages };
for await (const event of chatbot.run({}, ctx)) {
  // prompt sees all previous messages
}
```

## Automatic Context Trimming

When a request exceeds the model's context window, @aeye automatically trims older messages:

- **System messages are preserved** — they're never trimmed
- **Oldest messages removed first** — most recent context is kept
- **Retry on failure** — configured via `forgetRetries`

```typescript
const prompt = ai.prompt({
  name: 'longConversation',
  content: 'Continue the conversation.',
  forgetRetries: 2, // try trimming up to 2 times
});
```

## Excluding Context Messages

Some prompts should not see conversation history:

```typescript
const standalone = ai.prompt({
  name: 'standalone',
  content: 'Translate: {{text}}',
  input: (input: { text: string }) => input,
  excludeMessages: true, // ignores ctx.messages
  schema: z.object({ translation: z.string() }),
});
```

## Token Estimation

@aeye estimates tokens for cost predictions and context management:

```typescript
// Estimate a single message
const usage = ai.estimateMessageUsage(message);

// Estimate a full request
const usage = ai.estimateRequestUsage(request);
```

Configure estimation parameters:

```typescript
const ai = AI.with()
  .providers({ openai })
  .create({
    tokens: {
      textDivisor: 4,       // ~4 chars per token
      imageFallback: 500,    // estimate 500 tokens per image
    },
  });
```

## Max Output Tokens

Control output length:

```typescript
// At the request level
const response = await ai.chat.get({
  messages,
  maxTokens: 500,
});

// In a prompt
const prompt = ai.prompt({
  config: { maxTokens: 1000 },
});

// Via context
const prompt = ai.prompt({
  config: (ctx) => ({
    maxTokens: ctx.verbose ? 2000 : 500,
  }),
});
```
