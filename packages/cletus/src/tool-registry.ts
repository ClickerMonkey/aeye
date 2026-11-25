import { Message, resolveFn } from '@aeye/core';
import { CletusAIContext, CletusTool } from './ai';
import { cosineSimilarity, pluralize } from './common';
import { ADAPTIVE_TOOLING } from './constants';
import { embed } from './embed';
import { getCachedVector, setCachedVector } from './embedding-cache';


/**
 * Registered tool with embedded instructions for semantic search
 */
export interface RegisteredTool {
  /** Tool name */
  name: string;
  /** Toolset this tool belongs to */
  toolset: string;
  /** Tool reference */
  tool: CletusTool;
  /** Embedded instruction vector (null if not yet embedded) */
  vector: number[] | null;
  /** Instructions text used for embedding */
  instructions: string;
}

/**
 * Tool registry that manages all tools and their embeddings for adaptive tool selection
 */
export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private embeddingInProgress: Promise<void> | null = null;

  /**
   * Register a tool with its toolset
   */
  async register(toolset: string, tool: CletusTool, instructions: string): Promise<void> {
    const name = tool.name;

    const existing = this.tools.get(name);
    if (existing && existing.instructions === instructions) {
      // Tool already registered with same instructions, skip
      return;
    }

    // Try to load from cache using instructions as key
    const cachedVector = await getCachedVector(instructions);

    this.tools.set(name, {
      name,
      toolset,
      tool,
      vector: cachedVector,
      instructions,
    });
  }

  /**
   * Register multiple tools from a toolset
   */
  async registerToolset(toolset: string, tools: CletusTool[], getInstructions: (tool: CletusTool) => Promise<string>): Promise<void> {
    for (const tool of tools) {
      await this.register(toolset, tool, await getInstructions(tool));
    }
  }

  /**
   * Unregister all tools from a specific toolset
   */
  unregisterToolset(toolset: string): void {
    for (const [name, registered] of this.tools) {
      if (registered.toolset === toolset) {
        this.tools.delete(name);
      }
    }
  }

  /**
   * Get all tools for a specific toolset
   */
  getToolset(toolset: string): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(t => t.toolset === toolset);
  }

  /**
   * Get all registered toolsets
   */
  getToolsets(): string[] {
    const toolsets = new Set<string>();
    for (const tool of this.tools.values()) {
      toolsets.add(tool.toolset);
    }
    return Array.from(toolsets);
  }

  /**
   * Get all registered tools
   */
  getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool by name
   */
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Embed all tool instructions that haven't been embedded yet
   */
  async embedAllTools(): Promise<void> {
    // Avoid concurrent embedding operations
    if (this.embeddingInProgress) {
      await this.embeddingInProgress;
      return;
    }

    this.embeddingInProgress = this._embedAllTools();
    try {
      await this.embeddingInProgress;
    } finally {
      this.embeddingInProgress = null;
    }
  }

  private getToolsToEmbed(): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(t => t.vector === null);
  }

  private async _embedAllTools(): Promise<void> {
    const toolsToEmbed = this.getToolsToEmbed();
    if (toolsToEmbed.length === 0) {
      return;
    }

    const instructions = toolsToEmbed.map(t => t.instructions);
    const vectors = await embed(instructions);

    if (!vectors) {
      return;
    }

    for (let i = 0; i < toolsToEmbed.length; i++) {
      toolsToEmbed[i].vector = vectors[i];
      // Save to cache for next time using instructions as key
      await setCachedVector(toolsToEmbed[i].instructions, vectors[i]);
    }
  }

  /**
   * Re-embed a specific toolset (used when types change)
   */
  async reembedToolset(toolset: string): Promise<void> {
    const tools = this.getToolset(toolset);
    for (const tool of tools) {
      tool.vector = null;
    }
    await this.embedAllTools();
  }

  /**
   * Select top N tools based on semantic similarity to the query
   */
  async selectTools(
    query: string,
    topN?: number,
    excludeToolNames?: string[],
    ctx?: CletusAIContext,
    additionalToolFilter?: (tool: RegisteredTool) => boolean
  ): Promise<RegisteredTool[]> {
    // Use config value if available, otherwise fall back to constant
    const effectiveTopN = topN ?? ctx?.config?.getData().user.adaptiveTools ?? ADAPTIVE_TOOLING.TOP_TOOLS_TO_SELECT;

    if (ctx?.chatStatus) {
      const embedTools = this.getToolsToEmbed();
      const allTools = this.tools.size;
      if (embedTools.length === allTools && allTools > 0) {
        ctx.chatStatus(`Initializing adaptive tools (${allTools} tools)...`);
      } else if (embedTools.length > 0) {
        ctx.chatStatus(`Updating adaptive tools (${pluralize(embedTools.length, 'tool')})...`);
      }
    }

    // Ensure all tools are embedded
    await this.embedAllTools();

    // Get query embedding
    const queryVectors = await embed([query]);
    if (!queryVectors || queryVectors.length === 0) {
      // Fallback: return tools from all toolsets if embedding fails
      return this.getAllTools().slice(0, effectiveTopN);
    }

    const queryVector = queryVectors[0];

    // Calculate similarity for all tools with valid vectors
    const toolsWithVectors = Array.from(this.tools.values())
      .filter((t): t is RegisteredTool & { vector: number[] } => 
        t.vector !== null && (!excludeToolNames || !excludeToolNames.includes(t.name))
      );

    // Apply additional tool filter if provided
    const filteredTools = additionalToolFilter
      ? toolsWithVectors.filter(additionalToolFilter)
      : toolsWithVectors;

    const toolsWithSimilarity = filteredTools
      .map(t => ({
        tool: t,
        similarity: cosineSimilarity(queryVector, t.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, effectiveTopN);

    return toolsWithSimilarity.map(t => t.tool);
  }

  /**
   * Clear all tools from the registry
   */
  clear(): void {
    this.tools.clear();
  }
}

/**
 * Global tool registry instance
 */
export const toolRegistry = new ToolRegistry();

/**
 * Static toolset names
 */
export const STATIC_TOOLSETS = ['planner', 'librarian', 'clerk', 'secretary', 'architect', 'artist', 'internet', 'dba'] as const;

/**
 * Available static toolset names
 */
export type StaticToolsetName = typeof STATIC_TOOLSETS[number] | 'utility';

/**
 * Extract instructions from a tool (uses instructions first, falls back to description)
 */
export async function getToolInstructions(tool: CletusTool, ctx?: CletusAIContext): Promise<string> {
  const input = tool.input;
  // Use instructions first if available, then fall back to description
  const instructions = input.instructionsFn && ctx
    ? await resolveFn(input.instructionsFn)(ctx, await tool.encoder(ctx))
    : input.instructions;
  
  return instructions || input.description;
}

/**
 * Build query from recent user messages for tool selection
 */
export function buildToolSelectionQuery(
  messages: Message[],
  maxMessages: number = ADAPTIVE_TOOLING.USER_MESSAGES_FOR_EMBEDDING
): string {
  // Get last N user messages
  const userMessages = messages
    .filter(m => m.role === 'user')
    .slice(-maxMessages);

  // Extract text content from messages
  const texts = userMessages.map(m => {
    if (typeof m.content === 'string') {
      return m.content;
    }
    return m.content
      .filter(c => c.type === 'text')
      .map(c => c.content)
      .join(' ');
  });

  return texts.join('\n\n');
}
