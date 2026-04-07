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
  text: string;            // text to speak
  voice?: string;          // voice name (provider-specific)
  speed?: number;          // speaking speed
  format?: string;         // output format (mp3, wav, etc.)
  instructions?: string;   // style instructions (if supported)
}
```

## Available Voices

Voices are provider-specific:

**OpenAI**: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`

## Provider Support

| Provider | Models |
|----------|--------|
| OpenAI | tts-1, tts-1-hd |

## Model Selection

```typescript
const response = await ai.speech.get(
  { text: 'Hello world' },
  { metadata: { model: 'tts-1-hd' } }
);
```
