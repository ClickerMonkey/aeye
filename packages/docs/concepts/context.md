# Context & Metadata

@aeye provides a type-safe system for threading application data through every AI operation and controlling model selection via metadata.

## Context

Context carries your application's state through all AI operations — tools, prompts, agents, and hooks.

### Defining Context

```typescript
interface AppContext {
  userId: string;
  db: Database;
  logger: Logger;
}

const ai = AI.with<AppContext>()
  .providers({ openai })
  .create({
    defaultContext: {
      logger: new Logger(),
    },
    providedContext: async (ctx) => ({
      db: await getDatabase(),
    }),
  });
```

### Context Flow

Context is built in layers:

```
defaultContext → providedContext → runtime context
```

1. **`defaultContext`** — static defaults set at creation
2. **`providedContext`** — async function to enrich context (e.g., fetch from DB)
3. **Runtime context** — passed at call time

```typescript
// Runtime context merges with defaults and provided context
const response = await ai.chat.get(
  { messages },
  { userId: 'user123' }  // merged into final context
);
```

### Context in Components

Tools, prompts, and agents receive the full merged context:

```typescript
const myTool = ai.tool({
  name: 'getUserData',
  description: 'Fetch user data',
  schema: z.object({ field: z.string() }),
  call: async ({ field }, _refs, ctx) => {
    // ctx has full type safety: ctx.userId, ctx.db, ctx.logger
    return ctx.db.users.get(ctx.userId, field);
  },
});
```

### Built-in Context Fields

@aeye adds these fields to every context automatically:

| Field | Type | Description |
|-------|------|-------------|
| `ai` | `AI` | Reference to the AI instance |
| `metadata` | `AIMetadata` | Current operation metadata |
| `signal` | `AbortSignal` | Cancellation signal |
| `messages` | `Message[]` | Conversation history |
| `execute` | `Executor` | Non-streaming execution function |
| `stream` | `Streamer` | Streaming execution function |
| `instance` | `Instance` | Component instance for event tracking |

## Metadata

Metadata controls model selection and request configuration. It's separate from context because it describes _how_ to make the AI call, not _what data_ to use.

Crucially, metadata can be defined at multiple levels and merges together:

1. **AI-level defaults** — `defaultMetadata` and `providedMetadata` in `AI.create()`
2. **Component-level** — `metadata` or `metadataFn` on prompts, tools, and agents
3. **Per-request** — passed at call time via `{ metadata: { ... } }`

This means a prompt can declare that it always needs a `flagship` tier model, while the caller can further constrain to a specific provider. The final merged metadata drives model selection and is available in all hooks.

### Using Metadata

```typescript
const response = await ai.chat.get(
  { messages },
  {
    metadata: {
      model: 'gpt-4o',                    // explicit model
      required: ['chat', 'tools'],         // required capabilities
      optional: ['streaming'],             // nice-to-have capabilities
      weights: { accuracy: 0.8 },          // selection weights
      weightProfile: 'precise',            // named profile
      providers: { allow: ['openai'] },    // provider filter
      contextWindow: { min: 32000 },       // context window constraint
      pricing: { max: { text: { input: 10 } } }, // price ceiling
      tier: 'flagship',                    // model tier
    },
  }
);
```

### Custom Metadata

Define custom metadata types for your application:

```typescript
interface AppMetadata {
  priority: 'low' | 'normal' | 'high';
  department: string;
}

const ai = AI.with<AppContext, AppMetadata>()
  .providers({ openai })
  .create({
    defaultMetadata: {
      priority: 'normal',
    },
    providedMetadata: async (meta) => ({
      department: meta.department ?? 'engineering',
    }),
  });
```

### Metadata in Hooks

Metadata is available in all lifecycle hooks:

```typescript
ai.withHooks({
  beforeRequest: async (ctx, request, selected, usage, cost) => {
    const priority = ctx.metadata?.priority;
    if (priority === 'low' && cost > 0.01) {
      throw new Error('Low priority requests are budget-limited');
    }
  },
});
```

### Metadata in Components

Components can define static or dynamic metadata:

```typescript
const expensivePrompt = ai.prompt({
  name: 'analyzer',
  description: 'Deep analysis',
  content: '...',
  metadata: {
    priority: 'high',
    department: 'research',
  },
  // Or dynamic:
  metadataFn: (input, ctx) => ({
    priority: input.urgent ? 'high' : 'normal',
  }),
});
```
