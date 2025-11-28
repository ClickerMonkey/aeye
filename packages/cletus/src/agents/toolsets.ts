import { AnyTool, Names, Tuple } from '@aeye/core';
import type { CletusAI, CletusAIContext } from '../ai';
import { Operations } from '../operations/types';
import { OperationKind, TypeDefinition } from '../schemas';
import { createArchitectTools } from '../tools/architect';
import { createArtistTools } from '../tools/artist';
import { createClerkTools } from '../tools/clerk';
import { createDBATools } from '../tools/dba';
import { createInternetTools } from '../tools/internet';
import { createLibrarianTools } from '../tools/librarian';
import { createPlannerTools } from '../tools/planner';
import { createSecretaryTools } from '../tools/secretary';


/**
 * Create all toolsets and return the tools and factory functions
 */
export function createToolsets(ai: CletusAI) {
  const plannerTools = createPlannerTools(ai);
  const librarianTools = createLibrarianTools(ai);
  const clerkTools = createClerkTools(ai);
  const secretaryTools = createSecretaryTools(ai);
  const architectTools = createArchitectTools(ai);
  const artistTools = createArtistTools(ai);
  const internetTools = createInternetTools(ai);

  // Create DBA tools factory for dynamic type-specific tools
  const createDBAToolsForType = (type: TypeDefinition): AnyTool[] => {
    return createDBATools(ai, type);
  };

  return {
    plannerTools,
    librarianTools,
    clerkTools,
    secretaryTools,
    architectTools,
    artistTools,
    internetTools,
    createDBATools: createDBAToolsForType,
  };
}

/**
 * Helper to filter tools based on plan mode
 */
export function filterToolsForPlanMode<TTools extends Tuple<AnyTool>>(tools: TTools) {
  const isPlanMode = (name: OperationKind, ctx: CletusAIContext) => {
    const modeFn = Operations[name]?.mode || 'unknown';
    const mode = typeof modeFn === 'function' ? modeFn({}, ctx) : modeFn;
    return mode === 'local' || mode === 'read';
  };

  return (input: any, ctx: CletusAIContext) => {
    if (ctx.chat?.agentMode === 'plan') {
      return tools.filter(t => isPlanMode(t.name as OperationKind, ctx)).map(t => t.name) as Names<TTools>[];
    } else {
      return tools.map(t => t.name) as Names<TTools>[];
    }
  };
}
