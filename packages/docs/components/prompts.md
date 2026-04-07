# Prompts

Prompts are the heart of @aeye's AI interaction. They manage the full lifecycle of an AI call: template rendering, tool execution, output parsing, retries, and context management.

::: tip Two ways to create components
Most examples use `ai.prompt()`, which binds the prompt to an AI instance (auto-injects executor, context types, etc.):

```typescript
const myPrompt = ai.prompt({ /* ... */ });
```

You can also create standalone prompts directly from `@aeye/core`:

```typescript
import { Prompt } from '@aeye/core';
const myPrompt = new Prompt({ /* ... */ });
```

Standalone prompts require you to provide an executor/streamer via context. See [AI Instance](/concepts/ai-instance) for `ai` setup.
:::

## Creating a Prompt

```typescript
import z from 'zod';

const summarizer = ai.prompt({
  name: 'summarizer',
  description: 'Summarizes text',
  content: 'Summarize the following text in {{style}} style:\n\n{{text}}',
  input: (input: { text: string; style: string }) => input,
  schema: z.object({
    summary: z.string(),
    keyPoints: z.array(z.string()),
    wordCount: z.number(),
  }),
});
```

## Prompt Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | required | Unique identifier |
| `description` | `string` | required | What the prompt does |
| `content` | `string` | required | Handlebars template for the system message |
| `input` | `(input) => object` | — | Template variables |
| `schema` | `ZodType` or `(ctx) => ZodType \| false` | — | Output format schema |
| `strict` | `boolean` | `true` | Strict schema enforcement |
| `config` | `Partial<Request>` or `(ctx) => Partial<Request>` | — | Request overrides |
| `tools` | `Tool[]` | — | Available tools |
| `toolIterations` | `number` | `3` | Max rounds of tool calls |
| `toolExecution` | `string` | `'immediate'` | Tool execution mode |
| `toolRetries` | `number` | `2` | Retries for tool errors |
| `toolsOnly` | `boolean` | `false` | Only generate tool calls |
| `toolsMax` | `number` | — | Max successful tool calls |
| `outputRetries` | `number` | `2` | Retries for output parsing |
| `forgetRetries` | `number` | `1` | Retries with context trimming |
| `retool` | `(ctx) => Tool[] \| false` | — | Dynamic tool filtering |
| `reconfig` | `(stats, ctx) => PromptReconfig` | — | Runtime reconfiguration |
| `dynamic` | `boolean` | `false` | Re-resolve prompt each iteration |
| `excludeMessages` | `boolean` | `false` | Exclude context messages |
| `validate` | `(output, ctx) => void` | — | Custom output validation |
| `applicable` | `(ctx) => boolean` | — | Availability check |
| `metadata` / `metadataFn` | — | — | Static/dynamic metadata |

## Configuration In Depth

### `content` — Handlebars Template

The system message sent to the AI model. Uses Handlebars for variable interpolation:

```typescript
const prompt = ai.prompt({
  name: 'translator',
  description: 'Translates text',
  content: `You are a professional translator.
Translate the following text from {{sourceLang}} to {{targetLang}}.
Maintain the original tone and style.

Text: {{text}}`,
  input: (input: { text: string; sourceLang: string; targetLang: string }) => input,
});
```

When tools are attached, a `{{tools}}` section is automatically appended with compiled tool instructions. You can also place `{{tools}}` explicitly in your template to control where it appears.

### `input` — Template Variables

Maps your typed input to the Handlebars template variables:

```typescript
// Simple passthrough
const prompt = ai.prompt({
  content: 'Summarize: {{text}}',
  input: (input: { text: string }) => input,
});

// Transform input before templating
const prompt = ai.prompt({
  content: 'Analyze this {{language}} code:\n```{{language}}\n{{code}}\n```',
  input: (input: { filePath: string; fileContent: string }) => ({
    language: input.filePath.split('.').pop() ?? 'text',
    code: input.fileContent,
  }),
});

// Context-aware input
const prompt = ai.prompt({
  content: 'Hello {{userName}}, help with: {{request}}',
  input: (input: { request: string }, ctx) => ({
    userName: ctx.user?.name ?? 'there',
    request: input.request,
  }),
});
```

### `schema` — Structured Output

Enforces that the AI returns data matching a Zod schema:

