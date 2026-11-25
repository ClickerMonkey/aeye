import { a } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { getOperationInput } from '../operations/types';

/**
 * Create planner tools for todo management
 */
export function createPlannerTools(ai: CletusAI) {
  const todosClear = ai.tool({
    name: 'todos_clear',
    description: 'Clears all todos from the current chat',
    instructions: `Use this to clear all todos when starting fresh or when all tasks are complete.

Example: Simply call with no parameters:
{}
 
{{modeInstructions}}`,
    schema: a.object({
      ...globalToolProperties,
    }),
    input: getOperationInput('todos_clear'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'todos_clear', input }, ctx),
  });

  const todosList = ai.tool({
    name: 'todos_list',
    description: 'Lists all current todos',
    instructions: `Use this to see what tasks are pending or completed.

Example: Simply call with no parameters:
{}
 
{{modeInstructions}}`,
    schema: a.object({
      ...globalToolProperties,
    }),
    input: getOperationInput('todos_list'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'todos_list', input }, ctx),
  });

  const todosAdd = ai.tool({
    name: 'todos_add',
    description: 'Adds a new todo to the list',
    instructions: `Use this when breaking down a complex task into smaller steps. Provide a clear, concise name for the todo.

Example: Add a task to implement a feature:
{ "name": "Implement user authentication with OAuth" }
 
{{modeInstructions}}`,
    schema: a.object({
      name: a.string().describe('The todo name/description'),
      ...globalToolProperties,
    }),
    metadata: { defaultVisible: true },
    input: getOperationInput('todos_add'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'todos_add', input }, ctx),
  });

  const todosDone = ai.tool({
    name: 'todos_done',
    description: 'Marks a todo as completed',
    instructions: `Use this when a task has been successfully completed. Provide the todo ID.

Example: Mark a todo as done:
{ "id": "abc-123-def" }
 
{{modeInstructions}}`,
    schema: a.object({
      id: a.string().describe('The todo ID to mark as done'),
      ...globalToolProperties,
    }),
    metadata: { defaultVisible: true },
    input: getOperationInput('todos_done'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'todos_done', input }, ctx),
  });

  const todosGet = ai.tool({
    name: 'todos_get',
    description: 'Gets details for a specific todo',
    instructions: `Use this to check the status and details of a particular todo.

Example: Get details for a specific todo:
{ "id": "abc-123-def" }
 
{{modeInstructions}}`,
    schema: a.object({
      id: a.string().describe('The todo ID'),
      ...globalToolProperties,
    }),
    input: getOperationInput('todos_get'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'todos_get', input }, ctx),
  });

  const todosRemove = ai.tool({
    name: 'todos_remove',
    description: 'Removes a todo from the list',
    instructions: `Use this to delete a todo that is no longer relevant or was added by mistake.

Example: Remove a todo:
{ "id": "abc-123-def" }
 
{{modeInstructions}}`,
    schema: a.object({
      id: a.string().describe('The todo ID to remove'),
      ...globalToolProperties,
    }),
    input: getOperationInput('todos_remove'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'todos_remove', input }, ctx),
  });

  const todosReplace = ai.tool({
    name: 'todos_replace',
    description: 'Replaces all todos with a new set',
    metadata: { defaultVisible: true },
    instructions: `Use this to completely reorganize the todo list with a new plan. All existing todos will be replaced.

Example: Replace with a new project plan:
{ "todos": [{ "name": "Set up project structure", "done": false }, { "name": "Implement core features", "done": false }, { "name": "Write tests", "done": false }] }
 
{{modeInstructions}}`,
    schema: a.object({
      todos: a.array(
        a.object({
          name: a.string(),
          done: a.boolean().optional(),
        })
      ).describe('Array of new todos'),
      ...globalToolProperties,
    }),
    input: getOperationInput('todos_replace'),
    call: async (input, _, ctx) => ctx.ops.handle({
      type: 'todos_replace',
      input: {
        todos: input.todos.map((t) => ({
          id: crypto.randomUUID(),
          name: t.name,
          done: t.done || false,
        }))
      }
    }, ctx),
  });

  return [
    todosClear,
    todosList,
    todosAdd,
    todosDone,
    todosGet,
    todosRemove,
    todosReplace,
  ] as [
    typeof todosClear,
    typeof todosList,
    typeof todosAdd,
    typeof todosDone,
    typeof todosGet,
    typeof todosRemove,
    typeof todosReplace,
  ];
}
