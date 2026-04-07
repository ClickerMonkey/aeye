# Model Selection

@aeye's model selection system automatically picks the best model for each request using a weighted scoring algorithm.

## How Selection Works

1. **Filter** — models are filtered by required capabilities, provider restrictions, and constraints
2. **Score** — remaining models are scored on cost, speed, accuracy, and context window
3. **Rank** — models are sorted by weighted score
4. **Select** — the highest-scoring model is used

## Scoring Weights

```typescript
interface ModelSelectionWeights {
  cost: number;          // lower cost = higher score
  speed: number;         // faster = higher score
  accuracy: number;      // more capable = higher score
  contextWindow?: number; // larger context = higher score
}
```

Default: `{ cost: 0.5, speed: 0.3, accuracy: 0.2 }`

### How Each Factor is Scored

**Cost**: Inversely proportional to price. `score = 1 / (1 + avgCost / 10)`

**Speed**: Based on tokens per second. `score = Math.min(tokensPerSecond / 100, 1)`

**Accuracy**: Based on model tier:
- `flagship` → 1.0
- `efficient` → 0.7
- `experimental` → 0.5
- `legacy` → 0.3

If `ModelMetrics.accuracyScore` is available, it's used instead.

**Context Window**: `score = Math.min(contextWindow / 100000, 1)`

## Applying Weights

### At Creation

```typescript
const ai = AI.with()
  .providers({ openai, openrouter })
  .create({
    defaultWeights: { cost: 0.4, speed: 0.3, accuracy: 0.3 },
  });
```

### Per Request

```typescript
const response = await ai.chat.get(
  { messages },
  { metadata: { weights: { cost: 0.1, accuracy: 0.9 } } }
);
```

### Named Profiles

```typescript
const ai = AI.with()
  .providers({ openai })
  .create({
    weightProfiles: {
      cheap: { cost: 0.9, speed: 0.05, accuracy: 0.05 },
      fast: { cost: 0.1, speed: 0.8, accuracy: 0.1 },
      precise: { cost: 0.1, speed: 0.1, accuracy: 0.8 },
    },
  });

const response = await ai.chat.get(
  { messages },
  { metadata: { weightProfile: 'precise' } }
);
```

## Constraints

Narrow candidates before scoring:

```typescript
const response = await ai.chat.get(
  { messages },
  {
    metadata: {
      // Required capabilities (must have ALL)
      required: ['chat', 'tools', 'vision'],

      // Optional capabilities (bonus if present)
      optional: ['streaming', 'json'],

      // Provider filter
      providers: { allow: ['openai', 'openrouter'] },

      // Context window
      contextWindow: { min: 32000, max: 200000 },

      // Output tokens
      outputTokens: { min: 4000 },

      // Pricing ceiling ($/M tokens)
      pricing: {
        max: { text: { input: 15, output: 60 } },
      },

      // Model tier
      tier: 'flagship',
    },
  }
);
```

## Inspecting Selection

Use the Models API to see how models are scored:

```typescript
const results = ai.models.search({
  required: ['chat', 'tools'],
  weights: { accuracy: 0.8, cost: 0.2 },
});

for (const { model, score } of results.slice(0, 5)) {
  console.log(`${model.id}: ${score.toFixed(3)} (${model.provider})`);
}
```

## Explicit Model

Bypass selection entirely:

```typescript
const response = await ai.chat.get(
  { messages },
  { metadata: { model: 'gpt-4o' } }
);

// Or with provider prefix
const response = await ai.chat.get(
  { messages },
  { metadata: { model: 'openai/gpt-4o' } }
);
```

## Hook Override

Override selection in hooks:

```typescript
ai.withHooks({
  beforeModelSelection: async (ctx, request, metadata) => {
    // Modify metadata to influence selection
    if (ctx.user.tier === 'premium') {
      return { ...metadata, tier: 'flagship' };
    }
    return metadata;
  },
  onModelSelected: async (ctx, request, selected) => {
    console.log(`Selected: ${selected.model.id}`);
    // Return a different SelectedModel to override
  },
});
```
