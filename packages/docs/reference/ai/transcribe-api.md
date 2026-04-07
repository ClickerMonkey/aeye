# TranscribeAPI

Speech-to-text API.

## Methods

### `get(request, ctx?)`

```typescript
const response = await ai.transcribe.get({
  audio: fs.readFileSync('recording.mp3'),
  language: 'en',
});
console.log(response.text);
```

### `stream(request, ctx?)`

```typescript
for await (const chunk of ai.transcribe.stream({ audio })) {
  console.log(chunk.text);
}
```

## Request: `TranscriptionRequest`

```typescript
interface TranscriptionRequest {
  audio: Resource;
  language?: string;
  prompt?: string;
  temperature?: number;
  format?: string;
}
```

## Response: `TranscriptionResponse`

```typescript
interface TranscriptionResponse {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    text: string;
    start: number;
    end: number;
  }>;
  usage?: Usage;
}
```
