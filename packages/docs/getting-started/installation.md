# Installation

@aeye is a modular library distributed as separate npm packages. Install only what you need.

## Core Packages

Every project needs the core and AI packages:

```bash
npm install @aeye/ai @aeye/core
```

## Provider Packages

Install one or more provider packages depending on which AI services you want to use:

```bash
# OpenAI (GPT-4, DALL-E, Whisper, TTS, Embeddings)
npm install @aeye/openai openai

# OpenRouter (access hundreds of models from multiple providers)
npm install @aeye/openrouter

# Replicate (open-source models)
npm install @aeye/replicate replicate

# AWS Bedrock (Claude, Llama, Mistral, Titan, Stability)
npm install @aeye/aws
```

## Model Registry (Optional)

The `@aeye/models` package provides pre-built model definitions with pricing, capabilities, and metadata for all supported providers:

```bash
npm install @aeye/models
```

This is optional — providers can discover models at runtime via `ai.models.refresh()`.

## Requirements

- **Node.js** 18+ (uses native `fetch`, `crypto.randomUUID`, etc.)
- **TypeScript** 5.0+ (recommended for full type safety)
- **Zod** 3.x (peer dependency for schema validation)

```bash
npm install zod
```

## TypeScript Configuration

@aeye uses modern TypeScript features. Recommended `tsconfig.json` settings:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true
  }
}
```
