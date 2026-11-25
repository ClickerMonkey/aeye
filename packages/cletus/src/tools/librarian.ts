import { a } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { getOperationInput } from '../operations/types';

/**
 * Create librarian tools for knowledge management
 */
export function createLibrarianTools(ai: CletusAI) {
  const knowledgeSearch = ai.tool({
    name: 'knowledge_search',
    description: 'Search knowledge base by semantic similarity',
    instructions: `Use this to find relevant information from PREVIOUSLY INDEXED content using semantic search. This searches embeddings that were created earlier via file_index or knowledge_add.

IMPORTANT: This only searches content that has already been indexed. If you need to understand a specific file that hasn't been indexed, use file_read instead.

When to use:
- Searching across many previously indexed documents
- Finding relevant context from user memories
- Retrieving information from a prepared knowledge base

When NOT to use:
- File hasn't been indexed yet - use file_read instead
- Just need to read a specific file - use file_read
- No knowledge base has been set up yet

Example: Search for user preferences:
{ "query": "user's preferred programming languages", "limit": 5, "sourcePrefix": "user" }

{{modeInstructions}}`,
    schema: a.object({
      query: a.string().describe('Search query text'),
      limit: a.number().optional().describe('Maximum results (default: 10)'),
      sourcePrefix: a.string().optional().describe('Filter by source prefix (e.g., "user", "task:", "file@{path}:")'),
      ...globalToolProperties,
    }),
    input: getOperationInput('knowledge_search'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'knowledge_search', input }, ctx),
  });

  const knowledgeSources = ai.tool({
    name: 'knowledge_sources',
    description: 'List all unique source prefixes in knowledge base',
    instructions: `Use this to DISCOVER what types of knowledge have been indexed. This lists source prefixes only (e.g., "user", "task:", "file@{path}:"). It does NOT retrieve actual content.

When to use:
- User asks "what's in the knowledge base"
- Determining if specific content has been indexed
- Understanding available knowledge sources before searching

When NOT to use:
- To retrieve actual information - use knowledge_search instead
- To understand a file - use file_read instead
- Don't call this repeatedly - once is enough to see what's available

This is a lightweight metadata query that just lists source types, not content.

Example: Simply call with no parameters:
{}

{{modeInstructions}}`,
    schema: a.object({
      ...globalToolProperties,
    }),
    input: getOperationInput('knowledge_sources'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'knowledge_sources', input }, ctx),
  });

  const knowledgeAdd = ai.tool({
    name: 'knowledge_add',
    description: 'Add user memory to knowledge base',
    instructions: `Use this to store important information the user wants to remember. This will be embedded and made searchable via semantic search.

Example: Store a project detail:
{ "text": "The authentication service uses JWT tokens with a 24-hour expiration" }
 
{{modeInstructions}}`,
    schema: a.object({
      text: a.string().describe('The memory text to add'),
      ...globalToolProperties,
    }),
    input: getOperationInput('knowledge_add'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'knowledge_add', input }, ctx),
  });

  const knowledgeDelete = ai.tool({
    name: 'knowledge_delete',
    description: 'Delete all knowledge entries matching a source pattern',
    instructions: `Use this to remove knowledge entries. Provide a regex pattern to match sources and optionally specify case sensitivity. Be careful as this is permanent.

Example: Delete all knowledge from a specific file (exact match):
{ "sourcePattern": "^file@docs/old-guide\\.md:", "caseSensitive": true }

Example: Delete all knowledge from task 123 (case insensitive):
{ "sourcePattern": "task:123", "caseSensitive": false }

Example: Delete all user knowledge:
{ "sourcePattern": "^user:", "caseSensitive": true }
 
{{modeInstructions}}`,
    schema: a.object({
      sourcePattern: a.string().describe('Regex pattern to match source strings (e.g., "^task:123", "file@.*\\.md:", "^user:")'),
      caseSensitive: a.boolean().default(true).describe('Whether pattern matching is case-sensitive (default: true)'),
      ...globalToolProperties,
    }),
    input: getOperationInput('knowledge_delete'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'knowledge_delete', input }, ctx),
  });

  return [
    knowledgeSearch,
    knowledgeSources,
    knowledgeAdd,
    knowledgeDelete,
  ] as [
    typeof knowledgeSearch,
    typeof knowledgeSources,
    typeof knowledgeAdd,
    typeof knowledgeDelete,
  ];
}
