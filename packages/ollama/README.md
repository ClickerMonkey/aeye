# @aeye/ollama

Ollama provider for the @aeye (AI TypeScript) framework: local (or cloud) Ollama models for chat, embeddings, and System One decisions.

## Features

- **Chat and embeddings** through Ollama's OpenAI-compatible `/v1`, with system messages sent as `system` (Ollama's templates drop OpenAI's `developer` role)
- **Decisions** through `/v1/systemone` (Ollama v0.35+): predicates, choices, and scores, with images and `keep_alive`
- **Honest model list** from `/api/tags` and `/api/show`: what each model does (`completion`, `tools`, `thinking`, `vision`, `embedding`, `decision`) and the context window it is really served with
- **Decision limits**: decision models carry `maxQuestions` (64) and `maxRequestBytes` (64 KiB); larger calls are refused, never split
- **Extends OpenAI**: built on `@aeye/openai`'s `OpenAIProvider`

## Installation

```bash
npm install @aeye/ollama @aeye/openai @aeye/ai @aeye/core openai
```

Requires Node >= 22 and the `openai` SDK v7.

## Quick Start

```typescript
import { AI } from '@aeye/ai';
import { OllamaProvider } from '@aeye/ollama';

const ollama = new OllamaProvider({ keepAlive: '10m' });
const ai = AI.with().providers({ ollama }).create();

const response = await ai.chat.get([{ role: 'user', content: 'Hello!' }], { metadata: { model: 'qwen2.5:3b' } });

const { answers } = await ai.decide.get({
  input: 'The printer is on fire.',
  questions: { urgent: { type: 'predicate', instructions: 'Is this urgent?' } },
}, { metadata: { model: 'nimble' } });
```

## Configuration

| Option | Meaning |
|--------|---------|
| `baseURL` | Ollama's root, not `/v1` (default `http://127.0.0.1:11434`) |
| `apiKey` | A key, for Ollama's cloud |
| `contextWindow` | The window the server serves models with no `num_ctx` at (as `OLLAMA_CONTEXT_LENGTH` sets) |
| `maxContextWindow` | The most window assumed when `contextWindow` is unset |
| `keepAlive` | How long a decision model stays loaded (`'5m'`, seconds, `0` unloads, below 0 keeps) |
| `decisionModels` | Decision models, for servers whose `/api/show` lists no capabilities |
| `fetch` | The `fetch` every call goes through |

See the [Ollama provider docs](https://github.com/ClickerMonkey/aeye/tree/main/packages/docs/providers/ollama.md) and the [decisions guide](https://github.com/ClickerMonkey/aeye/tree/main/packages/docs/guides/decisions.md).

## License

GPL-3.0
