import { a, type SchemaOf } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { formatName, pluralize } from '../common';
import { AgentMode, ChatMode } from '../schemas';
import { buildToolSelectionQuery, STATIC_TOOLSETS, toolRegistry } from '../tool-registry';
import ABOUT_CONTENT from './ABOUT.md';
import { ToolInterrupt } from '@aeye/core';

const RetoolArgs = a.object({
  toolset: a.enum(STATIC_TOOLSETS).nullable().describe('The toolset to switch to, or null to enable adaptive tool selection'),
  ...globalToolProperties,
});

/** Chat modes, least to most permissive. */
const CHAT_MODES: ChatMode[] = ['none', 'read', 'create', 'update', 'delete'];

/**
 * What the hypothetical tool can switch to from the chat's modes: every chat
 * mode more restrictive than the current one, and plan mode from 'default'.
 */
function hypotheticalOptions(chat?: { mode?: ChatMode; agentMode?: AgentMode }): { modes: ChatMode[]; plan: boolean } {
  const currentMode = chat?.mode || 'none';
  return {
    modes: CHAT_MODES.slice(0, CHAT_MODES.indexOf(currentMode)),
    plan: (chat?.agentMode || 'default') === 'default',
  };
}

type HypotheticalInput = { mode?: ChatMode; agentMode?: 'plan' };

/**
 * The hypothetical tool's arguments: only the switches available from the
 * chat's current modes (bound per call; the tool isn't applicable when there
 * are none).
 */
const HypotheticalArgs = a
  .declare<{ Args: HypotheticalInput }>()
  .dynamic((ctx: { chat?: { mode?: ChatMode; agentMode?: AgentMode } }) => {
    const { modes, plan } = hypotheticalOptions(ctx.chat);
    const mode = a.enum(modes as [ChatMode, ...ChatMode[]]).optional()
      .describe('Switch to a more restrictive operation mode');
    const agentMode = a.literal('plan').optional()
      .describe('Switch to plan mode to see what would be done without executing');
    const Args = (modes.length && plan ? a.object({ mode, agentMode, ...globalToolProperties })
      : modes.length ? a.object({ mode, ...globalToolProperties })
      : a.object({ agentMode, ...globalToolProperties })) as SchemaOf<HypotheticalInput>;
    return { Args };
  }, { key: (ctx) => `${ctx.chat?.mode || 'none'}|${ctx.chat?.agentMode || 'default'}` })
  .result('Args');

/**
 * Create utility tools for Cletus operations
 */
