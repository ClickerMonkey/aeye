# Reasoning Models

Some models support extended thinking (reasoning) where the model shows its thought process before answering.

## Enabling Reasoning

```typescript
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'Solve this step by step: 15! / 13!' }],
  reason: { effort: 'medium' },
});

console.log(response.reasoning?.content); // thought process
console.log(response.content);            // final answer
```

## Reason Options

```typescript
interface Reason {
  effort?: ReasoningEffort;   // 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTokens?: number;         // token budget, for budget-based providers
  mode?: 'pro';               // spend more compute on the same model
  context?: 'auto' | 'all_turns' | 'current_turn'; // keep earlier turns' reasoning in context
  summary?: 'auto' | 'concise' | 'detailed';       // ask for a readable summary
  exclude?: boolean;          // reason without returning the reasoning
}
```

## Reasoning Effort Levels

`REASONING_EFFORTS` (from `@aeye/core`) lists the levels from cheapest to most thorough:

| Level | Description |
|-------|-------------|
| `none` | No reasoning, fastest response |
| `minimal` | Very little reasoning |
| `low` | Light reasoning, faster response |
| `medium` | Balanced reasoning |
| `high` | Deep reasoning, slower but more thorough |
| `xhigh` | Deeper still |
| `max` | The most the model offers |

Models accept different subsets. When a model's `ModelInfo.reasoningEfforts` lists the levels it accepts, the requested effort is clamped to the nearest accepted one (`clampReasoningEffort` from `@aeye/ai`), so `max` on a model that tops out at `xhigh` sends `xhigh`. Reasoning asked for stays on: `low` on a model that takes `none`, `high` and `xhigh` sends `high`, never `none`. `none` is only sent when asked for or when it is all the model accepts, so `none` on o3 (`low`, `medium`, `high`) sends `low`.

```typescript
import { clampReasoningEffort } from '@aeye/ai';

clampReasoningEffort('max', ['none', 'low', 'medium', 'high', 'xhigh']); // 'xhigh'
clampReasoningEffort('low', ['none', 'high', 'xhigh']);                  // 'high'
clampReasoningEffort('none', ['low', 'medium', 'high']);                 // 'low'
clampReasoningEffort('medium');                                           // 'medium' (acceptance unknown)
```

`@aeye/models` lists the accepted efforts for OpenAI models whose pages don't: the o-series takes `low` to `high`, and `gpt-5-mini` / `gpt-5-nano` add `minimal`.

## In Prompts

```typescript
const solver = ai.prompt({
  name: 'solver',
  content: 'Solve this problem: {{problem}}',
  input: (input: { problem: string }) => input,
  config: {
    reason: { effort: 'high' },
  },
  schema: z.object({
    solution: z.string(),
    confidence: z.number(),
  }),
});
```

## Streaming Reasoning

Reasoning traces stream incrementally:

```typescript
for await (const event of solver.run(input)) {
  if (event.type === 'reasonPartial') {
    process.stdout.write(event.reasoning.content ?? '');
  }
  if (event.type === 'reason') {
    console.log('\n--- Reasoning complete ---');
  }
  if (event.type === 'textPartial') {
    process.stdout.write(event.content);
  }
}
```

## Reasoning Structure

```typescript
interface Reasoning {
  content?: string;           // full reasoning text
  details?: ReasoningDetail[]; // structured reasoning blocks
  provider?: string;           // the provider that produced it
}

interface ReasoningDetail {
  id?: string;
  type: string;        // e.g., 'thinking', 'summary'
  format: string;      // e.g., 'openai-responses-v1'
  text?: string;       // reasoning text content
  summary?: string;    // brief summary
  signature?: string;  // model signature
  data?: string;       // encrypted payload
}
```

Keep the assistant message's `reasoning` when you send the conversation back: providers replay it on later turns. Signed and encrypted reasoning only verifies where it was made, so a provider replays only reasoning it produced (or that names no provider); a conversation can move to another provider without a rejected replay.

```typescript
import { replaysTo } from '@aeye/core';

// What a provider checks before it sends an earlier turn's reasoning back
if (replaysTo(message.reasoning, 'openai')) { /* replay it */ }
```

Providers that produce signed or encrypted reasoning set `provider` on it (OpenAI, OpenRouter, and AWS Bedrock as `aws-bedrock`). Reasoning rides on the assistant message it came with, and an assistant turn of only tool calls sends no text content.

## Provider Support

| Provider | Models | Notes |
|----------|--------|-------|
| OpenAI | gpt-5.x, gpt-6, o3 | `effort` goes as `reasoning_effort`. `mode`, `summary`, or `context`, or an effort with tools, route the request to the Responses API, where reasoning comes back encrypted (unless `store` is on) as `openai-responses-v1` details and is replayed on later turns. `maxTokens` and `exclude` are not used. |
| OpenRouter | Any reasoning model | Sent as one `reasoning` object with a token budget (`maxTokens`) or an `effort`, never both (`maxTokens` wins), plus `exclude`, `summary`, `mode`, and `context`. `reasoning` and `reasoning_details` are replayed on the assistant message they came with. |
| AWS Bedrock | Claude models with extended thinking | Reasoning comes back as `bedrock-converse-v1` details marked `provider: 'aws-bedrock'`, so OpenAI and OpenRouter don't replay it; Bedrock replays it as reasoning blocks ahead of the turn's text and tool calls. |

Models with reasoning capability are selected automatically when `reason` is set:

```typescript
const response = await ai.chat.get(
  { messages, reason: { effort: 'high' } },
  { metadata: { required: ['reasoning'] } }
);
```
