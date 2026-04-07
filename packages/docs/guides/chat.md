# Chat Completions

The Chat API is the primary way to interact with AI models in @aeye.

## Basic Usage

```typescript
const response = await ai.chat.get({
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is TypeScript?' },
  ],
});

console.log(response.content);       // response text
console.log(response.finishReason);  // 'stop', 'length', 'tool_calls', etc.
console.log(response.usage);         // token usage
```

## Request Options

```typescript
const response = await ai.chat.get({
  messages,
  temperature: 0.7,       // randomness (0-2)
  maxTokens: 1000,         // max output tokens
  topP: 0.9,               // nucleus sampling
  frequencyPenalty: 0.5,   // reduce repetition
  presencePenalty: 0.5,    // encourage new topics
  stop: ['\n\n'],          // stop sequences
  responseFormat: 'json',  // force JSON output
});
```

## Multi-Modal Messages

Send images, audio, and files alongside text:

```typescript
const response = await ai.chat.get({
  messages: [{
    role: 'user',
    content: [
      { type: 'text', content: 'What do you see?' },
      { type: 'image', content: 'https://example.com/photo.jpg' },
    ],
  }],
});
```

Content types: `'text'`, `'image'`, `'audio'`, `'file'`

Resources can be URLs, base64 data URIs, `Buffer`, `Blob`, `Uint8Array`, or file paths.

## With Context

Pass application context for use in hooks:

```typescript
const response = await ai.chat.get(
  { messages },
  { userId: 'user123', sessionId: 'sess456' }
);
```

## With Metadata

Control model selection:

```typescript
const response = await ai.chat.get(
  { messages },
  {
    metadata: {
      model: 'gpt-4o',                // specific model
      required: ['chat', 'tools'],     // required capabilities
      weights: { accuracy: 0.8 },      // scoring weights
    },
  }
);
```

## Response Structure

```typescript
interface Response {
  content: string;                    // generated text
  toolCalls?: ToolCall[];             // tool calls (if any)
  finishReason: FinishReason;         // why the model stopped
  refusal?: string;                   // refusal message (if any)
  reasoning?: Reasoning;             // reasoning trace (if available)
  usage?: Usage;                      // token usage and cost
  model?: Model;                      // model that was used
}
```

## Finish Reasons

| Reason | Description |
|--------|-------------|
| `stop` | Model completed naturally |
| `length` | Hit max token limit |
| `tool_calls` | Model wants to call tools |
| `content_filter` | Blocked by content filter |
| `refusal` | Model refused the request |
