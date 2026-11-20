# Ollama Provider

Ollama runs open models on your own machine (or on Ollama's cloud). The provider chats and embeds through Ollama's OpenAI-compatible `/v1`, answers [decisions](/guides/decisions) through `/v1/systemone`, and lists models from Ollama's native API with what each can do and the context window it is really served with.

## Installation

```bash
npm install @aeye/ollama
```

Requires Node >= 22.

## Configuration

```typescript
import { OllamaProvider } from '@aeye/ollama';

const ollama = new OllamaProvider({
  baseURL: 'http://127.0.0.1:11434', // Ollama's root, not /v1 (this is the default)
  apiKey: process.env.OLLAMA_API_KEY, // only for Ollama's cloud
  contextWindow: 16_384,              // what the server serves models with no num_ctx (OLLAMA_CONTEXT_LENGTH)
  maxContextWindow: 8_192,            // the most window assumed when contextWindow is unset
  keepAlive: '10m',                   // how long a decision model stays loaded
  decisionModels: ['nimble'],         // decision models, for servers whose /api/show lists no capabilities
});
```

No model is assumed: name one per request, or let `ai` pick from `listModels()`.

## Models

`listModels()` reads `/api/tags`, then `/api/show` for each model:

| `/api/show` capability | @aeye capabilities |
|------|------|
| `completion` | `chat`, `streaming`, `json` (plus `tools` and `reasoning` when the model takes them) |
| `embedding` | `embedding` |
| `decision` | `decision`, with `maxQuestions: 64` and `maxRequestBytes: 65536` |
| `vision` | `vision` |

Servers that list no capabilities get `chat` for every model, and `decision` for the models named in `decisionModels`.

`contextWindow` is the window the model is served with: its Modelfile's `num_ctx`, else the configured `contextWindow`, else Ollama's own default for the server's version (2048 before 0.6, 4096 after), never more than the model was trained to. Ollama cuts the front of a longer prompt without a word, so this is the window to plan prompts for.

## Decisions

```typescript
const { answers } = await ai.decide.get({
  input: 'A photo from the front door camera.',
  images: [fs.readFileSync('door.jpg')],
  questions: {
    person: { type: 'predicate', instructions: 'Is someone at the door?' },
    mood: { type: 'score', instructions: 'How friendly do they look?', levels: ['Hostile', 'Neutral', 'Friendly'] },
  },
}, { metadata: { model: 'nimble' } });
```

Images go as base64, and `keepAlive` goes as `keep_alive` (a request's `extra: { keep_alive }` overrides it). Ollama takes at most 64 questions and 64 KiB of input and questions per call (images aside); a larger call is refused with a `DecisionLimitError` before it is sent. Split your questions by the model's `maxQuestions`.

## Native API helpers

`OllamaApi` (`tags`, `show`, `version`) and the helpers `servedWindow`, `numCtxOf`, `trainedLengthOf`, `unsetWindow`, `takesTools`, `reasons` and `capabilitiesOf` are exported for callers that probe a server themselves.
