# Audio Transcription

Convert speech to text using AI models.

## Basic Usage

```typescript
import fs from 'fs';

const audioBuffer = fs.readFileSync('recording.mp3');

const response = await ai.transcribe.get({
  audio: audioBuffer,
  language: 'en',
});

console.log(response.text);
```

## Request Options

```typescript
interface TranscriptionRequest {
  audio: Resource;         // audio file (Buffer, URL, path, etc.)
  language?: string;       // ISO language code
  prompt?: string;         // guide the model's style
  temperature?: number;    // randomness
  format?: string;         // output format
}
```

## Audio Sources

```typescript
// File buffer
{ audio: fs.readFileSync('audio.mp3') }

// URL
{ audio: 'https://example.com/audio.mp3' }

// File path
{ audio: './recording.wav' }
```

## Provider Support

| Provider | Models |
|----------|--------|
| OpenAI | whisper-1 |
| Replicate | Whisper (via adapters) |

## Streaming Transcription

```typescript
for await (const chunk of ai.transcribe.stream({
  audio: audioBuffer,
})) {
  console.log(chunk.text);
}
```
