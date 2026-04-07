# Streaming

Streaming delivers AI responses in real-time as they're generated, enabling responsive user interfaces.

## Basic Streaming

```typescript
for await (const chunk of ai.chat.stream({
  messages: [{ role: 'user', content: 'Write a story' }],
})) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }
}
```

## Chunk Structure

```typescript
interface Chunk {
  content?: string;                  // text content fragment
  toolCallNamed?: { id, name, arguments };  // tool call started
  toolCallArguments?: { id, name, arguments }; // tool arguments streaming
  toolCall?: ToolCall;               // tool call complete
  finishReason?: FinishReason;       // stream complete
  refusal?: string;                  // refusal message
  reasoning?: Reasoning;            // reasoning fragment
  usage?: Usage;                     // token usage (final chunk)
  model?: Model;                     // model info
}
```

## Accumulating Responses

Build a complete response from chunks:

```typescript
import { getResponseFromChunks } from '@aeye/core';

const chunks: Chunk[] = [];

for await (const chunk of ai.chat.stream({ messages })) {
  chunks.push(chunk);

  if (chunk.content) {
    process.stdout.write(chunk.content);
  }
}

// Get complete response
const response = getResponseFromChunks(chunks);
console.log(response.content);      // full text
console.log(response.toolCalls);    // all tool calls
console.log(response.finishReason); // final finish reason
```

## Streaming with Tools

Tool calls are streamed incrementally:

```typescript
for await (const chunk of ai.chat.stream({ messages, tools })) {
  if (chunk.toolCallNamed) {
    console.log(`Tool started: ${chunk.toolCallNamed.name}`);
  }
  if (chunk.toolCallArguments) {
    // Arguments are streamed as they're generated
    console.log(`Arguments so far: ${chunk.toolCallArguments.arguments}`);
  }
  if (chunk.toolCall) {
    // Tool call is complete and ready to execute
    console.log(`Tool complete: ${chunk.toolCall.name}(${chunk.toolCall.arguments})`);
  }
}
```

## Prompt Streaming

Prompts provide rich event streams:

```typescript
for await (const event of myPrompt.run(input)) {
  switch (event.type) {
    case 'textPartial':
      process.stdout.write(event.value);
      break;
    case 'toolStart':
      spinner.start(`Running ${event.value.name}...`);
      break;
    case 'toolOutput':
      spinner.stop();
      break;
    case 'complete':
      console.log('\nResult:', event.value);
      break;
    case 'usage':
      console.log('Cost:', event.value.cost);
      break;
  }
}
```

## Streaming Content Only

For simple text streaming from prompts:

```typescript
const stream = await myPrompt.get('streamContent', input);
for await (const text of stream) {
  process.stdout.write(text);
}
```

## Abort / Cancellation

Cancel a streaming request using `AbortSignal`:

```typescript
const controller = new AbortController();

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);

for await (const chunk of ai.chat.stream(
  { messages },
  { signal: controller.signal }
)) {
  process.stdout.write(chunk.content ?? '');
}
```

## Usage Tracking in Streams

Usage information arrives in the final chunk:

```typescript
import { accumulateUsage } from '@aeye/core';

const usage = {};

for await (const chunk of ai.chat.stream({ messages })) {
  if (chunk.usage) {
    accumulateUsage(usage, chunk.usage);
  }
}

console.log('Total cost:', usage.cost);
```