```typescript
// Static schema
const prompt = ai.prompt({
  name: 'classifier',
  content: 'Classify this support ticket: {{ticket}}',
  input: (input: { ticket: string }) => input,
  schema: z.object({
    category: z.enum(['billing', 'technical', 'account', 'other']),
    priority: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string(),
    suggestedAction: z.string(),
  }),
});

const result = await prompt.get('result', { ticket: 'I was double charged' });
// result: { category: 'billing', priority: 'high', summary: '...', suggestedAction: '...' }
```

```typescript
// Dynamic schema based on context
const prompt = ai.prompt({
  name: 'extractor',
  content: 'Extract data from: {{text}}',
  input: (input: { text: string }) => input,
  schema: (ctx) => {
    if (ctx.mode === 'simple') {
      return z.object({ summary: z.string() });
    }
    if (ctx.mode === 'detailed') {
      return z.object({
        summary: z.string(),
        entities: z.array(z.object({ name: z.string(), type: z.string() })),
        sentiment: z.enum(['positive', 'negative', 'neutral']),
      });
    }
    return false; // no structured output — free-form text
  },
});
```

### `strict` — Schema Strictness

Controls whether the JSON schema sent to the AI model uses strict mode (all properties required, no additionalProperties):

```typescript
// Strict mode (default) — best for OpenAI structured outputs
const prompt = ai.prompt({
  schema: z.object({ name: z.string(), age: z.number() }),
  strict: true, // default
});

// Non-strict — allows optional fields, more lenient parsing
const prompt = ai.prompt({
  schema: z.object({
    name: z.string(),
    nickname: z.string().optional(),
  }),
  strict: false,
});
```

### `config` — Request Overrides

Override AI request parameters:

```typescript
// Static config
const prompt = ai.prompt({
  name: 'creative',
  content: 'Write a creative story about {{topic}}',
  input: (input: { topic: string }) => input,
  config: {
    temperature: 0.9,
    maxTokens: 2000,
    topP: 0.95,
  },
});

// Dynamic config based on context or input
const prompt = ai.prompt({
  name: 'adaptive',
  content: 'Answer: {{question}}',
  input: (input: { question: string }) => input,
  config: (ctx) => ({
    temperature: ctx.creative ? 0.8 : 0.2,
    maxTokens: ctx.verbose ? 4000 : 500,
  }),
});
```

### `tools` — Available Tools

Attach tools the AI can call during this prompt:

```typescript
const search = ai.tool({ name: 'search', /* ... */ });
const calculate = ai.tool({ name: 'calculate', /* ... */ });
const writeFile = ai.tool({ name: 'writeFile', /* ... */ });

const assistant = ai.prompt({
  name: 'assistant',
  content: 'Help the user with their request.',
  tools: [search, calculate, writeFile],
  toolIterations: 10, // allow up to 10 rounds of tool calls
});
```

### `toolsOnly` — Tool-Only Mode

When `true`, the prompt only generates tool calls, never text. Useful for extraction pipelines:

```typescript
const entityExtractor = ai.tool({
  name: 'recordEntity',
  description: 'Record an extracted entity',
  schema: z.object({
    name: z.string(),
    type: z.enum(['person', 'place', 'org', 'date']),
  }),
  call: async (entity) => entity,
});

const extractionPrompt = ai.prompt({
  name: 'extract',
  content: 'Extract all entities from this text:\n\n{{text}}',
  input: (input: { text: string }) => input,
  tools: [entityExtractor],
  toolsOnly: true,
});

const entities = await extractionPrompt.get('tools', { text: 'John met Sarah in Paris on Monday.' });
// [{ tool: 'recordEntity', result: { name: 'John', type: 'person' } }, ...]
```

### `toolsMax` — Limit Total Tool Calls

Cap the number of successful tool calls before the prompt wraps up:

```typescript
const prompt = ai.prompt({
  name: 'researcher',
  content: 'Research this topic using the search tool.',
  tools: [searchTool],
  toolsMax: 3, // stop calling tools after 3 successful searches
});
```

### `toolExecution` — Execution Mode

```typescript
// 'immediate' (default): each tool call executes as soon as its arguments are parsed
const prompt = ai.prompt({ tools, toolExecution: 'immediate' });

// 'sequential': tool calls execute one at a time, in order
const prompt = ai.prompt({ tools, toolExecution: 'sequential' });

// 'parallel': all tool calls in a batch are collected, then executed concurrently
const prompt = ai.prompt({ tools, toolExecution: 'parallel' });
```

### `retool` — Dynamic Tool Filtering

Change which tools are available each iteration:

