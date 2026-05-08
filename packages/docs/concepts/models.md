# Models & Selection

@aeye maintains a model registry and uses a weighted scoring algorithm to automatically select the best model for each request.

## Model Information

Every model is described by a `ModelInfo` object:

```typescript
interface ModelInfo {
  id: string;                          // e.g., 'gpt-4o', 'claude-3-sonnet'
  provider: string;                    // e.g., 'openai', 'aws'
  name: string;                        // Human-readable name
  contextWindow: number;               // Max input tokens
  maxOutputTokens: number;             // Max output tokens
  tier: ModelTier;                     // 'flagship' | 'efficient' | 'legacy' | 'experimental'
  capabilities: Set<ModelCapability>;  // What the model can do
  supportedParameters: Set<ModelParameter>;
  pricing: ModelPricing;               // Cost per million tokens
  metrics?: ModelMetrics;              // Performance benchmarks
  metadata?: Record<string, any>;      // Provider-specific data
}
```

## Capabilities

Models declare their capabilities:

| Capability | Description |
|-----------|-------------|
| `chat` | Text chat completions |
| `tools` | Function/tool calling |
| `vision` | Image understanding |
| `hearing` | Audio input |
| `json` | JSON output mode |
| `structured` | Schema-enforced output |
| `streaming` | Streaming responses |
| `reasoning` | Extended thinking (o1, etc.) |
| `image` | Image generation |
| `audio` | Audio output |
| `embedding` | Text embeddings |
| `zdr` | Zero Data Retention |

## Model Selection

### Automatic Selection

When no model is specified, @aeye uses weighted scoring:

```typescript
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Hello' }],
});
// AI selected the best model based on defaultWeights
```

### Selection Weights

Four factors are scored and combined:

```typescript
interface ModelSelectionWeights {
  cost: number;         // Lower cost = higher score
  speed: number;        // Higher tokens/sec = higher score
  accuracy: number;     // Based on tier or metrics
  contextWindow: number; // Larger context = higher score (optional)
}
```

Default weights: `{ cost: 0.5, speed: 0.3, accuracy: 0.2 }`

### Selection Constraints

Narrow the candidate pool with metadata:

```typescript
const response = await ai.chat.get(
  { messages },
  {
    metadata: {
      // Required capabilities (model must have ALL)
      required: ['chat', 'tools', 'vision'],

      // Optional capabilities (bonus score if present)
      optional: ['streaming'],

      // Provider filtering
      providers: { allow: ['openai'], deny: ['replicate'] },

      // Context window constraints
      contextWindow: { min: 32000 },

      // Output token constraints
      outputTokens: { min: 4000 },

      // Pricing constraints
      pricing: {
        max: { text: { input: 10, output: 30 } }, // $/M tokens
      },

      // Model tier
      tier: 'flagship',

      // Custom weights for this request
      weights: { cost: 0.2, speed: 0.3, accuracy: 0.5 },
    },
  }
);
```

## Models API

Interact with the model registry directly:

```typescript
// List all available models
const all = ai.models.list();

// Get a specific model
const model = ai.models.get('gpt-4o');
const model2 = ai.models.get('openai/gpt-4o'); // with provider prefix

// Search with scoring
const results = ai.models.search({
  required: ['chat', 'tools'],
  weights: { accuracy: 0.8, cost: 0.2 },
});

// Select the best match
const best = ai.models.select({
  required: ['chat', 'vision'],
});

// Refresh from providers and external sources
await ai.models.refresh();
```

## Model Overrides

Customize model properties without modifying providers:

```typescript
const ai = AI.with()
  .providers({ openai })
  .create({
    modelOverrides: [
      {
        modelPattern: /gpt-4/,
        overrides: {
          pricing: { text: { input: 30, output: 60 } },
        },
      },
      {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        overrides: {
          tier: 'efficient',
        },
      },
    ],
  });
```

## Model Sources

Fetch model information from external APIs:

```typescript
import { OpenRouterModelSource } from '@aeye/openrouter';

const ai = AI.with()
  .providers({ openrouter })
  .create({
    modelSources: [
      new OpenRouterModelSource({ apiKey: process.env.OPENROUTER_API_KEY }),
    ],
  });

// Models are fetched on first use or via refresh
await ai.models.refresh();
```

## Pre-built Model Registry

Use `@aeye/models` for static model definitions:

```typescript
import { models, strictSupport } from '@aeye/models';

const ai = AI.with()
  .providers({ openai })
  .create({
    models,
    // Curated strict-mode dialect declarations. Opts strict-capable model
    // families (gpt-4o+, claude 4.5+, gemini 2.0+) into the `'toolsStrict'`
    // capability and pins their JSON-Schema dialect. Without this, every
    // model defaults to lenient even when the underlying API supports strict.
    modelOverrides: [...strictSupport],
  });
```

`strictSupport` is a `ModelOverride[]` you can splat alongside your own
overrides. It only adds `strictFormat` (auto-derives the `'toolsStrict'`
capability) — it doesn't touch pricing, tiers, or other fields, so it's
safe to combine with arbitrary overrides:

```typescript
modelOverrides: [
  ...strictSupport,
  { modelPattern: /gpt-4/, overrides: { tier: 'flagship' } },
],
```
