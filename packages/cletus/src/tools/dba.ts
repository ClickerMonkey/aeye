import { a, type SchemaOf } from '@aeye/schema';
import { globalToolProperties, type CletusAI, type CletusAIContext } from '../ai';
import { getOperationInput } from '../operations/types';
import { DBAGrammar, dbaTypeDefs, typesKey, type Query } from '../helpers/dba';
import { TypeNameModule, type TypesContext } from '../helpers/type';
import { TypeDefinition } from '../schemas';
import { QUERY_EXAMPLES } from '../helpers/dba-examples';

/**
 * Determine if string schema should be used based on number of types
 */
function shouldUseStringSchema(types: TypeDefinition[], maxQuerySchemaTypes: number): boolean {
  return types.length > maxQuerySchemaTypes;
}

const QUERY_STRING_DOC = 'A detailed description of the query to execute. Must be a comprehensive description of the query to perform (selects, inserts, updates, deletes, and ctes are supported - all major Postgres expressions). Must include which types are involved, any filter conditions, known record IDs if applicable, and the precise outcome desired. Be specific and details. Do not provide a SQL looking query - you do not have enough type information to do so. You can include SQL like logic at the end if its the best way to describe complex logic that is needed.';

// The type enums are bound per call from the configured types.

const DataIndexArgs = TypeNameModule.result(a.object({
  type: a.ref('TypeName').describe('Type name to index'),
  ...globalToolProperties,
}));

const DataImportArgs = TypeNameModule.result(a.object({
  type: a.ref('TypeName').describe('Type name to import into'),
  glob: a.string().describe('Glob pattern for files to import (e.g., "data/*.csv", "**/*.txt")'),
  transcribeImages: a.boolean().optional().describe('Extract text from images in documents (default: false)'),
  ...globalToolProperties,
}));

const DataSearchArgs = TypeNameModule.result(a.object({
  type: a.ref('TypeName').describe('Type name to search'),
  query: a.string().describe('Search query text'),
  n: a.number().optional().describe('Maximum results (default: 10)'),
  ...globalToolProperties,
}));

const DataGetArgs = TypeNameModule.result(a.object({
  type: a.ref('TypeName').describe('Type name to retrieve records from'),
  offset: a.number().optional().describe('Number of records to skip (default: 0)'),
  limit: a.number().optional().describe('Maximum records to return (default: 10)'),
  ...globalToolProperties,
}));

/**
 * The query tool's arguments: the query grammar for the configured types, or
 * (over `maxQuerySchemaTypes` types) a description of the query to build.
 */
const QueryToolArgs = DBAGrammar
  .declare<{ QueryArg: Query | string }>()
  .dynamic((ctx: TypesContext) => {
    const data = ctx.config.getData();
    const asString = shouldUseStringSchema(data.types, data.user.maxQuerySchemaTypes ?? 5);
    return {
      ...dbaTypeDefs(asString ? [] : data.types),
      QueryArg: (asString
        ? a.string().describe(QUERY_STRING_DOC)
        : a.ref('Query').describe('The query to execute as a structured Query object')) as SchemaOf<Query | string>,
    };
  }, {
    key: (ctx) => {
      const data = ctx.config.getData();
      return `${data.user.maxQuerySchemaTypes ?? 5}:${typesKey(data.types)}`;
    },
  })
  .result(a.object({
    query: a.ref('QueryArg'),
    ...globalToolProperties,
  }));

/**
 * Create static DBA tools.
 * Returns an array of tools that can be registered in the tool registry.
 */
