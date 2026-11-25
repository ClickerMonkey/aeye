import { a } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { getOperationInput } from '../operations/types';

/**
 * Create secretary tools for assistant and memory management
 */
export function createSecretaryTools(ai: CletusAI) {
  const assistantSwitch = ai.tool({
    name: 'assistant_switch',
    description: 'Switch to a different assistant persona',
    instructions: `Use this to change the current chat assistant. The assistant persona affects how the AI responds.

Example: To switch to a coding-focused assistant:
{ "name": "coder" }
 
{{modeInstructions}}`,
    schema: a.object({
      name: a.string().describe('Assistant name'),
      ...globalToolProperties,
    }),
    input: getOperationInput('assistant_switch'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'assistant_switch', input }, ctx),
  });

  const assistantUpdate = ai.tool({
    name: 'assistant_update',
    description: 'Update an assistant persona prompt',
    instructions: `Use this to modify an existing assistant's system prompt.

Example: To make an assistant more concise:
{ "name": "helper", "prompt": "You are a helpful assistant. Always give concise, direct answers without unnecessary explanation." }
 
{{modeInstructions}}`,
    schema: a.object({
      name: a.string().describe('Assistant name'),
      prompt: a.string().describe('New system prompt'),
      ...globalToolProperties,
    }),
    input: getOperationInput('assistant_update'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'assistant_update', input }, ctx),
  });

  const assistantAdd = ai.tool({
    name: 'assistant_add',
    description: 'Create a new assistant persona',
    instructions: `Use this to create a new assistant with a custom system prompt. The assistant will be available for future chats.

Example: Create a specialized writing coach:
{ "name": "writer", "prompt": "You are a creative writing coach who helps users improve their prose, providing constructive feedback on style, structure, and narrative flow." }
 
{{modeInstructions}}`,
    schema: a.object({
      name: a.string().describe('Assistant name'),
      prompt: a.string().describe('System prompt for the assistant'),
      ...globalToolProperties,
    }),
    input: getOperationInput('assistant_add'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'assistant_add', input }, ctx),
  });

  const memoryList = ai.tool({
    name: 'memory_list',
    description: 'List all user memories',
    instructions: `Use this to see what the user has asked to remember.

Example: Simply call with no parameters:
{}
 
{{modeInstructions}}`,
    schema: a.object({
      ...globalToolProperties,
    }),
    input: getOperationInput('memory_list'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'memory_list', input }, ctx),
  });

  const memoryUpdate = ai.tool({
    name: 'memory_update',
    description: 'Add or update user memory',
    instructions: `Use this to store important information about the user. This will integrate with existing memories or add a new one.

Example: Store a user preference:
{ "content": "User prefers TypeScript over JavaScript for all new projects" }
 
{{modeInstructions}}`,
    schema: a.object({
      content: a.string().describe('Memory content to add or update'),
      ...globalToolProperties,
    }),
    input: getOperationInput('memory_update'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'memory_update', input }, ctx),
  });

  return [
    assistantSwitch,
    assistantUpdate,
    assistantAdd,
    memoryList,
    memoryUpdate,
  ] as [
    typeof assistantSwitch,
    typeof assistantUpdate,
    typeof assistantAdd,
    typeof memoryList,
    typeof memoryUpdate,
  ];
}
