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
  metadata?: Record<string, any>;
}
```

### `ModelCapability`

```typescript
type ModelCapability =
  | 'chat' | 'tools' | 'vision' | 'hearing'
  | 'json' | 'structured' | 'streaming' | 'reasoning'
  | 'image' | 'audio' | 'embedding' | 'zdr';
```

### `ModelTier`

```typescript
type ModelTier = 'flagship' | 'efficient' | 'legacy' | 'experimental';
```

### `ModelPricing`

```typescript
interface ModelPricing {
  text?: { input: number; output: number; cached?: number };
  audio?: { input?: number; output?: number; perSecond?: number };
  image?: { input?: number; output?: Array<{ quality: string; sizes: Array<{ cost: number }> }> };
  reasoning?: { input: number; output: number; cached?: number };
  embeddings?: { cost: number };
  perRequest?: number;
}
```

Prices are in **dollars per million tokens** (text, reasoning, embeddings).

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
