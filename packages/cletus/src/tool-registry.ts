import { AnyTool, Message } from '@aeye/core';
import { cosineSimilarity } from './common';
import { ADAPTIVE_TOOLING } from './constants';
import { embed } from './embed';
import { CletusAIContext } from './ai';
import { TypeDefinition } from './schemas';

/**
 * Registered tool with embedded instructions for semantic search
 */
export interface RegisteredTool {
  /** Tool name */
  name: string;
  /** Toolset this tool belongs to */
  toolset: string;
  /** Tool reference */
  tool: AnyTool;
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
  register(toolset: string, tool: AnyTool, instructions: string): void {
    const name = tool.name;
    this.tools.set(name, {
      name,
      toolset,
      tool,
      vector: null,
      instructions,
    });
  }

  /**
   * Register multiple tools from a toolset
   */
  registerToolset(toolset: string, tools: AnyTool[], getInstructions: (tool: AnyTool) => string): void {
    for (const tool of tools) {
      this.register(toolset, tool, getInstructions(tool));
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

  private async _embedAllTools(): Promise<void> {
    const toolsToEmbed = Array.from(this.tools.values()).filter(t => t.vector === null);
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
    topN: number = ADAPTIVE_TOOLING.TOP_TOOLS_TO_SELECT,
    excludeToolsets?: string[]
  ): Promise<RegisteredTool[]> {
    // Ensure all tools are embedded
    await this.embedAllTools();

    // Get query embedding
    const queryVectors = await embed([query]);
    if (!queryVectors || queryVectors.length === 0) {
      // Fallback: return tools from all toolsets if embedding fails
      return this.getAllTools().slice(0, topN);
    }

    const queryVector = queryVectors[0];

    // Calculate similarity for all tools with valid vectors
    const toolsWithVectors = Array.from(this.tools.values())
      .filter((t): t is RegisteredTool & { vector: number[] } => 
        t.vector !== null && (!excludeToolsets || !excludeToolsets.includes(t.toolset))
      );

    const toolsWithSimilarity = toolsWithVectors
      .map(t => ({
        tool: t,
        similarity: cosineSimilarity(queryVector, t.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topN);

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
 * Static toolset names (non-DBA toolsets)
 */
export const STATIC_TOOLSETS = ['planner', 'librarian', 'clerk', 'secretary', 'architect', 'artist', 'internet'] as const;

/**
 * Available static toolset names (DBA toolsets are dynamic based on type names)
 */
export type StaticToolsetName = typeof STATIC_TOOLSETS[number] | 'utility';

/**
 * Get DBA toolset name for a type
 */
export function getDBAToolsetName(typeName: string): string {
  return `dba:${typeName}`;
}

/**
 * Extract instructions from a tool (uses instructions first, falls back to description)
 */
export function getToolInstructions(tool: AnyTool): string {
  const input = tool.input;
  // Use instructions first if available, then fall back to description
  if (input.instructions) {
    return `${input.description}\n\n${input.instructions}`;
  }
  return input.description;
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
