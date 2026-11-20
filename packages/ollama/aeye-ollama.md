# @aeye/ollama

One-line purpose: Ollama provider for `@aeye/ai` — local (or cloud) Ollama models for chat, embeddings and System One decisions, with the model list, capabilities and the context window each model is really served with read from Ollama's native API. Built as a subclass of `@aeye/openai`'s `OpenAIProvider`.

## When to use

- You run models on a local Ollama (or Ollama's cloud) and want them in the same `AI` instance as other providers.
- You want fast typed decisions (`ai.decide`) from an Ollama System One model (`/v1/systemone`, Ollama v0.35+), optionally over images.
- You need honest context windows: Ollama silently cuts the front of a prompt longer than the window it serves (`num_ctx`), whatever the model was trained to.

## Install / import

```bash
npm install @aeye/ollama
```

`@aeye/openai`, `@aeye/ai`, `@aeye/core`, and `openai` (v7) ship as dependencies. Requires Node >= 22.

```typescript
import {
  OllamaProvider,
  type OllamaConfig,
  type OllamaOptions,
  OLLAMA_SYSTEM_ONE_LIMITS,
  capabilitiesOf,
  // native API and served-window helpers
  OllamaApi,
  type OllamaShow,
  type OllamaTags,
  OLLAMA_BASE_URL,
  numCtxOf,
  trainedLengthOf,
  servedDefault,
  unsetWindow,
  servedWindow,
  takesTools,
  reasons,
} from '@aeye/ollama';
```

The provider's registry name is `ollama`.

## Register with an `@aeye/ai` instance

```typescript
import { AI } from '@aeye/ai';
import { OllamaProvider } from '@aeye/ollama';

const ollama = new OllamaProvider({ keepAlive: '10m' });
const ai = AI.with().providers({ ollama }).create();
await ai.models.refresh(); // lists the server's models

await ai.chat.get([{ role: 'user', content: 'Hi' }], { metadata: { model: 'qwen2.5:3b' } });

const { answers } = await ai.decide.get({
  input: 'The printer is on fire.',
  images: [photo],                       // optional, needs a `vision` decision model
  questions: { urgent: { type: 'predicate', instructions: 'Is this urgent?' } },
}, { metadata: { model: 'nimble' } });
```

## Configuration (`OllamaConfig`)

`OllamaConfig extends OpenAIConfig`; `apiKey` is optional (a local server takes none; a key is sent as a bearer token, for Ollama's cloud).

| Option | Meaning |
|--------|---------|
| `baseURL` | Ollama's root, not `/v1` (default `http://127.0.0.1:11434`) |
| `contextWindow` | The window the server serves models whose Modelfile sets no `num_ctx` (as `OLLAMA_CONTEXT_LENGTH` does) |
| `maxContextWindow` | The most window assumed when `contextWindow` is unset |
| `keepAlive` | Sent as `keep_alive` on decisions: a duration (`'5m'`) or seconds (`0` unloads, below 0 keeps loaded) |
| `decisionModels` | Decision models, for servers whose `/api/show` lists no capabilities |
| `fetch` | The `fetch` every call goes through (native API and `/v1`) |

## Models and capabilities

`listModels()` reads `/api/tags`, then `/api/show` per model and `/api/version`:

- Capabilities come from `/api/show`'s `capabilities` when listed: `completion` → `chat`, `streaming`, `json`; plus `embedding` (text only: Ollama's embed endpoints take no images, so no model gets `imageEmbedding` and an image input throws `ImageEmbeddingError`), `decision`, `vision`; `tools` and `reasoning` for chat models. A server that lists none: a model named in `decisionModels` (with or without `:latest`) is a decision model, every other one a chat model (tools from the template, reasoning from the template or name).
- `contextWindow` is the served window: the Modelfile's `num_ctx`, else `contextWindow`, else Ollama's default for the server's version (2048 before 0.6, 4096 after) held to `maxContextWindow`, never above the trained length.
- Pricing is zero; tier is `efficient`.
- Decision models carry `OLLAMA_SYSTEM_ONE_LIMITS`: `maxQuestions: 64` and `maxRequestBytes: 65536`.

## Decisions (`/v1/systemone`)

`decide()` sends System One's shape (shared with OpenRouter, from `@aeye/openai`'s `toSystemOneParams`): `state` (text, or the conversation as chat messages with `system` roles), `questions` (`noul` / `choice` / `score`), `images` as plain base64, and `keep_alive` from `keepAlive`. The request's `extra` overrides any of them. Answers are parsed with `fromSystemOneAnswers`: score probabilities come back keyed by level index and are put in level order.

## Gotchas

- **No splitting.** A decision call over `maxQuestions` (64) or `maxRequestBytes` (64 KiB of state and questions; images don't count) is refused with `DecisionLimitError` before anything is sent. The caller splits its questions by `model.maxQuestions`.
- System messages go to Ollama as `system`, not OpenAI's `developer` role, which Ollama's chat templates drop without a word.
- Ollama's OpenAI-compatible endpoint takes no `num_ctx`: set it in the Modelfile or with `OLLAMA_CONTEXT_LENGTH` on the server, and tell the provider with `contextWindow`.
- No model is assumed: there are no default models; pass `metadata.model` or let selection pick from the listed ones.
