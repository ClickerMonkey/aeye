import { Request, Tuple } from '@aeye/core';
import type { CletusAI, CletusAIContext, CletusTool } from '../ai';
import { ADAPTIVE_TOOLING } from '../constants';
import { Operations } from '../operations/types';
import {
  buildToolSelectionQuery,
  getToolInstructions,
  RegisteredTool,
  toolRegistry
} from '../tool-registry';
import { createToolsets } from './toolsets';
import { OperationKind } from '../schemas';

/**
 * Initialize the tool registry with all static tools
 */
async function initializeToolRegistry(ai: CletusAI, toolsets: ReturnType<typeof createToolsets>) {
  const {
    plannerTools,
    librarianTools,
    clerkTools,
    secretaryTools,
    architectTools,
    artistTools,
    internetTools,
    dbaTools,
    utilityTools,
  } = toolsets;

  const ctx = await ai.buildContext({});
  const instruct = (tool: CletusTool) => getToolInstructions(tool, ctx);

    // Register toolsets
  await toolRegistry.registerToolset('planner', plannerTools, instruct);
  await toolRegistry.registerToolset('librarian', librarianTools, instruct);
  await toolRegistry.registerToolset('clerk', clerkTools, instruct);
  await toolRegistry.registerToolset('secretary', secretaryTools, instruct);
  await toolRegistry.registerToolset('architect', architectTools, instruct);
  await toolRegistry.registerToolset('artist', artistTools, instruct);
  await toolRegistry.registerToolset('internet', internetTools, instruct);
  await toolRegistry.registerToolset('dba', dbaTools, instruct);
  await toolRegistry.registerToolset('utility', utilityTools, instruct);
}

/**
 * Initialize tool registry
 */
export async function initTools(ai: CletusAI) {
  if (toolRegistry.getAllTools().length > 0) {
    // Already initialized
    return;
  }

  // Create all toolsets
  const toolsets = createToolsets(ai);
  
  // Initialize the tool registry
  initializeToolRegistry(ai, toolsets);
}

/**
 * Get tools based on current toolset or adaptive selection
 */
async function getActiveTools(ctx: CletusAIContext): Promise<RegisteredTool[]> {
  const toolset = ctx.chat?.toolset;

  const matchesPlan = ctx.chat?.agentMode === 'plan'
    ? (tool: CletusTool) => {
      const op = Operations[tool.name as OperationKind];
      if (!op || !op.mode) {
        return true;
      }
      const mode = typeof op.mode === 'function' ? op.mode({}, ctx) : op.mode;
      return mode === 'local' || mode === 'read';
    }
    : () => true;

  const matchesClient = (tool: CletusTool) => {
    return (tool.metadata().onlyClient || ctx.client) === ctx.client; 
  };

  // Get all tools with alwaysVisible metadata
  // OR were marked as persistent in the AI context
  const alwaysVisibleTools = toolRegistry.getAllTools().filter(t => 
    matchesPlan(t.tool) &&
    matchesClient(t.tool) &&
    t.tool.input.metadata?.alwaysVisible === true ||
    ctx.persistentTools?.has(t.name)
  );

  // Create a set to track tool names and prevent duplicates
  const toolNames = new Set<string>(alwaysVisibleTools.map(t => t.name));
  
  let selectedTools: RegisteredTool[];

  if (toolset) {
    // Use specific toolset, but exclude tools already in alwaysVisible
    selectedTools = toolRegistry.getToolset(toolset).filter(t => 
      matchesPlan(t.tool) &&
      matchesClient(t.tool) &&
      !toolNames.has(t.name)
    );
  } else {
    // Adaptive selection: use embeddings of recent user messages
    const query = buildToolSelectionQuery(ctx.messages || []);
    if (query) {
      // Select tools based on semantic similarity, excluding alwaysVisible tools
      const adaptiveToolsCount = ctx.config?.getData().user.adaptiveTools ?? ADAPTIVE_TOOLING.TOP_TOOLS_TO_SELECT;

      selectedTools = await toolRegistry.selectTools(
        query,
        adaptiveToolsCount,
        alwaysVisibleTools.map(t => t.name),
        ctx,
        ({ tool }) => matchesPlan(tool) && matchesClient(tool),
      );
      
      // Trim to ensure we don't exceed the total count
      const maxSelectedTools = adaptiveToolsCount - alwaysVisibleTools.length;
      if (selectedTools.length > maxSelectedTools) {
        selectedTools = selectedTools.slice(0, maxSelectedTools);
      }
    } else {
      // No user messages yet, return default visible tools
      const defaultVisibleTools = toolRegistry.getAllTools().filter(t => 
        matchesPlan(t.tool) &&
        matchesClient(t.tool) &&
        t.tool.input.metadata?.defaultVisible === true && 
        !toolNames.has(t.name)
      );

      selectedTools = defaultVisibleTools;
    } 
  }

  return [...alwaysVisibleTools, ...selectedTools];
}

