# Speech Synthesis (TTS)

Convert text to speech using AI models.

## Basic Usage

```typescript
const response = await ai.speech.get({
  text: 'Hello! This is a text-to-speech example.',
  voice: 'alloy',
});

// Save to file
import fs from 'fs';
import { Readable } from 'stream';

const fileStream = fs.createWriteStream('output.mp3');
Readable.fromWeb(response.audio).pipe(fileStream);
```

## Request Options

```typescript
interface SpeechRequest {
  text: string;                 // text to speak
  voice?: string;               // voice name or custom voice id
  speed?: number;               // speaking speed (0.25 - 4.0)
  responseFormat?: AudioFormat; // 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'
  instructions?: string;        // style instructions (if supported)
}
```

## Available Voices

Voices are provider-specific. The voice is passed through as given, so any built-in voice name or a custom voice id works.

**OpenAI**: built-in voices such as `alloy` (the default), `marin`, `cedar`, `coral`, `ash`, or a custom voice id.

## Provider Support

| Provider | Models |
|----------|--------|
| OpenAI | gpt-4o-mini-tts (default), tts-1, tts-1-hd |
| OpenRouter | Speech models it lists, through its OpenAI-compatible endpoint (no default model) |

## Model Selection

```typescript
const response = await ai.speech.get(
  { text: 'Hello world' },
  { metadata: { model: 'gpt-4o-mini-tts' } }
);
```

Chat models with the `audioOutput` capability can also speak their answer; see `modalities` and `audio` on chat requests.
