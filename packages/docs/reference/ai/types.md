# @aeye/ai — Types

Types specific to the AI layer.

## Context Types

### `AIBaseContext<T>`

```typescript
interface AIBaseContext<T extends AIBaseTypes> {
  ai: AI<T>;
  metadata?: AIMetadata<T>;
  signal?: AbortSignal;
}
```

### `AIContext<T>`

User context merged with `AIBaseContext`:

```typescript
type AIContext<T> = AIBaseContext<T> & UserContext<T>;
```

### `AIContextRequired<T>`

Context fields that must be provided at call time (fields not covered by defaults/providedContext).

### `AIContextOptional<T>`

Optional wrapper making all context fields optional.

## Metadata Types

### `AIBaseMetadata`

```typescript
interface AIBaseMetadata<TProviders> {
  model?: ModelInput;
  required?: ModelCapability[];
  optional?: ModelCapability[];
  requiredParameters?: ModelParameter[];
  optionalParameters?: ModelParameter[];
  providers?: {
    allow?: TProviders[];
    deny?: TProviders[];
  };
  pricing?: RangeConstraint<ModelPricing>;
  contextWindow?: RangeConstraint<number>;
  outputTokens?: RangeConstraint<number>;
  metrics?: RangeConstraint<ModelMetrics>;
  weights?: ModelSelectionWeights;
  weightProfile?: string;
  tier?: ModelTier;
}
```

### `RangeConstraint<T>`

```typescript
interface RangeConstraint<T> {
  min?: Partial<T>;
  max?: Partial<T>;
  target?: Partial<T>;
}
```

## Hooks

### `AIHooks<T>`

```typescript
interface AIHooks<T extends AIBaseTypes> {
  beforeModelSelection?: (ctx, request, metadata) => AIMetadata | Promise<AIMetadata>;
  onModelSelected?: (ctx, request, selected) => SelectedModel | void | Promise<...>;
  beforeRequest?: (ctx, request, selected, estimatedUsage, estimatedCost) => void | Promise<void>;
  afterRequest?: (ctx, request, response, complete, selected, usage, cost) => void | Promise<void>;
  onError?: (errorType, message, error?, ctx?, request?) => void;
}
```

## Provider Types

### `Provider<TConfig>`

```typescript
interface Provider<TConfig = any> {
  readonly name: string;
  readonly config: TConfig;
  defaultMetadata?: any;
  createExecutor?(): Executor;
  createStreamer?(): Streamer;
  generateImage?(request, ctx, config?): Promise<ImageGenerationResponse>;
  editImage?(request, ctx, config?): Promise<ImageGenerationResponse>;
  analyzeImage?(request, ctx, config?): Promise<Response>;
  speech?(request, ctx, config?): Promise<SpeechResponse>;
  transcribe?(request, ctx, config?): Promise<TranscriptionResponse>;
  embed?(request, ctx, config?): Promise<EmbeddingResponse>;
  rerank?(request: RerankRequest, ctx, config?): Promise<RerankResponse>;
  decide?(request: DecisionRequest, ctx, config?): Promise<DecisionResponse>;
  submitBatch?(requests: Request[], ctx, config?): Promise<BatchJob>;
  getBatch?(job: BatchJob, ctx, config?): Promise<BatchJob>;
  listModels?(config?): Promise<ModelInfo[]>;
  checkHealth(config?): Promise<boolean>;
}
```

A provider that implements `rerank` gains the `rerank` capability, and one that implements `decide` gains `decision`.

### `ModelHandler`

Per-model overrides for the APIs. Besides `chat`, `imageGenerate`, `imageEdit`, `imageAnalyze`, `transcribe`, `speech`, and `embed`, a handler can supply `rerank.get` and `decide.get`.

## Model Capabilities

### `ModelCapability`

```typescript
type ModelCapability =
  | 'chat' | 'tools' | 'vision' | 'files' | 'videoInput' | 'hearing'
  | 'json' | 'structured' | 'streaming' | 'reasoning'
  | 'image' | 'audio' | 'embedding'
  | 'rerank'      // orders documents by relevance to a query
  | 'decision'    // typed answers (probabilities, choices, scores) about an input
  | 'zdr' | 'toolsStrict';
```

`ai.rerank` requires `rerank` and `ai.decide` requires `decision`.

## Request / Response Types

| API | Request | Response | Reference |
|-----|---------|----------|-----------|
| `ai.embed` | `EmbeddingRequest` | `EmbeddingResponse` | [EmbedAPI](/reference/ai/embed-api) |
| `ai.rerank` | `RerankRequest` | `RerankResponse` | [RerankAPI](/reference/ai/rerank-api) |
| `ai.decide` | `DecisionRequest` (`DecisionQuestion`) | `DecisionResponse` (`DecisionAnswer`) | [DecideAPI](/reference/ai/decide-api) |
| `ai.batch` | `Request[]` | `BatchJob` (`BatchResult`, `BatchStatus`) | [BatchAPI](/reference/ai/batch-api) |

## Configuration

### `AIConfig`

```typescript
interface AIConfig<TContext, TMetadata, TProviders> {
  defaultContext?: StrictPartial<TContext>;
  providedContext?: (ctx) => Promise<StrictPartial<TContext>>;
  defaultMetadata?: StrictPartial<TMetadata & AIBaseMetadata>;
  providedMetadata?: (meta) => Promise<StrictPartial<TMetadata> & AIBaseMetadata>;
  providers: TProviders;
  models?: ModelInfo[];
  modelOverrides?: ModelOverride[];
  modelHandlers?: ModelHandler[];
  modelSources?: ModelSource[];
  defaultWeights?: ModelSelectionWeights;
  weightProfiles?: Record<string, ModelSelectionWeights>;
  tokens?: TokenConfig;
  defaultCostPerMillionTokens?: number;
}
```

## Statistics

### `LibraryStats`

```typescript
interface LibraryStats {
  totalModels: number;
  modelsByProvider: Record<string, number>;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageCost: number;
  averageLatency: number;
}
```