/**
 * Create the main chat agent with adaptive tooling
 */
export function createChatAgent(ai: CletusAI) {
  // Ensure tools are initialized
  initTools(ai);

  // Build toolset descriptions for the prompt
  const buildToolsetDescriptions = (ctx: CletusAIContext) => {
    const toolsetNames = toolRegistry.getToolsets();
    const descriptions: string[] = [];

    for (const name of toolsetNames) {
      if (name === 'utility') {
        continue; // Skip utility, it's always available
      }
      
      const tools = toolRegistry.getToolset(name);
      const toolSignatures = tools
        .map(t => {
          const opName = t.name as keyof typeof Operations;
          return Operations[opName]?.signature || t.name;
        })
        .join('\n  - ');
      
      const desc = getToolsetDescription(name);
      descriptions.push(`- **${name}**: ${desc}\n  - ${toolSignatures}`);
    }

    return descriptions.join('\n\n');
  };

  // Create the main chat prompt with adaptive tool selection
  const chatPrompt = ai.prompt({
    name: 'cletus_chat',
    description: 'Main Cletus chat interface',
    toolIterations: 20,
    content: `You are Cletus, a powerful CLI assistant that helps users manage tasks, files, data, and knowledge.

<userInformation>
{{userPrompt}}
</userInformation>

You have access to tools organized in toolsets. The system uses adaptive tool selection to provide the most relevant tools based on your conversation context.

<toolsets>
{{toolsetDescriptions}}
</toolsets>

<currentToolset>
{{#if toolset}}
Currently focused on: {{toolset}}
Use the 'retool' utility to switch toolsets or enable adaptive selection.
{{else}}
Using adaptive tool selection. The most relevant tools have been selected based on recent conversation.
{{/if}}
</currentToolset>

<behavior>
The user is going to make requests.
If you think it can be done in a few simple operations then proceed without todos.
If the request is complex and will take multiple steps, you should use the planner tools to create todos for Cletus to complete the request step by step.

The workflow will be:
1. User makes a request
2. Cletus determines whether to use planner first or not, if so generate todos
3. Use the appropriate tools to complete the request
4. The user may have to approve it.
5. A follow up call to Cletus - perhaps without a user message - will be made. If there are active todos should be checked and updated when it makes sense.
6. Mark todos done when completed. If all are done and the user makes another request, clear the todos.
7. If the user switches topics and there are unfinished todos, you can ask if they want to add the new request, clear todos, or rebuild the todos based on the new request.

This will repeat to complete the user's requests efficiently and accurately.

RESPONSE FORMATTING:
- Keep all answers **concise** and to-the-point. Only include essential information.
- You can use **markdown** for formatting (bold, italics, lists, code blocks, etc.) to make responses clearer.
- When operations are in a finished state, provide a brief summary to the user of what was done.
- When actively working on todos and presenting operations to the user to be accepted/rejected, keep the summaries concise with exactly what the user needs to see to make a good decision.

IMPORTANT:
- If the last message is an assistant message and you don't have anything to add, do NOT respond again - wait for the user to make another request. Respond with no content.
- Do not perform the same operations multiple times unless the user explicitly asks you to.
</behavior>

<plan-mode>
When the agent is in 'plan' mode the goal is to have the planner refine the todos until the user is satisfied and switches out of 'plan' mode.
You do NOT mark todos done in this mode unless the user explicitly says to OR the todo represents a read-only operation.
You should first use tools to read/select information to build the plan. Don't assume the plan is correct until you've verified all the details with tools and user input when appropriate.
</plan-mode>

<rules>
Files:
- If you don't know the exact path to a file, use file_search to locate it first. Don't assume paths or necessarily believe the user entered path is correct.
- Reread files if needed rather than making assumptions about their content.
- If a file does not exist because you assumed the user gave a correct path, search for the file.
- Before performing write operations, ensure you have the latest file state by reading it first.
- Do not ask the user to locate a file unless you've already tried searching for it.

Tools:
- If you need tools from a different toolset, use the 'retool' utility to switch or enable adaptive selection.
- The adaptive tool selection uses embedding similarity to find the most relevant tools for your current task.
- Use 'retool' with null to re-enable adaptive selection if you've been focused on a specific toolset.
- Choose the simplest tool that accomplishes the task. Avoid over-engineering solutions. 
- Start with targeted tools before using more general ones if you aren't finding what you need.
- AGGRESSIVELY use retool to switch toolsets as needed to accomplish user requests. If adaptive selection is enabled, the tool you need may not be available.
</rules>

<importantRules>
- Don't ask for permission to perform operations - if you need to do something, just do it. The user will be asked for approval automatically if needed.
- Todos are exclusively for Cletus's internal management of user requests. They are only referred to as todos - anything else should be assumed to be a separate data type.
- If you've executed ANY tools - DO NOT ask a question at the end of your response. You are either going to automatically continue your work OR the user will respond next. NEVER ask a question after executing tools. Only for clarifications.
</importantRules>
`,
    tools: toolRegistry.getAllTools().map(t => t.tool) as Tuple<CletusTool>,
    retool: async (_, ctx) => {
      const activeTools = await getActiveTools(ctx);
      return activeTools.map(t => t.tool);
    },
    toolsMax: 50,
    metadata: {
      weights: {
        speed: 0.7,
        accuracy: 0.3,
      },
    },
    dynamic: true,
    config: (_, ctx) => {
      const request: Partial<Request> = {};
      const reasoning = ctx.chat?.reasoning || ctx.config.getData().user.reasoning || 'none';

      if (reasoning !== 'none') {
        request.reason = { effort: reasoning };
      }

      return request;
    },
    metadataFn: (_, { config, chat }) => ({
      model: chat?.model || config.getData().user.models?.chat,
    }),
    input: (input: {}, ctx) => ({ 
      userPrompt: ctx.userPrompt,
      toolsetDescriptions: buildToolsetDescriptions(ctx),
      toolset: ctx.chat?.toolset,
    }),
  });

  return chatPrompt;
}

export type CletusChatAgent = ReturnType<typeof createChatAgent>;

/**
 * Get a human-readable description for a toolset
 */
function getToolsetDescription(name: string): string {
  const descriptions: Record<string, string> = {
    planner: 'Task planning and todo management for multi-step operations',
    librarian: 'Knowledge search and management using semantic search',
    clerk: 'File operations (search, read, create, edit, delete, move, copy, summarize, index)',
    secretary: 'User memory and assistant persona management',
    architect: 'Type definitions and data schema management',
    artist: 'Image generation, editing, analysis, and search',
    internet: 'Web searches, page fetching, and REST API calls',
    dba: 'Data operations for records (import, index, query, search)',
    utility: 'Core utilities like retool for switching toolsets',
  };

  return descriptions[name] || `Tools for ${name}`;
}
