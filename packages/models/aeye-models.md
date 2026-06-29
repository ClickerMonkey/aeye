# @aeye/models

**Static, pre-scraped model catalog** for the `@aeye` AI stack. Ships ready-to-use arrays of
`ModelInfo` records (ids, pricing, capabilities, context windows, metrics, metadata) scraped from
**OpenAI**, **OpenRouter**, **Replicate**, and **AWS Bedrock**, plus a hand-curated **strict-mode
support** table and **Replicate request/response transformers** for models with non-standard APIs.

It contains **no runtime API calls** — everything is baked into TypeScript source at scrape time.
Import it, splat the data into an `AI` instance, and model selection works offline.

## When to use

- You are constructing an `@aeye/ai` `AI` instance and need a `models` list to select from.
- You need pricing / capability / context-window metadata for a known model id.
- You are using Replicate models whose input/output shape differs from the standard `@aeye`
  request/response format (you need the `replicateTransformers`).
- You want a model's strict-mode (JSON-Schema dialect) support without re-deriving it.

If you need the **type definitions** (`ModelInfo`, `ModelOverride`, etc.), those live in
`@aeye/ai` — this package only provides *data* typed against them.

## Install / import

```ts
import {
  models,              // ModelInfo[]  — all providers concatenated
  openaiModels,        // ModelInfo[]  — OpenAI only
  openrouterModels,    // ModelInfo[]  — OpenRouter only
  replicateModels,     // ModelInfo[]  — Replicate only
  awsModels,           // ModelInfo[]  — AWS Bedrock only
  strictSupport,       // ModelOverride[] — curated strict-mode overrides
  transformers,        // Record<string, ModelTransformer> — generic registry (currently empty)
  replicateTransformers, // Record<string, ReplicateTransformer> — per-model Replicate adapters
} from '@aeye/models';
```

There is a **single entry point** — `@aeye/models`. There are no subpath exports in
`package.json` (`exports` only maps `"."`). All the above come from the root.

> The `version` is published in lockstep with the rest of the monorepo (currently `0.3.8`).

## What data is provided

### The model arrays

Each provider array is a `ModelInfo[]` (type defined in `@aeye/ai`). The aggregate `models`
array is simply `[...openaiModels, ...openrouterModels, ...replicateModels, ...awsModels]`.

Approximate counts at last scrape: OpenAI ~97, OpenRouter ~344, Replicate ~304, AWS ~56.

`ModelInfo` shape (from `@aeye/ai`, abbreviated to the fields populated here):

```ts
interface ModelInfo {
  id: string;                         // e.g. "gpt-4o", "anthropic/claude-sonnet-4", "stability-ai/sdxl"
  provider: string;                   // "openai" | "openrouter" | "replicate" | "aws"
  name: string;                       // human-readable name
  contextWindow: number;              // max context tokens (0 for non-text models like image OCR)
  maxOutputTokens?: number;
  tier: 'flagship' | 'efficient' | 'legacy' | 'experimental';
  tokenizer?: ModelTokenizer;         // 'GPT' | 'Claude' | 'Gemini' | 'Other' | ...
  capabilities: Set<ModelCapability>; // see below
  supportedParameters?: Set<ModelParameter>; // 'maxTokens' | 'temperature' | 'tools' | ...
  pricing: ModelPricing;              // see below
  metrics?: ModelMetrics;             // tokensPerSecond, timeToFirstToken, averageRequestDuration, ...
  strictFormat?: 'openai' | 'anthropic' | 'google' | 'none' | string; // set via strictSupport, not in scraped data
  metadata?: Record<string, unknown>; // provider-specific extras (see per-provider notes)
}
```

**Capabilities** (`ModelCapability`): `chat`, `tools`, `vision`, `json`, `structured`,
`streaming`, `reasoning`, `image`, `audio`, `hearing`, `embedding`, `zdr`, `toolsStrict`.
(`toolsStrict` is *auto-derived* from `strictFormat`, not stored in the scraped files.)

**Pricing** (`ModelPricing`) — text/reasoning costs are **per 1M tokens**:

```ts
interface ModelPricing {
  text?:       { input?: number; output?: number; cached?: number };
  audio?:      { input?: number; output?: number; perSecond?: number };
  image?:      { input?: number; output?: {...}[] };
  reasoning?:  { input?: number; output?: number; cached?: number };
  embeddings?: { cost?: number };
  perRequest?: number;   // fixed cost per request (common for Replicate)
}
```

### Per-provider `metadata` differences

The `metadata` bag is provider-specific. Examples observed in the generated files:

- **OpenAI**: `{ knowledgeCutoff, performance, speed }`
- **OpenRouter**: `{ description, defaultParameters, canonicalSlug, huggingFaceId, created, uptime }`
  plus `metrics: { timeToFirstToken, tokensPerSecond }`
- **Replicate**: `{ owner, description, runCount, githubUrl, visibility, source, latestVersionId,
  cogVersion }` plus `metrics: { averageRequestDuration }`; pricing is usually `perRequest` or
  audio `perSecond`
- **AWS Bedrock**: `{ modelArn, providerName, responseStreamingSupported, customizationsSupported,
  inferenceTypesSupported, inputModalities, outputModalities }`

### `strictSupport` — curated strict-mode table

`strictSupport: ModelOverride[]` is the **one hand-maintained file** in `src/` (everything else is
generated). It is *not* scraped — strict-mode capability is a separate axis from the provider
listings. Each entry matches by `provider` + `modelPattern` (regex) or `modelId` and sets
`overrides.strictFormat` to a JSON-Schema dialect family:

- `'openai'` — records→array-of-pairs, optional→nullable
- `'anthropic'` — closed objects, all-required, per-request budgets
- `'google'` — `prefixItems`, `$ref: '#'` recursion, `propertyOrdering`
- `'none'` — hard opt-out (forces lenient mode even if auto-resolution would mark it strict)

Setting `strictFormat` does two things at runtime: (1) auto-derives the `'toolsStrict'`
capability for model selection, and (2) pins the JSON-Schema dialect the provider emits.
Pass it via the `AI` config's `modelOverrides` (see below). Edit
`src/strict-support.ts` by hand as new strict-capable models ship.

### Transformers

`@aeye` providers expect a standard request/response shape. Replicate models each define their
own input/output schema, so they need a per-model adapter (`ModelTransformer` from `@aeye/ai`;
`ReplicateTransformer = ModelTransformer<any, any, any>` in `@aeye/replicate`).

- `replicateTransformers: Record<string, ReplicateTransformer>` — keyed by Replicate model id
  (e.g. `"black-forest-labs/flux-schnell"`). Aggregated from ~300 individual files in
  `src/transformers/replicate/`. Each file exports a default `{ [modelId]: transformer }` and the
  index spreads them together. A transformer provides operation-specific
  `convertRequest` / `parseResponse` / `parseChunk` hooks for `chat`, `imageGenerate`,
  `imageEdit`, `imageAnalyze`, etc.
- `transformers: Record<string, ModelTransformer>` — a generic cross-provider registry. **Currently
  empty** (`src/transformers/index.ts` is a placeholder stub); prefer `replicateTransformers`.

Example transformer (`black-forest-labs/flux-schnell`):

```ts
{
  imageGenerate: {
    convertRequest: async (request, ctx) => ({
      prompt: request.prompt, num_outputs: request.n, seed: request.seed, ...request.extra,
    }),
    parseResponse: async (response, ctx) => ({
      images: await Promise.all(response.map(async (url) => ({ url: await toURL(url) }))),
    }),
  },
}
```

## How to use it

### Wire into an `AI` instance (typical)

```ts
import { AI } from '@aeye/ai';
import { models, replicateTransformers, strictSupport } from '@aeye/models';

const ai = new AI({
  providers: { /* openai, openrouter, replicate, aws ... */ },
  models,                                  // the catalog to select from
  modelOverrides: [...strictSupport],      // apply curated strict-mode dialects
  transformers: replicateTransformers,     // adapt non-standard Replicate models
});
```

This mirrors how `@aeye/cletus` (`packages/cletus/src/ai.ts`) and `@aeye/ginny`
(`packages/ginny/src/ai.ts`) consume the package. Model selection scores across every entry in
`models`; `modelOverrides` is applied on top, so you can append your own overrides after
`...strictSupport`.

### Query the data directly

It is plain data — use normal array/Set operations:

```ts
import { models } from '@aeye/models';

// Look up by id
const m = models.find(x => x.id === 'gpt-4o');

// Capability filter (capabilities is a Set)
const visionModels = models.filter(x => x.capabilities.has('vision'));

// Cheapest text model with tools + a large context window
const candidate = models
  .filter(x => x.capabilities.has('tools') && x.contextWindow >= 128_000)
  .filter(x => x.pricing.text?.input != null)
  .sort((a, b) => (a.pricing.text!.input! - b.pricing.text!.input!))[0];

// Per-provider slices are also exported directly
import { awsModels } from '@aeye/models';
const bedrockClaude = awsModels.filter(x => x.id.startsWith('anthropic.'));
```

### Custom provider re-tagging

