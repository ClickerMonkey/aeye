# Model Registry

The `ModelRegistry` class manages model registration, search, scoring, and selection.

## Key Types

### `ModelInfo`

```typescript
interface ModelInfo<TProvider = string> {
  id: string;
  provider: TProvider;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  tier: ModelTier;
  capabilities: Set<ModelCapability>;
  supportedParameters: Set<ModelParameter>;
  pricing: ModelPricing;
  metrics?: ModelMetrics;
  tokenizer?: ModelTokenizer;
  strictFormat?: DescriptorFamily | 'none';
  reasoningEfforts?: ReasoningEffort[]; // accepted efforts, lowest to highest (all when omitted)
  retiresAt?: string;                   // YYYY-MM-DD; retired models are never selected
  metadata?: Record<string, any>;
}
```

### `ModelCapability`

```typescript
type ModelCapability =
  | 'chat' | 'tools' | 'vision' | 'files' | 'videoInput' | 'hearing'
  | 'json' | 'structured' | 'streaming' | 'reasoning'
  | 'image' | 'audio' | 'audioOutput' | 'embedding' | 'zdr'
  | 'toolsStrict';
```

### `ModelTier`

```typescript
type ModelTier = 'flagship' | 'efficient' | 'legacy' | 'experimental';
```

### `ModelPricing`

```typescript
interface ModelPricing {
  text?: { input?: number; output?: number; cached?: number; cacheWrite?: number };
  audio?: { input?: number; output?: number; perSecond?: number };
  image?: {
    input?: number;
    tokens?: number; // per 1M output image tokens (GPT Image 2 and later)
    output?: Array<{ quality: string; sizes: Array<{ width: number; height: number; cost: number }> }>; // per image
  };
  reasoning?: { input?: number; output?: number; cached?: number };
  embeddings?: { cost?: number };
  tools?: Partial<Record<HostedToolType, number>>; // per hosted tool call
  perRequest?: number;
}
```

Prices are in **dollars per million tokens** (text, reasoning, embeddings, image tokens). `tools` is per call and `perRequest` per request. When a model has no reasoning price, reasoning tokens bill as output; unpriced cache reads and writes bill as input.

### `ModelMetrics`

```typescript
interface ModelMetrics {
  tokensPerSecond?: number;
  latencyMs?: number;
  accuracyScore?: number;
}
```

### `ModelSelectionWeights`

```typescript
interface ModelSelectionWeights {
  cost: number;
  speed: number;
  accuracy: number;
  contextWindow?: number;
}
```

### `ScoredModel`

```typescript
interface ScoredModel<TProvider = string> {
  model: ModelInfo<TProvider>;
  score: number;
  provider?: Provider;
}
```

### `SelectedModel`

```typescript
interface SelectedModel<TProviders, TProviderName = string> {
  model: ModelInfo<TProviderName>;
  provider: Provider;
  config?: Partial<Request>;
}
```

### `ModelParameter`

```typescript
type ModelParameter =
  | 'temperature' | 'maxTokens' | 'topP' | 'topK'
  | 'frequencyPenalty' | 'presencePenalty' | 'stop'
  | 'logProbabilities' | 'logitBias' | 'seed' | 'n'
  | 'responseFormat' | 'toolChoice'
  | 'speechVoice' | 'speechSpeed' | 'speechInstructions'
  | 'transcribePrompt' | 'transcribeStream'
  | 'embeddingDimensions'
  | 'imageMultiple' | 'imageBackground' | 'imageFormat' | 'imageStyle' | 'imageStream';
```

### `ModelOverride`

```typescript
interface ModelOverride<TProvider = string> {
  provider?: TProvider;
  modelId?: string;
  modelPattern?: RegExp;
  overrides: Partial<Omit<ModelInfo, 'id' | 'provider'>>;
}
```

### `ModelSource`

```typescript
interface ModelSource {
  name: string;
  fetchModels(config?: any): Promise<ModelInfo[]>;
}
```

## Scoring Algorithm

See [Model Selection guide](/guides/model-selection) for the full scoring algorithm explanation.