export function createDBATools(ai: CletusAI) {

  const dataIndex = ai.tool({
    name: 'data_index',
    description: 'Index records of a type for knowledge base',
    instructions: `Use this to (re)index records of a data type into the knowledge base for improved search and retrieval. 
This should be done if an embedding model has changed or a knowledge template has changed.

Example: Index all records of a type:
{ "type": "task" }
 
{{modeInstructions}}`,
    schema: DataIndexArgs,
    input: getOperationInput('data_index'),
    applicable: ({ config }) => config.getData().types.length > 0,
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'data_index', input }, ctx as unknown as CletusAIContext),
  });

  const dataImport = ai.tool({
    name: 'data_import',
    description: 'Import records from files into a data type',
    instructions: `Use this to import records from files. The tool will:
1. Find files matching the glob pattern
2. Process readable files (text, PDF, Excel, Word documents)
3. Extract structured data using AI with schema validation
4. Determine unique fields automatically to avoid duplicates
5. Merge data, updating existing records or creating new ones

Example: Import from CSV or text files:
{ "type": "task", "glob": "data/*.csv" }

Example: Import with image text extraction:
{ "type": "document", "glob": "documents/**/*.pdf", "transcribeImages": true }
 
{{modeInstructions}}`,
    schema: DataImportArgs,
    input: getOperationInput('data_import'),
    applicable: ({ config }) => config.getData().types.length > 0,
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'data_import', input }, ctx as unknown as CletusAIContext),
  });
    
  const dataSearch = ai.tool({
    name: 'data_search',
    description: 'Search records by semantic similarity',
    instructions: `Use this to find relevant records from the knowledge base using semantic search. Provide a type, query text, and optionally specify the number of results.

Example: Search for relevant records:
{ "type": "task", "query": "user preferences for notifications", "n": 5 }
 
{{modeInstructions}}`,
    schema: DataSearchArgs,
    input: getOperationInput('data_search'),
    applicable: ({ config }) => config.getData().types.length > 0,
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'data_search', input }, ctx as unknown as CletusAIContext),
  });

  const dataGet = ai.tool({
    name: 'data_get',
    description: 'Get paginated records of a data type',
    instructions: `Use this for simple paged data retrieval. Returns a page of records and the total count for a given type.

If any filtering, sorting, or complex operations are needed for accuracy, use the query tool instead.

Example: Get first 10 records:
{ "type": "task" }

Example: Get records 20-30:
{ "type": "task", "offset": 20, "limit": 10 }

{{modeInstructions}}`,
    schema: DataGetArgs,
    input: getOperationInput('data_get'),
    applicable: ({ config }) => config.getData().types.length > 0,
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'data_get', input }, ctx as unknown as CletusAIContext),
  });

  const dbaQuery = ai.tool({
    name: 'query',
    description: 'Execute complex SQL-like queries across data types',
    instructions: `Use this to execute complex queries that span multiple data types, including:
- SELECT with joins, subqueries, aggregations, window functions
- INSERT with conflict handling and returning
- UPDATE with joins and complex conditions
- DELETE with joins and complex conditions
- UNION, INTERSECT, EXCEPT set operations
- WITH (CTE) statements including recursive CTEs

This should be used when the user needs precise control over data retrieval or manipulation that goes beyond simple search or pagination.
Examples
- "Find the top 5 users who have completed the most tasks in the last month."
- "Insert a new task for user ID 123, but if a task with the same title exists, update its due date instead."
- "Update all documents tagged as 'draft' to 'final' if they were created more than 30 days ago."
- "Delete all tasks that are marked as 'completed' and were finished over 60 days ago."
- "Generate a report of total tasks completed per user, including users with zero completed tasks."

{{queryFormat}}

{{modeInstructions}}`,
    schema: QueryToolArgs,
    input: (ctx) => {
      const types = ctx.config.getData().types;
      const maxQuerySchemaTypes = ctx.config.getData().user.maxQuerySchemaTypes ?? 5;
      const useStringSchema = shouldUseStringSchema(types, maxQuerySchemaTypes);

      return {
        queryFormat: useStringSchema
          ? 'The query must be a string description that includes all necessary details: the operation to perform (SELECT/INSERT/UPDATE/DELETE), which types/tables to query, filter conditions, known record IDs if applicable, and the precise outcome desired. Do not provide a specific query - just a detailed description. You do not have enough information on each type to build a properly formed query.'
          : `The query must be a structured JSON object representing SQL operations.

${QUERY_EXAMPLES}`,
        ...getOperationInput('query')(ctx),
      };
    },
    applicable: ({ config }) => config.getData().types.length > 0,
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'query', input }, ctx as unknown as CletusAIContext),
  });

  return [
    dataIndex,
    dataImport,
    dataSearch,
    dataGet,
    dbaQuery,
  ] as [
    typeof dataIndex,
    typeof dataImport,
    typeof dataSearch,
    typeof dataGet,
    typeof dbaQuery,
  ];
}
