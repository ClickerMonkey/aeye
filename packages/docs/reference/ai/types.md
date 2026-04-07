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
  generateImage?(): Function;
  editImage?(): Function;
  analyzeImage?(): Function;
  generateSpeech?(): Function;
  transcribe?(): Function;
  embed?(): Function;
  listModels?(): Promise<ModelInfo[]>;
  checkHealth?(): Promise<boolean>;
}
```

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
