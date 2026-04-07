# Composition Patterns

@aeye components compose naturally. This page covers common patterns for building sophisticated AI workflows.

## Component Hierarchy

```
Agent (orchestration layer)
├── Prompt (AI interaction layer)
│   └── Tool (function calling layer)
└── Tool (direct usage)
```

- **Tools** are the building blocks — they define what the AI can do
- **Prompts** use tools to have AI-driven conversations with structured output
- **Agents** orchestrate tools and prompts with developer-defined logic

## Pattern: Tool → Prompt

The most common pattern. Give tools to a prompt and let the AI decide when to call them:

```typescript
const search = ai.tool({ /* ... */ });
const read = ai.tool({ /* ... */ });

const assistant = ai.prompt({
  name: 'assistant',
  content: 'Help the user with their files.',
  tools: [search, read],
});
```

## Pattern: Prompt → Agent

Use prompts as building blocks in an agent for multi-step workflows:

```typescript
const classify = ai.prompt({
  name: 'classify',
  content: 'Classify this text: {{text}}',
  input: (input: { text: string }) => input,
  schema: z.object({ category: z.string(), confidence: z.number() }),
});

const respond = ai.prompt({
  name: 'respond',
  content: 'Write a {{category}} response to: {{text}}',
  input: (input: { text: string; category: string }) => input,
});

const pipeline = ai.agent({
  name: 'pipeline',
  refs: [classify, respond] as const,
  call: async ({ text }: { text: string }, [classify, respond], ctx) => {
    const classification = await classify.get('result', { text }, ctx);
    const response = await respond.get('result', {
      text,
      category: classification?.category ?? 'general',
    }, ctx);
    return response;
  },
});
```

## Pattern: Conditional Tool Availability

Use `applicable` to show different tools based on context:

```typescript
const adminDelete = ai.tool({
  name: 'deleteRecord',
  description: 'Delete a database record',
  schema: z.object({ id: z.string() }),
  applicable: (ctx) => ctx.user.role === 'admin',
  call: async ({ id }, _refs, ctx) => { /* ... */ },
});

const readRecord = ai.tool({
  name: 'readRecord',
  description: 'Read a database record',
  schema: z.object({ id: z.string() }),
  call: async ({ id }) => { /* ... */ },
});

// adminDelete only appears when user is admin
const assistant = ai.prompt({
  name: 'dbAssistant',
  content: 'Help manage database records.',
  tools: [readRecord, adminDelete],
});
```

## Pattern: Dynamic Tool Selection

Use `retool` to change available tools mid-conversation:

```typescript
const prompt = ai.prompt({
  name: 'adaptive',
  content: 'Help the user complete their task.',
  tools: [planTool, executeTool, reviewTool, finalizeTool],
  retool: (ctx) => {
    const phase = detectPhase(ctx.messages);
    switch (phase) {
      case 'planning': return [planTool];
      case 'executing': return [executeTool, reviewTool];
      case 'finalizing': return [finalizeTool];
      default: return false; // keep all
    }
  },
});
```

## Pattern: Tool References

Tools can reference other components:

```typescript
const fetchData = ai.tool({
  name: 'fetchData',
  schema: z.object({ query: z.string() }),
  call: async ({ query }) => { /* ... */ },
});

const analyzeData = ai.tool({
  name: 'analyzeData',
  description: 'Fetch and analyze data',
  schema: z.object({ query: z.string(), depth: z.number() }),
  refs: [fetchData] as const,
  call: async ({ query, depth }, [fetch], ctx) => {
    const data = await fetch.run({ query }, ctx);
    // ... analyze data
    return { analysis: '...' };
  },
});
```

## Pattern: Conversation History

Use context messages for multi-turn conversations:

```typescript
const chatbot = ai.prompt({
  name: 'chatbot',
  content: 'You are a helpful assistant.',
  tools: [search, calculate],
});

// First turn
const messages = [];
messages.push({ role: 'user', content: 'What is 2+2?' });

for await (const event of chatbot.run({}, { messages })) {
  if (event.type === 'message') {
    messages.push(event.value); // accumulate assistant messages
  }
}

// Second turn — conversation history is included
messages.push({ role: 'user', content: 'Now multiply that by 10' });

for await (const event of chatbot.run({}, { messages })) {
  // continues the conversation
}
```

## Pattern: Budget-Aware Agent

An agent that tracks costs and stops when budget is exceeded:

```typescript
const budgetAgent = ai.agent({
  name: 'budgetAgent',
  refs: [expensivePrompt, cheapPrompt] as const,
  call: async (input, [expensive, cheap], ctx) => {
    const budget = ctx.user.budgetRemaining;

    // Try expensive model first if budget allows
    if (budget > 0.10) {
      return expensive.get('result', input, ctx);
    }

    // Fall back to cheap model
    return cheap.get('result', input, ctx);
  },
});
```

## Pattern: Parallel Execution

Run multiple prompts concurrently in an agent:

```typescript
const parallelAnalyzer = ai.agent({
  name: 'parallelAnalyzer',
  refs: [sentimentPrompt, topicPrompt, summaryPrompt] as const,
  call: async ({ text }, [sentiment, topics, summary], ctx) => {
    const [s, t, sum] = await Promise.all([
      sentiment.get('result', { text }, ctx),
      topics.get('result', { text }, ctx),
      summary.get('result', { text }, ctx),
    ]);

    return { sentiment: s, topics: t, summary: sum };
  },
});
```
