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
  responseFormat?: 'json' | 'text' | 'srt' | 'vtt' | 'verbose_json' | 'diarized_json';
  timestampGranularities?: Array<'word' | 'segment'>;
  knownSpeakers?: Array<{ name: string; audio: Resource }>; // reference clips for diarization
}
```

The response has `text` and, when the format provides them, timed `segments` (`{ id, start, end, text, speaker? }`).

## Speaker Diarization

`diarized_json` labels each segment with its speaker. Give `knownSpeakers` short reference clips to name them:

```typescript
const response = await ai.transcribe.get(
  {
    audio: './meeting.mp3',
    responseFormat: 'diarized_json',
    knownSpeakers: [
      { name: 'Alice', audio: './alice.wav' },
      { name: 'Bob', audio: './bob.wav' },
    ],
  },
  { metadata: { model: 'gpt-4o-transcribe-diarize' } }
);

for (const segment of response.segments ?? []) {
  console.log(`${segment.speaker}: ${segment.text}`);
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
| OpenAI | gpt-transcribe (default), gpt-4o-transcribe, gpt-4o-transcribe-diarize, whisper-1 |
| OpenRouter | Transcription models it lists (default `openai/gpt-transcribe`); no streaming |
| Replicate | Whisper (via adapters) |

## Streaming Transcription

```typescript
for await (const chunk of ai.transcribe.stream({
  audio: audioBuffer,
})) {
  console.log(chunk.delta ?? chunk.text);
}
```