```typescript
const prompt = ai.prompt({
  name: 'phased',
  content: 'Complete the user task step by step.',
  tools: [planTool, searchTool, writeTool, reviewTool, submitTool],
  retool: (ctx) => {
    const messageCount = ctx.messages?.length ?? 0;
    if (messageCount < 3) return [planTool, searchTool]; // planning phase
    if (messageCount < 8) return [searchTool, writeTool, reviewTool]; // execution
    return [reviewTool, submitTool]; // wrap up
  },
});
```

### `reconfig` — Runtime Reconfiguration

Adjust iteration limits and retry counts mid-execution based on stats:

```typescript
const prompt = ai.prompt({
  name: 'resilient',
  content: 'Process the data.',
  tools: [processTool],
  reconfig: (stats, ctx) => {
    // Too many tool errors — stop trying
    if (stats.toolCallErrors > 3) {
      return { maxIterations: 0 };
    }
    // Work is going well — give more room
    if (stats.toolSuccesses > 0 && stats.toolCallErrors === 0) {
      return { maxIterations: 10 };
    }
    // Switch to a simpler model config on retry
    if (stats.iteration > 5) {
      return {
        config: { temperature: 0.1 }, // more deterministic
        outputRetries: 1,
      };
    }
    return {};
  },
});
```

### `dynamic` — Re-resolve Each Iteration

When `true`, the prompt's content, schema, config, and tools are re-resolved on every iteration. Useful when these depend on state that changes during execution:

```typescript
const prompt = ai.prompt({
  name: 'live',
  content: 'Current items: {{items}}\n\nHelp manage the list.',
  input: (input, ctx) => ({
    items: ctx.db.getItems().join(', '), // re-read from DB each iteration
  }),
  tools: [addItem, removeItem],
  dynamic: true, // re-resolve content each iteration
});
```

### `excludeMessages` — Standalone Prompts

When `true`, context messages (conversation history) are not included. Useful for standalone operations like translation or summarization:

```typescript
const translator = ai.prompt({
  name: 'translate',
  content: 'Translate to {{lang}}:\n\n{{text}}',
  input: (input: { text: string; lang: string }) => input,
  schema: z.object({ translation: z.string() }),
  excludeMessages: true, // ignore conversation history
});
```

### `validate` — Custom Output Validation

Run additional validation after schema parsing succeeds:

```typescript
const prompt = ai.prompt({
  name: 'quiz',
  content: 'Generate a quiz with exactly {{count}} questions about {{topic}}.',
  input: (input: { topic: string; count: number }) => input,
  schema: z.object({
    questions: z.array(z.object({
      question: z.string(),
      answer: z.string(),
    })),
  }),
  validate: (output, ctx) => {
    if (output.questions.length !== ctx.count) {
      throw new Error(
        `Expected ${ctx.count} questions but got ${output.questions.length}`
      );
    }
  },
});
```

If `validate` throws, the error is sent back to the model and it retries (up to `outputRetries` times).

### `applicable` — Conditional Availability

Control when the prompt can be used:

```typescript
const adminPrompt = ai.prompt({
  name: 'adminDashboard',
  content: 'Generate admin report for {{period}}.',
  input: (input: { period: string }) => input,
  applicable: (ctx) => ctx.user?.role === 'admin',
});

// Returns undefined if not applicable
const available = await adminPrompt.applicable(ctx);
```

### `metadata` / `metadataFn` — Model Selection Hints

Provide metadata that influences model selection:

```typescript
// Static — always use a flagship model
const prompt = ai.prompt({
  name: 'criticalAnalysis',
  content: 'Analyze this contract for legal risks: {{text}}',
  input: (input: { text: string }) => input,
  metadata: {
    required: ['chat'],
    tier: 'flagship',
    weights: { accuracy: 0.9, cost: 0.1 },
  },
});

// Dynamic — adjust based on input
const prompt = ai.prompt({
  name: 'flexiblePrompt',
  content: '{{task}}',
  input: (input: { task: string; urgent: boolean }) => input,
  metadataFn: (input, ctx) => ({
    weights: input.urgent
      ? { speed: 0.8, accuracy: 0.2 }
      : { cost: 0.6, accuracy: 0.4 },
  }),
});
```

### `outputRetries` / `toolRetries` / `forgetRetries`

Fine-tune retry behavior:

```typescript
const prompt = ai.prompt({
  name: 'reliable',
  content: 'Parse this data: {{data}}',
  input: (input: { data: string }) => input,
  schema: z.object({ /* ... */ }),

  outputRetries: 3,  // retry up to 3 times if output doesn't match schema
  toolRetries: 2,    // retry up to 2 times if a tool call fails to parse
  forgetRetries: 1,  // trim context and retry once if context window exceeded
});

// Total iteration budget: 3 + 1 + toolIterations(3) + 2 + 1 = 10
```

