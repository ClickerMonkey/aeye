# ModelsAPI

Interface for searching, selecting, and managing the model registry.

## Methods

### `list(providedOnly?)`

List all registered models:

```typescript
const models = ai.models.list();        // all models
const models = ai.models.list(true);    // only models with providers
```

### `get(id)`

Get a specific model by ID:

```typescript
const model = ai.models.get('gpt-4o');
const model = ai.models.get('openai/gpt-4o'); // with provider prefix
```

### `search(criteria)`

Search and score models by criteria:

```typescript
const results = ai.models.search({
  required: ['chat', 'tools'],
  weights: { accuracy: 0.8, cost: 0.2 },
});

for (const { model, score } of results) {
  console.log(`${model.id}: ${score.toFixed(3)}`);
}
```

Returns `ScoredModel[]` sorted by score descending.

### `select(criteria)`

Select the single best model:

```typescript
const selected = ai.models.select({
  required: ['chat', 'vision'],
  tier: 'flagship',
});

console.log(selected.model.id);       // model ID
console.log(selected.provider.name);  // provider name
```

Returns `SelectedModel` or throws if no model matches.

### `refresh()`

Refresh models from providers and external sources:

```typescript
await ai.models.refresh();
```

This calls `listModels()` on each provider and `fetchModels()` on each model source.