export function createUtilityTools(ai: CletusAI) {
  
  const getOperationOutput = ai.tool({
    name: 'getOperationOutput',
    description: 'Retrieves the full output of a truncated operation message',
    instructions: `Use this when you see a message indicating that operation output was truncated.`,
    schema: a.object({
      id: a.number().describe('The message ID provided in the truncation notice'),
      operation: a.number().describe('The operation index within the message provided in the truncation notice'),
      ...globalToolProperties,
    }),
    metadata: { alwaysVisible: true },
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
    schema: a.object({
      ...globalToolProperties,
    }),
    metadata: { alwaysVisible: true },
    call: async (_, __, { chatStatus }) => {
      chatStatus('Retrieving about information...');
      return ABOUT_CONTENT;
    },
  });

  const retool = ai.tool({
    name: 'retool',
    description: 'Switch between toolsets or enable adaptive tool selection',
    metadata: { alwaysVisible: true },
    instructionsFn: () => {
      const allToolsets = [...STATIC_TOOLSETS];

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

Example 3: Focus on data operations:
{ "toolset": "dba" }`;
    },
    schema: RetoolArgs,
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

  const hypothetical = ai.tool({
    name: 'hypothetical',
    description: 'Switch to a more restrictive mode to explore what would happen hypothetically without actually performing operations',
    metadata: { alwaysVisible: true },
    instructions: `Use this tool ONLY when the user explicitly wants to understand what WOULD happen for a request without actually doing it.

This tool allows switching to more restrictive modes temporarily to see what operations would be proposed:
- From 'default' (run) mode → 'plan' mode (only plans, doesn't execute)
- From 'delete' mode → 'update', 'create', 'read', or 'none' mode
- From 'update' mode → 'create', 'read', or 'none' mode
- From 'create' mode → 'read' or 'none' mode
- From 'read' mode → 'none' mode

<critical>
Only use this when it's VERY CLEAR the user wants hypothetical exploration, such as:
- "What would happen if I..."
- "Can you show me what you would do..."
- "I want to see what operations would be needed..."
- "Don't actually do it, just tell me what would happen..."

Do NOT use this for normal requests where the user wants actual operations performed.
</critical>

After using this tool, inform the user they will need to manually change back to the previous mode using the /mode command when they're ready to actually perform operations.`,
    schema: HypotheticalArgs,
    applicable: (ctx) => {
      const { modes, plan } = hypotheticalOptions(ctx.chat);
      return modes.length > 0 || plan;
    },
    call: async ({ mode, agentMode }, _, ctx) => {
      const previousMode = ctx.chat?.mode || 'none';
      const previousAgentMode = ctx.chat?.agentMode || 'default';

      let changed = false;
      let message = 'Switched to hypothetical exploration mode:\n';

      // Update chat mode if specified
      if (mode && mode !== previousMode) {
        if (ctx.chatData && ctx.chat) {
          ctx.chat.mode = mode;
          await ctx.config.save((cfg) => {
            const chatMeta = cfg.chats.find(c => c.id === ctx.chat!.id);
            if (chatMeta) {
              chatMeta.mode = mode;
            }
          });
          changed = true;
          message += `- Operation mode: ${previousMode} → ${mode}\n`;
        }
      }

      // Update agent mode if specified
      if (agentMode && agentMode !== previousAgentMode) {
        if (ctx.chatData && ctx.chat) {
          ctx.chat.agentMode = agentMode;
          await ctx.config.save((cfg) => {
            const chatMeta = cfg.chats.find(c => c.id === ctx.chat!.id);
            if (chatMeta) {
              chatMeta.agentMode = agentMode;
            }
          });
          changed = true;
          message += `- Agent mode: ${previousAgentMode} → ${agentMode}\n`;
        }
      }

      if (!changed) {
        return 'Already at the most restrictive mode. No changes made.';
      }

      // Build the restoration instructions
      const restoreInstructions: string[] = [];
      if (mode && mode !== previousMode) {
        restoreInstructions.push(`/mode ${previousMode}`);
      }
      if (agentMode && agentMode !== previousAgentMode) {
        // For agent mode, there's no direct command shown in the codebase, so we'll note it differently
        restoreInstructions.push(`manually switch back to ${previousAgentMode} mode`);
      }

      message += `\n⚠️ You are now in a more restrictive mode for hypothetical exploration.\n`;
      message += `When ready to perform actual operations, you will need to run: ${restoreInstructions.join(' and ')}`;

      ctx.chatStatus('Switched to hypothetical mode');

      return message;
    },
  });

  const ask = ai.tool({
    name: 'ask',
    description: 'Ask the user multiple questions with a special UI interface. DO NOT use any other tools after this one until the user responds.',
    metadata: { alwaysVisible: true },
    instructions: `Use this tool when you need to gather multiple pieces of information from the user in a structured way.
    
<critical>
When you use this tool, DO NOT use any other tools after it in the same response. The user needs to answer the questions before the conversation can continue. This tool will pause the conversation until the user provides their answers.
</critical>

This tool creates a special UI that:
- Displays questions as tabs that the user can navigate through
- Allows single selection (radio buttons) when min=1 and max=1
- Allows multiple selection (checkboxes) when min and max differ
- Can optionally allow custom answers if custom=true

Each question must have:
- name: A short name for the question - 2 to 4 words
- min: Minimum number of selections required
- max: Maximum number of selections allowed
- custom: Whether custom answers are allowed
- customLabel: (optional) Label for the custom answer option (defaults to "Custom")
- options: Array of {label, description} objects for the available choices

Example usage for gathering project preferences:
{
  "questions": [
    {
      "name": "Framework",
      "min": 1,
      "max": 1,
      "custom": false,
      "options": [
        {"label": "React", "description": "Component-based UI library"},
        {"label": "Vue", "description": "Progressive framework"},
        {"label": "Angular", "description": "Full-featured framework"}
      ]
    },
    {
      "name": "Features",
      "min": 1,
      "max": 3,
      "custom": true,
      "customLabel": "Other feature",
      "options": [
        {"label": "Authentication", "description": "User login system"},
        {"label": "Database", "description": "Data persistence"},
        {"label": "API", "description": "REST API endpoints"}
      ]
    }
  ]
}

The user's answers will be formatted and submitted as a message, triggering the chat orchestrator to continue.

DO NOT use this tool for single, simple questions - only use it when you need to gather multiple pieces of information at once.
DO NOT use this tool to ask for approval of operations - there is a separate mechanism for that.`,
    schema: a.object({
      questions: a.array(a.object({
        name: a.string().describe('Short name for the question'),
        min: a.number().describe('Minimum number of selections required'),
        max: a.number().describe('Maximum number of selections allowed'),
        custom: a.boolean().describe('Whether custom answers are allowed'),
        customLabel: a.string().optional().describe('Label for custom answer option (defaults to "Custom")'),
        options: a.array(a.object({
          label: a.string().describe('Option label'),
          description: a.string().describe('Option description'),
        })).describe('Available options for this question'),
      })).min(1).describe('Array of questions to ask the user'),
      ...globalToolProperties,
    }),
    call: async ({ questions }, _, ctx) => {
      // Directly update the chat meta with questions
      if (!ctx.chat) {
        throw new Error('No active chat context available');
      }

      // Update the chat meta with the questions
      await ctx.config.save((cfg) => {
        const chatMeta = cfg.chats.find(c => c.id === ctx.chat!.id);
        if (chatMeta) {
          chatMeta.questions = questions;
        }
      });

      // Notify status
      ctx.chatStatus(`Asking ${questions.length} question${questions.length !== 1 ? 's' : ''}...`);

      // Notify chat-ui to refresh and show the questions
      ctx.events?.onRefreshChat?.();

      // Set interrupt flag to pause further tool usage until user responds
      ctx.chatInterrupt?.();

      // Throw ToolInterrupt to halt further tool execution
      throw new ToolInterrupt();
    },
  });

  return [
    getOperationOutput,
    about,
    retool,
    hypothetical,
    ask,
  ] as [
    typeof getOperationOutput,
    typeof about,
    typeof retool,
    typeof hypothetical,
    typeof ask,
  ];
}
