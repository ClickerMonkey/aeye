# DecideAPI

Typed answers about an input from a decision model: the probability a condition holds, one choice from a set, or a score on ordered levels. Only supports `.get()` (no streaming). See the [Decisions guide](/guides/decisions).

## Methods

### `get(request, ctx?)`

```typescript
const { answers } = await ai.decide.get({
  input: 'I was charged twice for my order.',
  questions: {
    billing: { type: 'predicate', instructions: 'Is this a billing problem?' },
    team: { type: 'choice', instructions: 'Which team handles it?', choices: { payments: 'Charges and refunds', web: 'Website bugs' } },
    urgency: { type: 'score', instructions: 'How urgent is it?', levels: ['Can wait', 'This week', 'Now'] },
  },
});
```

Selects a model with the `decision` capability. The usage estimate for selection and budgets counts the input and the questions.

## Request: `DecisionRequest`

```typescript
interface DecisionRequest {
  input: string | Message[];                   // the evidence: text, or a conversation
  questions: Record<string, DecisionQuestion>; // questions by name
  model?: ModelInput;
  extra?: Record<string, any>;                 // sent as-is in the request body
}
```

### `DecisionQuestion`

```typescript
type DecisionQuestion =
  | { type: 'predicate'; instructions: string }
  | { type: 'choice'; instructions: string; choices: Record<string, string> } // value → when it applies
  | { type: 'score'; instructions: string; levels: string[] };               // lowest first
```

## Response: `DecisionResponse`

```typescript
interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;     // answers by question name
  usage?: Usage;
  model: ModelInput;
}
```

### `DecisionAnswer`

```typescript
type DecisionAnswer =
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: number[]; confidence: number }
  | { type: 'refusal' };
```

Probabilities run from 0 to 1. A `score` is the probability-weighted average of the level indices, so it can fall between levels; its `probabilities` are in level order.

## Providers

A provider offers decisions by implementing `decide(request, ctx, config?)`:

| Provider | Endpoint | Default model |
|----------|----------|---------------|
| `@aeye/openai` | `/v1/decisions` | `gpt-6-luna` |
| `@aeye/openrouter` | alpha decisions endpoint | `typesafe/jev-1.14` |

::: warning
Streaming is not supported for decisions. Calling `ai.decide.stream()` will throw an error.
:::
