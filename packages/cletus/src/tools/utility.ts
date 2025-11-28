import { z } from 'zod';
import { globalToolProperties, type CletusAI } from '../ai';
import { formatName } from '../common';
import { toolRegistry, buildToolSelectionQuery, getDBAToolsetName, STATIC_TOOLSETS } from '../tool-registry';
import { ADAPTIVE_TOOLING } from '../constants';
import ABOUT_CONTENT from './ABOUT.md';

/**
 * Create utility tools for Cletus operations
 */
export function createUtilityTools(ai: CletusAI) {
  
  const getOperationOutput = ai.tool({
    name: 'getOperationOutput',
    description: 'Retrieves the full output of a truncated operation message',
    instructions: `Use this when you see a message indicating that operation output was truncated.`,
    schema: z.object({
      id: z.number().describe('The message ID provided in the truncation notice'),
      operation: z.number().describe('The operation index within the message provided in the truncation notice'),
      ...globalToolProperties,
    }),
    call: async ({ id: created, operation: operationIndex }, _, { chatData, chatStatus }) => {
      // Verify chat is in context
      if (!chatData) {
        throw new Error('No active chat context available');
      }
      
      // Find the message with matching created timestamp
      const messages = chatData.getMessages();
      const message = messages.find((m) => m.created === created);
      
      if (!message) {
        throw new Error(`No message found with ID: ${created}`);
      }
      
      // Get the operation at the given index
      if (!message.operations || operationIndex >= message.operations.length) {
        throw new Error(`No operation found at index ${operationIndex} for message ${created}`);
      }
      
      const operation = message.operations[operationIndex];
      
      // Return the full operation message
      if (!operation.message) {
        throw new Error(`Operation at index ${operationIndex} has no message`);
      }
      
      // Update status after operation completes
      chatStatus(`Analyzing ${formatName(operation.type)} full results...`);
      
      return operation.message;
    },
  });

  const about = ai.tool({
    name: 'about',
    description: 'Provides information about Cletus, the @aeye library, and the author',
    instructions: `Use this tool when users ask about:
- What Cletus is or can do
- Information about the @aeye library
- Who created Cletus
- Project background and details
- How to get started`,
    schema: z.object({
      ...globalToolProperties,
    }),
    call: async (_, __, { chatStatus }) => {
      chatStatus('Retrieving about information...');
      return ABOUT_CONTENT;
    },
  });

  const retool = ai.tool({
    name: 'retool',
    description: 'Switch between toolsets or enable adaptive tool selection',
    instructionsFn: ({ config }) => {
      const types = config.getData().types;
      const dbaToolsets = types.map(t => getDBAToolsetName(t.name));
      const allToolsets = [...STATIC_TOOLSETS, ...dbaToolsets];
      
      return `Use this to switch between different toolsets or enable adaptive tool selection.

<toolsets>
Available toolsets:
${allToolsets.map(t => `- ${t}`).join('\n')}
</toolsets>

<modes>
- **adaptive**: Clear the toolset to enable embedding-based tool selection. The system will analyze your recent messages and select the most relevant tools automatically.
- **specific**: Set a specific toolset to focus on tools from that category only.
</modes>

<when-to-use>
- Use adaptive mode when the conversation topic changes or you need tools from multiple categories
- Use a specific toolset when you know exactly which category of tools you need
- Switch to adaptive mode if the current toolset doesn't have the tools you need
</when-to-use>

Example 1: Switch to adaptive mode:
{ "toolset": null }

Example 2: Focus on file operations:
{ "toolset": "clerk" }

Example 3: Focus on data operations for a specific type:
{ "toolset": "dba:task" }`;
    },
    schema: ({ config }) => {
      const types = config.getData().types;
      const dbaToolsets = types.map(t => getDBAToolsetName(t.name)) as string[];
      const allToolsets = [...STATIC_TOOLSETS, ...dbaToolsets] as [string, ...string[]];
      
      return z.object({
        toolset: z.enum(allToolsets).nullable().describe('The toolset to switch to, or null to enable adaptive tool selection'),
        ...globalToolProperties,
      });
    },
    call: async ({ toolset }, _, ctx) => {
      const previousToolset = ctx.chat?.toolset;
      
      // Update chat metadata with new toolset
      if (ctx.chatData && ctx.chat) {
        const newToolset = toolset === null ? undefined : toolset;
        ctx.chat.toolset = newToolset;
        await ctx.chatData.save((chat) => {
          // Note: chatData saves to messages file, need to update config for chat meta
        });
        // Update chat meta in config
        await ctx.config.save((cfg) => {
          const chatMeta = cfg.chats.find(c => c.id === ctx.chat!.id);
          if (chatMeta) {
            chatMeta.toolset = newToolset;
          }
        });
      }
      
      if (toolset === null) {
        // Switch to adaptive mode
        ctx.chatStatus('Switched to adaptive tool selection');
        
        // Select tools based on recent messages
        const query = buildToolSelectionQuery(ctx.messages || []);
        if (query) {
          const selectedTools = await toolRegistry.selectTools(query);
          const toolNames = selectedTools.map(t => t.name).join(', ');
          return `Switched from ${previousToolset || 'adaptive'} to adaptive tool selection. Based on recent conversation, selected tools: ${toolNames}`;
        }
        
        return `Switched from ${previousToolset || 'adaptive'} to adaptive tool selection.`;
      } else {
        // Switch to specific toolset
        ctx.chatStatus(`Switched to ${toolset} toolset`);
        
        const toolsetTools = toolRegistry.getToolset(toolset);
        const toolNames = toolsetTools.map(t => t.name).join(', ');
        
        return `Switched from ${previousToolset || 'adaptive'} to ${toolset} toolset. Available tools: ${toolNames}`;
      }
    },
  });

  return [
    getOperationOutput,
    about,
    retool,
  ] as [
    typeof getOperationOutput,
    typeof about,
    typeof retool,
  ];
}
