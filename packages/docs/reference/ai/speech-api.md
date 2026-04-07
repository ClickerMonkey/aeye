# SpeechAPI

Text-to-speech API.

## Methods

### `get(request, ctx?)`

```typescript
const response = await ai.speech.get({
  text: 'Hello world',
  voice: 'alloy',
});
```

### `stream(request, ctx?)`

```typescript
for await (const chunk of ai.speech.stream({ text: 'Hello' })) {
  // handle audio chunks
}
```

## Request: `SpeechRequest`

```typescript
interface SpeechRequest {
  text: string;
  voice?: string;
  speed?: number;
  format?: string;
  instructions?: string;
}
```

## Response: `SpeechResponse`

```typescript
interface SpeechResponse {
  audio: ReadableStream;
  usage?: Usage;
}
```