`cletus` copies entries from `models` and rewrites `provider` to `'custom'` to expose the same
metadata under a custom provider — a pattern you can reuse: build a `Map(models.map(m => [m.id, m]))`,
clone matched entries, and override `provider`.

## How the data is generated (and how to refresh it)

All of `src/models/*.ts`, `src/models/index.ts`, and `src/index.ts` are **auto-generated** — the
header comment "Do not edit manually" is literal. Scrapers live in `scripts/scrapers/` and codegen
in `scripts/codegen.ts` (serializes `ModelInfo[]` back into TypeScript source, including
`new Set([...])` for `capabilities`/`supportedParameters`).

`scripts/scrape.ts` orchestrates all four sources, then regenerates the index files. NPM scripts:

| Script | What it does |
|---|---|
| `npm run scrape` | Scrape **all** sources and regenerate `src/index.ts` + `src/models/index.ts` |
| `npm run scrape:openai` | OpenAI only (Puppeteer-scrapes OpenAI docs pages) |
| `npm run scrape:openrouter` | OpenRouter only (API via `@aeye/openrouter`) |
| `npm run scrape:openrouter:full` | OpenRouter + performance metrics (`--metrics`, slower) |
| `npm run scrape:replicate` | Replicate models via the `replicate` npm SDK |
| `npm run scrape:replicate:models` | Replicate model data only (skip transformer generation) |
| `npm run scrape:replicate:chunk` | Regenerate transformers in chunks using an LLM (`gemini-3-pro-preview`) |
| `npm run scrape:replicate:test` | Single-model transformer dry run |
| `npm run scrape:replicate:patch` | `scripts/patch-modelinfo.ts` — patch existing model fields |
| `npm run scrape:aws` | AWS Bedrock via `@aws-sdk/client-bedrock` `ListFoundationModels` |
| `npm run build` / `typecheck` / `clean` | Standard `tsc` build / typecheck / clean |

Source-specific notes:

- **OpenAI** & **OpenRouter metrics**: use **Puppeteer** to scrape doc/model pages (needs a headless
  Chromium; may break if the page layout changes).
- **OpenRouter**: pulls from OpenRouter API endpoints via `@aeye/openrouter` (`fetchModels`,
  `fetchZDRModels`, `convertOpenRouterModel`).
- **Replicate**: uses the `replicate` SDK + `openapi-typescript` to turn each model's OpenAPI schema
  into TS types, then generates a per-model transformer (LLM-assisted; the prompt template is
  `scripts/scrapers/extract.md`). Responses are cached under `cache/replicate/`.
- **AWS**: requires AWS credentials/region; lists Bedrock foundation models and converts via
  `@aeye/aws` `convertAWSModel`. `scrape:aws` accepts `--aws-region=`.

After scraping, run `npm run build` to compile to `dist/` (the published `main`/`types` point at
`dist/src/index.*`).

## Who consumes it

- `@aeye/cletus` — `models`, `replicateTransformers`, `strictSupport`
- `@aeye/ginny` — `models`, `strictSupport`
- `@aeye/ai` tests (`ai.test.ts`, `embed-api`, `image-api`, `speech-api`) — for realistic model data

Dependencies it pulls in: `@aeye/ai` (types), `@aeye/aws`, `@aeye/openrouter`, `@aeye/replicate`.

## Gotchas

- **The data is a static snapshot and goes stale.** Pricing, context windows, new model ids, and
  deprecations only update when someone re-runs the scrapers and re-publishes. Treat it as a starting
  catalog, not a source of truth for live pricing/availability.
- **`capabilities` and `supportedParameters` are `Set`s**, not arrays — use `.has(...)`, and remember
  `JSON.stringify` will not serialize them as arrays.
- **`strictFormat` is not in the scraped files.** It only arrives via `strictSupport` →
  `modelOverrides`. Without splatting `strictSupport`, strict-mode capability (`toolsStrict`) is
  auto-resolved from provider/id heuristics at request time, not from this data.
- **`contextWindow` is `0`** for non-text models (image, OCR, TTS, etc.) — don't treat `0` as
  "unknown"; it means "not token-based".
- **`transformers` (generic) is empty** — use `replicateTransformers`. Don't expect cross-provider
  transformers here.
- **Do not hand-edit** `src/models/*.ts` or the index files — re-scraping overwrites them. The only
  hand-curated source is `src/strict-support.ts`.
- **Scrapers have external requirements**: Puppeteer/Chromium (OpenAI, OpenRouter metrics), AWS
  credentials (Bedrock), a Replicate token + an LLM key for transformer generation. They are dev-only
  (`devDependencies`) and not needed to *consume* the package.
</content>
</invoke>
