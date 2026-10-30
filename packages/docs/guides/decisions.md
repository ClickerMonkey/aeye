# Decisions

Ask a decision model typed questions about some text or a conversation, and get back probabilities, a choice, or a score. Decision models answer classification, routing, and scoring questions about 10x faster and cheaper than a chat model asked for [structured output](/guides/structured-output), and their answers come with calibrated probabilities instead of a guess.

## When to Use

Use decisions when the answer is one of a known set:

- **Routing**: which team, queue, or prompt should handle a message
- **Classification**: topic, sentiment, language, spam or not
- **Guardrails**: is this message a jailbreak attempt, does it contain personal data
- **Scoring**: urgency, quality, or relevance on a fixed scale
- **Agent control**: is the task done, does the user want to stop

Use structured output instead when the answer is open-ended: extracted fields, free text, or a nested object.

## Basic Usage

```typescript
const { answers } = await ai.decide.get({
  input: 'I was charged twice for my order and nobody is answering my emails.',
  questions: {
    billing: {
      type: 'predicate',
      instructions: 'Is this a billing problem?',
    },
    team: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      choices: {
        payments: 'Charges, refunds, and invoices',
        shipping: 'Deliveries and returns',
        web: 'Website and account bugs',
      },
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this?',
      levels: ['Can wait', 'This week', 'Today', 'Right now'],
    },
  },
});
```

Each question has a name, and its answer comes back under the same name in `answers`.

## Question Types

```typescript
type DecisionQuestion =
  | { type: 'predicate'; instructions: string }
  | { type: 'choice'; instructions: string; choices: Record<string, string> }
  | { type: 'score'; instructions: string; levels: string[] };
```

| Type | Asks | Answer |
|------|------|--------|
| `predicate` | How likely a condition is true | `probability` from 0 to 1 |
| `choice` | Which one of the choices applies. `choices` maps each value to a description of when it applies. | `choice` (the most likely value), `probabilities` by value, and `confidence` |
| `score` | Where the input falls on ordered `levels`, lowest first | `score` (the probability-weighted average of the level indices, so it can fall between levels), `probabilities` in level order, and `confidence` |

## Reading Answers

An answer is a union keyed by `type`, and any question can come back as `{ type: 'refusal' }`, so narrow it before reading:

```typescript
const billing = answers.billing;
if (billing?.type === 'predicate' && billing.probability > 0.8) {
  await tagTicket('billing');
}

const team = answers.team;
if (team?.type === 'choice' && team.confidence > 0.6) {
  await assignTo(team.choice);
} else {
  await assignTo('triage');
}

const urgency = answers.urgency;
if (urgency?.type === 'score') {
  // 0 = 'Can wait' ... 3 = 'Right now'
  const level = Math.round(urgency.score);
  console.log('Urgency level', level, urgency.probabilities);
}
```

```typescript
type DecisionAnswer =
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: number[]; confidence: number }
  | { type: 'refusal' };
```

## Conversations

`input` can be a conversation instead of a string, for questions about where a chat stands:

```typescript
import type { Message } from '@aeye/core';

const messages: Message[] = [
  { role: 'user', content: 'Can you book me a table for two tonight?' },
  { role: 'assistant', content: 'Booked at 7pm at Luigi\'s.' },
  { role: 'user', content: 'Perfect, thanks!' },
];

const { answers } = await ai.decide.get({
  input: messages,
  questions: {
    done: { type: 'predicate', instructions: 'Is the user\'s request fully handled?' },
  },
});
```

## Provider Support

| Provider | Endpoint | Models | Default |
|----------|----------|--------|---------|
| OpenAI | `/v1/decisions` | `gpt-6-luna` | `gpt-6-luna` |
| OpenRouter | Alpha decisions endpoint | System One models (`typesafe/jev-1.14`, `jaredpalmer/kev-4b`), `openai/gpt-6-luna-decisions`, `liquid/d1`, `perplexity/pplx-decider-v1.2`, `upstage/solar-decide`, and others | `typesafe/jev-1.14` |

Set `defaultModels.decision` on the provider to change its default. OpenRouter's decisions endpoint is in alpha and sits outside its versioned API, so expect it to change. Replicate and AWS Bedrock don't offer decisions.

## Model Selection

Decision requests need the `decision` capability:

```typescript
const response = await ai.decide.get(
  { input, questions },
  { metadata: { model: 'jaredpalmer/kev-4b' } },
);
```

## Costs

Decision models read the input and questions, and write almost nothing, so a request costs little more than its input tokens. OpenAI reports token usage, which @aeye prices from the model's pricing. OpenRouter reports the cost of each request, which comes back as `response.usage.cost`. Either way hooks and [cost tracking](/concepts/cost-tracking) see it.

::: warning
The Decide API only supports `.get()`. Streaming is not available.
:::
