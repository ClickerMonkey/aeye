# Todo Manager

A natural-language todo manager using typed context, multiple tools, and a prompt.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import z from 'zod';

interface AppContext {
  userId: string;
  db: { todos: Map<string, { id: string; name: string; done: boolean }> };
}

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
const ai = AI.with<AppContext>().providers({ openai }).create();

const addTodo = ai.tool({
  name: 'addTodo',
  description: 'Add a new to-do item',
  schema: z.object({
    name: z.string().describe('The to-do item description'),
  }),
  call: async ({ name }, _refs, ctx) => {
    const id = crypto.randomUUID();
    ctx.db.todos.set(id, { id, name, done: false });
    return { id, name, done: false };
  },
});

const listTodos = ai.tool({
  name: 'listTodos',
  description: 'List all to-do items',
  schema: z.object({}),
  call: async (_input, _refs, ctx) => {
    return { todos: Array.from(ctx.db.todos.values()) };
  },
});

const markDone = ai.tool({
  name: 'markDone',
  description: 'Mark a to-do item as complete',
  schema: z.object({
    id: z.string().describe('The to-do item ID'),
  }),
  call: async ({ id }, _refs, ctx) => {
    const todo = ctx.db.todos.get(id);
    if (!todo) throw new Error(`Todo ${id} not found`);
    todo.done = true;
    return { success: true, todo };
  },
});

const taskManager = ai.prompt({
  name: 'taskManager',
  description: 'Manages to-do items via natural language',
  content: `You are a helpful task manager.
Help the user manage their to-do list using the available tools.

User request: {{request}}`,
  input: (input: { request: string }) => ({ request: input.request }),
  tools: [addTodo, listTodos, markDone],
});

// Usage
const db = { todos: new Map() };
const ctx = { userId: 'user1', db };

// Add some todos
await taskManager.get('result', { request: 'Add todos: finish the report, buy groceries, call dentist' }, ctx);

// List them
await taskManager.get('result', { request: 'Show me my todos' }, ctx);

// Mark one done
await taskManager.get('result', { request: 'Mark the report one as done' }, ctx);
```