## Running Prompts

### `get()` — Convenient Output Modes

```typescript
// Get parsed structured output
const result = await summarizer.get('result', { text, style: 'brief' });

// Get tool outputs
const tools = await prompt.get('tools', input);

// Stream all events
const stream = await prompt.get('stream', input);
for await (const event of stream) { /* ... */ }

// Stream only tool events
const toolStream = await prompt.get('streamTools', input);

// Stream only text content
const textStream = await prompt.get('streamContent', input);
for await (const text of textStream) {
  process.stdout.write(text);
}
```

### `run()` — Full Event Stream

```typescript
for await (const event of summarizer.run(input, ctx)) {
  switch (event.type) {
    case 'textPartial':
      process.stdout.write(event.value);
      break;
    case 'toolStart':
      console.log(`Calling tool: ${event.value.name}`);
      break;
    case 'toolOutput':
      console.log(`Tool result:`, event.value.result);
      break;
    case 'complete':
      console.log('Final output:', event.value);
      break;
  }
}
```

## Prompt Events

| Event | Description |
|-------|-------------|
| `request` | AI request about to be made |
| `textPartial` | Partial text chunk received |
| `text` | Complete text for this iteration |
| `textComplete` | All accumulated text content |
| `textReset` | Text reset due to error/retry |
| `refusal` | Model refused to respond |
| `reason` | Reasoning trace (for reasoning models) |
| `reasonPartial` | Partial reasoning chunk |
| `toolParseName` | Tool name parsed from response |
| `toolParseArguments` | Tool arguments being parsed |
| `toolStart` | Tool execution starting |
| `toolOutput` | Tool completed successfully |
| `toolInterrupt` | Tool was interrupted |
| `toolSuspend` | Tool suspended the prompt |
| `toolError` | Tool execution failed |
| `message` | Message added to conversation |
| `complete` | Final parsed output |
| `suspend` | Prompt suspended |
| `requestUsage` | Token usage for this request |
| `responseTokens` | Output token count |
| `usage` | Final accumulated usage |

## Tool Execution Modes

Control how multiple tool calls are executed:

```typescript
const prompt = ai.prompt({
  tools: [tool1, tool2, tool3],
  toolExecution: 'immediate', // default: execute as soon as parsed
  // 'sequential' — execute one at a time in order
  // 'parallel' — wait for all to parse, then execute concurrently
  // 'immediate' — execute each as soon as it's parsed
});
```

## Iteration Limits

The prompt's main loop has a budget computed from:

```
maxIterations = outputRetries + forgetRetries + toolIterations + toolRetries + 1
```

With defaults: `2 + 1 + 3 + 2 + 1 = 9`

If the model needs more tool call rounds, increase `toolIterations`:

```typescript
const prompt = ai.prompt({
  toolIterations: 20, // allow up to 20 rounds of tool calls
});
```

## Dynamic Reconfiguration

Adjust the prompt's behavior based on execution stats:

```typescript
const prompt = ai.prompt({
  name: 'adaptive',
  content: '...',
  tools: [myTool],
  reconfig: (stats, ctx) => {
    // stats: { iteration, maxIterations, toolParseErrors, toolCallErrors, toolSuccesses, ... }

    if (stats.toolCallErrors > 2) {
      return { maxIterations: 0 }; // stop immediately
    }

    if (stats.toolSuccesses > 5) {
      return { maxIterations: 2 }; // wrap up soon
    }

    return {}; // continue as normal
  },
});
```

## Dynamic Tool Selection (Retool)

Filter or replace available tools each iteration:

```typescript
const prompt = ai.prompt({
  tools: [tool1, tool2, tool3, tool4, tool5],
  retool: (ctx) => {
    // Return a subset, or false to keep current tools
    if (ctx.messages?.length > 10) {
      return [tool1, tool2]; // simplify for long conversations
    }
    return false; // keep all tools
  },
});
```

## Context Message Trimming

When a request exceeds the model's context window, @aeye automatically trims older messages:

- Messages are removed from the beginning (oldest first)
- System messages are preserved
- The `forgetRetries` setting controls how many times trimming is attempted

Configure context window info via metadata:

```typescript
const prompt = ai.prompt({
  config: {
    maxTokens: 4000, // max output tokens
  },
  forgetRetries: 2, // try trimming twice before giving up
});
```
