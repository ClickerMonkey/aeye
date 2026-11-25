import Handlebars from "handlebars";
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { a } from '@aeye/schema';
import { CletusAIContext, transcribe } from "../ai";
import { abbreviate, formatName, pluralize } from "../common";
import { ConfigFile } from "../config";
import { CONSTS } from "../constants";
import { DataManager } from "../data";
import { canEmbed, embed } from "../embed";
import { getAssetPath } from "../file-manager";
import { processFile, searchFiles } from "../helpers/files";
import { renderOperation } from "../helpers/render";
import { buildFieldsSchema, getType, getTypeName, type FieldValues } from "../helpers/type";
import { KnowledgeFile } from "../knowledge";
import { KnowledgeEntry, TypeDefinition, TypeField } from "../schemas";
import { operationOf } from "./types";
import { executeQuery, executeQueryWithoutCommit, commitQueryChanges, canCommitQueryResult, QueryResult, QueryExecutionPayload, CanCommitResult } from '../helpers/query';
import type { Query } from '../helpers/dba';
import { DBAGrammar, dbaTypeDefs, describeTypes, typesKey } from '../helpers/dba';
import { QUERY_EXAMPLES } from '../helpers/dba-examples';

/**
 * The extractor's answer: the records found, each an object of the type's
 * fields (bound per type definition).
 */
const ExtractorOutput = a
  .declare<{ Fields: FieldValues }>()
  .dynamic((_ctx: unknown, input: { typeDef: TypeDefinition }) => ({ Fields: buildFieldsSchema(input.typeDef) }), {
    key: (_ctx, input) => typesKey([input.typeDef]),
  })
  .result(a.object({
    results: a.array(a.ref('Fields')),
  }));

/**
 * The query type selector's answer: the type names a query needs.
 */
const TypeSelectorOutput = a
  .declare<{ TypeName: string }>()
  .dynamic((_ctx: unknown, input: { types: TypeDefinition[] }) => ({
    TypeName: a.enum(input.types.map(t => t.name) as [string, ...string[]]),
  }), { key: (_ctx, input) => typesKey(input.types) })
  .result(a.object({
    types: a.array(a.ref('TypeName')).describe('Array of type names needed for the query'),
  }));

/**
 * A query over the given types (query_builder, query_fixer).
 */
const QueryOutput = DBAGrammar
  .dynamic((_ctx: unknown, input: { types: TypeDefinition[] }) => dbaTypeDefs(input.types), {
    key: (_ctx, input) => typesKey(input.types),
  })
  .result(a.object({
    query: a.ref('Query'),
  }));

/**
 * The fields that identify a record (strict structured output).
 */
const UniqueFieldsOutput = a.object({
  fields: a.array(a.string()),
});


const getKnowledge = async () => {
  const knowledgeFile = new KnowledgeFile();
  await knowledgeFile.load();
  return knowledgeFile.getData().knowledge;
};

const embedQuery = (text: string) => embed([text]).then(vectors => vectors?.[0] || []);

const getManager = (typeName: string) => new DataManager(typeName);

export const data_index = operationOf<
  { type: string },
  { libraryKnowledgeUpdated: boolean },
  {},
  { typeName: string }
>({
  mode: 'update',
  signature: 'data_index()',
  status: ({ type }) => `Indexing ${type}`,
  analyze: async ({ input: { type } }, { config }) => {
    const typeDef = getType(config, type);
    
    return {
      analysis: `This will update the knowledge for type "${typeDef.friendlyName}".`,
      doable: true,
      cache: { typeName: typeDef.friendlyName },
    };
  },
  do: async ({ input: { type } }, ctx) => {
    const dataManager = new DataManager(type);
    await dataManager.load();

    const allRecords = dataManager.getAll();
    const recordIds = allRecords.map(r => r.id);

    const libraryKnowledgeUpdated = await updateKnowledge(ctx, type, recordIds, []);

    return { libraryKnowledgeUpdated };
  },
  render: (op, ai, showInput, showOutput) => {
    // Use cached typeName for consistent rendering even if type is deleted
    const typeName = op.cache?.typeName ?? getTypeName(ai.config.defaultContext!.config!, op.input.type);

    return renderOperation(
      op,
      `${formatName(typeName)}Index()`,
      (op) => {
        if (op.output?.libraryKnowledgeUpdated) {
          return `Knowledge updated for type: ${typeName}`;
        }
        return null;
      },
      showInput, showOutput
    );
  },
});

export const data_import = operationOf<
  { type: string; glob: string; transcribeImages?: boolean },
  { imported: number; failed: number; updated: number; updateSkippedNoChanges: number; libraryKnowledgeUpdated: boolean },
  {},
  { typeName: string; importableCount: number }
>({
  mode: 'create',
  signature: 'data_import(glob: string, transcribeImages?)',
  status: ({ type, glob }) => `Importing ${type} from ${glob}`,
  analyze: async ({ input: { type, glob } }, { config, cwd, signal }) => {
    const typeDef = getType(config, type);
    const files = await searchFiles(cwd, glob, signal);
    
    const unreadable = files.filter(f => f.fileType === 'unreadable').map(f => f.file);
    const images = files.filter(f => f.fileType === 'image').map(f => f.file);
    const unknown = files.filter(f => f.fileType === 'unknown').map(f => f.file);
    const importable = files.filter(f => f.fileType !== 'unknown' && f.fileType !== 'unreadable' && f.fileType !== 'image').map(f => f.file);
    
    let analysis = '';
    if (unreadable.length > 0) {
      analysis += `Found ${unreadable.length} unreadable file(s): ${unreadable.join(', ')}\n`;
    }
    if (images.length > 0) {
      analysis += `Found ${images.length} image file(s) (images will be skipped unless transcribeImages is enabled)\n`;
    }
    if (unknown.length > 0) {
      analysis += `Found ${unknown.length} file(s) of unknown/unsupported format: ${unknown.join(', ')}.\n`;
    }
    analysis += `This will import ${typeDef.friendlyName} records from ${importable.length} file(s) matching "${glob}". Files will be processed with AI extraction.`;
    
    return {
      analysis,
      doable: importable.length > 0,
      cache: { typeName: typeDef.friendlyName, importableCount: importable.length },
    };
  },
  do: async ({ input: { type, glob, transcribeImages = false } }, ctx) => {
    const { chatStatus, ai, config, cwd, log, signal } = ctx;
    const typeDef = getType(config, type);
    const dataManager = new DataManager(type);
    await dataManager.load();
    
    // Find and filter files
    const files = await searchFiles(cwd, glob, signal);
    const importableFiles = files.filter(f => {
      if (f.fileType === 'unknown' || f.fileType === 'unreadable') {
        return false;
      }
      // Include images only if transcribeImages is enabled
      if (f.fileType === 'image' && !transcribeImages) {
        return false;
      }
      return true;
    });

    log(`data_import: found ${files.length} files, ${importableFiles.length} importable`);
    
    chatStatus(`Found ${importableFiles.length} files to process`);
    
    // Create prompt for extraction
    const extractor = ai.prompt({
      name: 'extractor',
      description: 'Extract structured data from text',
      content: `You are an expert data extraction assistant. Your task is to extract structured data from unstructured text based on the provided type definition.
Provide only the extracted data in JSON format as specified, without any additional commentary or explanation.
    
You are extracting all instances of {{typeDef.friendlyName}} from the provided text.
Return an array of objects with the fields defined above. If no instances are found, return an empty array.

<typeInformation>
Type: {{typeDef.friendlyName}}
{{#if typeDef.description}}Description: {{typeDef.description}}{{/if}}

Fields:
{{#each typeDef.fields}}
- {{this.name}} ({{this.type}}{{#if this.required}}, required{{/if}}{{#if this.enumOptions}}, options: {{this.enumOptions}}{{/if}}{{#if this.default}}, default: {{this.default}}{{/if}})
{{/each}}
</typeInformation>

<text>
{{text}}
</text>`,
      schema: ExtractorOutput,
      input: ({ text, typeDef }: { text: string; typeDef: TypeDefinition }) => ({ typeDef, text }),
      metadataFn: () => ({
        model: config.getData().user.models?.chat,
      }),
      excludeMessages: true,
    });

    
    let allExtractedRecords: Record<string, any>[] = [];
    
    // Process files in parallel
    let filesProcessed = 0;
    let filesExtracted = 0;
    let filesFailed = 0;
    await Promise.all(importableFiles.map(async (file) => {
      if (signal?.aborted) {
        return;
      }

      const fullPath = path.resolve(cwd, file.file);
      
      try {
        // Process file to get sections
        const parsed = await processFile(fullPath, file.file, {
          assetPath: await getAssetPath(true),
          sections: true,
          transcribeImages: transcribeImages,
          describeImages: false,
          extractImages: false,
          summarize: false,
          transcriber: (image) => transcribe(ai, image, signal),
          signal,
        });
        
        // Status update
        filesProcessed++;
        chatStatus(`Processed/extracted ${filesProcessed}/${filesExtracted} out of ${pluralize(importableFiles.length, 'file')}`);
        
        // Group sections to minimize LLM calls (combine sections up to MAX_EXTRACTION_CHUNK_SIZE)
        const sectionGroups: string[] = [];
        let currentGroup = '';
        
        for (const section of parsed.sections) {
          if (!section || section.trim().length === 0) {
            continue;
          }
          
          // If adding this section would exceed the limit, save current group and start new one
          if (currentGroup.length > 0 && currentGroup.length + section.length + 2 > CONSTS.MAX_EXTRACTION_CHUNK_SIZE) {
            sectionGroups.push(currentGroup);
            currentGroup = section;
          } else {
            // Add section to current group with separator
            currentGroup = currentGroup.length > 0 ? currentGroup + '\n\n' + section : section;
          }
        }
        
        // Add final group if not empty
        if (currentGroup.length > 0) {
          sectionGroups.push(currentGroup);
        }
        
        // Extract data from grouped sections
        const extractedResults = await Promise.allSettled(sectionGroups.map(async (group, index) => {
          try {
            const { results } = await extractor.get('result', { text: group, typeDef }, ctx) || { results: [] };

            return results;
          } catch (error) {
            log(`Warning: Failed to extract from section group in ${file.file}: ${(error as Error).message}`);
            return [];
          }
        }));

        // Collect successful extractions
        allExtractedRecords.push(...extractedResults.flatMap(p => p.status === 'fulfilled' ? p.value : []));

        // Status update
        filesExtracted++;
        chatStatus(`Processed/extracted ${filesProcessed}/${filesExtracted} out of ${pluralize(importableFiles.length, 'file')}`)
      } catch (error) {
        log(`Warning: Failed to process file ${file.file}: ${(error as Error).message}`);
        filesFailed++;
      }
    }));

    log(`data_import: extracted ${allExtractedRecords.length} records from ${importableFiles.length} files`);
    
    // If no records extracted, return early
    if (allExtractedRecords.length === 0) {
      return { imported: 0, updated: 0, failed: filesFailed, updateSkippedNoChanges: 0, libraryKnowledgeUpdated: false };
    }

    chatStatus(`Extracted ${allExtractedRecords.length} potential records`);
    
    // Get sample records for uniqueness determination
    const sampleSize = Math.min(10, allExtractedRecords.length);
    const sampleRecords = allExtractedRecords.slice(0, sampleSize);
    
    // Ask AI to determine unique fields
    chatStatus('Determining unique fields...');
    const uniqueFields = await determineUniqueFields(ai, config, typeDef, sampleRecords);
    chatStatus(`Importing data${uniqueFields.length > 0 ? ` using unique fields ${uniqueFields.join(', ')}` : ''}`);
    
    log(`data_import: using unique fields: ${uniqueFields.join(', ')}`);

    // Merge data based on unique fields
    let imported = 0;
    let updated = 0;
    let updateSkippedNoChanges = 0;
    const updatedIds: string[] = [];

    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    
    // Use single save operation for all changes
    await dataManager.save((dataFile) => {
      for (const record of allExtractedRecords) {
        // Find existing record by unique fields
        let existingRecord = null;
        if (uniqueFields.length > 0) {
          existingRecord = dataFile.data.find(existing => 
            uniqueFields.every(field => existing.fields[field] === record[field])
          );
        }
        
        if (existingRecord) {
          // Check if there are actual changes
          const hasChanges = Object.keys(record).some(
            field => JSON.stringify(existingRecord!.fields[field]) !== JSON.stringify(record[field])
          );
          
          if (hasChanges) {
            Object.assign(existingRecord.fields, record);
            existingRecord.updated = Date.now();
            updatedIds.push(existingRecord.id);
            updated++;
          } else {
            updateSkippedNoChanges++;
          }
        } else {
          // Create new record
          const id = uuidv4();
          const now = Date.now();
          dataFile.data.push({
            id,
            created: now,
            updated: now,
            fields: record,
          });
          updatedIds.push(id);
          imported++;
        }
      }
    });
    
    chatStatus('Updating knowledge base...');
    
    // Update knowledge base
    let libraryKnowledgeUpdated = true;
    try {
      libraryKnowledgeUpdated = await updateKnowledge(ctx, type, updatedIds, []);
    } catch (e) {
      log(`Warning: failed to update knowledge base after import: ${(e as Error).message}`);
      libraryKnowledgeUpdated = false;
    }
    
    return { imported, updated, updateSkippedNoChanges, libraryKnowledgeUpdated, failed: filesFailed };
  },
  render: (op, ai, showInput, showOutput) => {
    // Use cached typeName for consistent rendering even if type is deleted
    const typeName = op.cache?.typeName ?? getTypeName(ai.config.defaultContext!.config!, op.input.type);
    return renderOperation(
      op,
      `${formatName(typeName)}Import("${op.input.glob}")`,
      (op) => {
        if (op.output) {
          return `Imported ${op.output.imported} new, updated ${op.output.updated}, skipped ${op.output.updateSkippedNoChanges} duplicate(s)`;
        } else if (op.cache?.importableCount !== undefined) {
          return `Will import from ${op.cache.importableCount} file(s)`;
        }
        return null;
      },
      showInput, showOutput
    );
  },
});

export const data_search = operationOf<
  { type: string; query: string; n?: number },
  { query: string; results: Array<{ source: string; text: string; similarity: number }> },
  {},
  { typeName: string; limit: number }
>({
  mode: 'local',
  signature: 'data_search(query: string, n?)',
  status: ({ type, query }) => `Searching ${type}: ${abbreviate(query, 25)}`,
  analyze: async ({ input: { type, query, n } }, { config }) => {
    const typeDef = getType(config, type);
    const limit = n || 10;

    if (!await canEmbed()) {
      return {
        analysis: 'Embedding model is not configured, cannot perform vector search.',
        doable: false,
      };
    }

    return {
      analysis: `This will search ${typeDef.friendlyName} knowledge for "${query}", returning up to ${limit} results.`,
      doable: true,
      cache: { typeName: typeDef.friendlyName, limit },
    };
  },
  do: async ({ input: { type, query, n } }, { ai }) => {
    if (!await canEmbed()) {
      throw new Error('Embedding model is not configured');
    }

    const knowledge = new KnowledgeFile();
    await knowledge.load();

    const limit = n || 10;
    
    // Generate embedding for query
    const [queryVector] = await embed([query]) || [];
    if (!queryVector) {
      throw new Error('Failed to generate embedding for query');
    }

    // Search for similar entries with source prefix matching the type name
    const sourcePrefix = `${type}:`;
    const similarEntries = knowledge.searchBySimilarity(queryVector, limit, sourcePrefix);

    return {
      query,
      results: similarEntries.map((result) => ({
        source: result.entry.source,
        text: result.entry.text,
        similarity: result.similarity,
      })),
    };
  },
  render: (op, ai, showInput, showOutput) => {
    // Use cached typeName for consistent rendering even if type is deleted
    const typeName = op.cache?.typeName ?? getTypeName(ai.config.defaultContext!.config!, op.input.type);
    return renderOperation(
      op,
      `${formatName(typeName)}Search("${abbreviate(op.input.query, 20)}")`,
      (op) => {
        if (op.output) {
          return `Found ${pluralize(op.output.results.length, 'result')}`;
        }
        return null;
      },
      showInput, showOutput
    );
  },
});

export const data_get = operationOf<
  { type: string; offset?: number; limit?: number },
  { records: Array<Record<string, any>>; total: number },
  {},
  { typeName: string }
>({
  mode: 'local',
  signature: 'data_get(offset?, limit?)',
  status: ({ type }) => `Getting ${type} records`,
  analyze: async ({ input: { type, offset = 0, limit = 10 } }, { config }) => {
    const typeDef = getType(config, type);

    return {
      analysis: `This will retrieve ${typeDef.friendlyName} records (offset: ${offset}, limit: ${limit}).`,
      doable: true,
      cache: { typeName: typeDef.friendlyName },
    };
  },
  do: async ({ input: { type, offset = 0, limit = 10 } }) => {
    const dataManager = new DataManager(type);
    await dataManager.load();

    const allRecords = dataManager.getAll();
    const total = allRecords.length;
    const records = allRecords.slice(offset, offset + limit).map((record) => ({
      id: record.id,
      created: record.created,
      updated: record.updated,
      ...record.fields,
    }));

    return { records, total };
  },
  render: (op, ai, showInput, showOutput) => {
    // Use cached typeName for consistent rendering even if type is deleted
    const typeName = op.cache?.typeName ?? getTypeName(ai.config.defaultContext!.config!, op.input.type);
    const offset = op.input.offset ?? 0;
    const limit = op.input.limit ?? 10;
    return renderOperation(
      op,
      `${formatName(typeName)}Get(${offset}, ${limit})`,
      (op) => {
        if (op.output) {
          return `Retrieved ${op.output.records.length} of ${op.output.total} records`;
        }
        return null;
      },
      showInput, showOutput
    );
  },
});

/**
 * Get the kind of a query statement for display
 */
function getQueryKind(query: Query): string {
  if ('kind' in query) {
    if (query.kind === 'withs') {
      return 'cte';
    }
    return query.kind.toLowerCase();
  }
  return 'query';
}

/**
 * Get a brief description of the query for display
 */
function describeQuery(query: Query): string {
  if ('kind' in query) {
    switch (query.kind) {
      case 'select':
        const selectParts: string[] = [];
        if (query.from?.kind === 'table') {
          selectParts.push(`from ${query.from.table}`);
        }
        if (query.joins?.length) {
          selectParts.push(`${query.joins.length} join(s)`);
        }
        if (query.where?.length) {
          selectParts.push('filtered');
        }
        if (query.groupBy?.length) {
          selectParts.push('grouped');
        }
        return selectParts.length > 0 ? selectParts.join(', ') : 'simple';
        
      case 'insert':
        return `into ${query.table}`;
        
      case 'update':
        return `${query.table}`;
        
      case 'delete':
        return `from ${query.table}`;
        
      case 'union':
      case 'intersect':
      case 'except':
        return `${query.kind}`;
        
      case 'withs':
        const cteNames = query.withs.map(w => w.name).join(', ');
        return `CTEs: ${cteNames}`;
        
      default:
        return '';
    }
  }
  return '';
}

export interface QueryOperationCache {
  payload?: QueryExecutionPayload;
  canCommit?: CanCommitResult;
  builtQuery?: Query; // Store the built query when input is a string
  queryString?: string; // Store the original query string for rendering
}

/**
 * Maximum number of retry attempts for query validation
 */
const MAX_QUERY_RETRY_ATTEMPTS = 5;

/**
 * Validates a Query object and retries with corrections if validation fails.
 *
 * @param query - The Query object to validate
 * @param ctx - The Cletus AI context
 * @param getManager - Function to get a data manager for a type
 * @param types - The types the query may use
 * @param queryDescription - Optional original query description (for context when fixing)
 * @returns A valid QueryExecutionPayload
 * @throws Error if validation fails after all retry attempts
 */
async function validateQueryWithRetry(
  query: Query,
  ctx: CletusAIContext,
  getManager: (typeName: string) => DataManager,
  types: TypeDefinition[],
  queryDescription?: string
): Promise<QueryExecutionPayload> {
  const { config, ai, chatStatus } = ctx;

  let currentQuery = query;
  let lastErrors: Array<{ path: string; message: string; suggestion?: string }> = [];

  for (let attempt = 1; attempt <= MAX_QUERY_RETRY_ATTEMPTS; attempt++) {
    // Execute query without committing to validate
    const payload = await executeQueryWithoutCommit(
      currentQuery,
      () => config.getData().types,
      getManager,
      getKnowledge,
      embedQuery,
    );

    // If validation succeeded, return the payload
    if (payload.result.canCommit || !payload.result.validationErrors || payload.result.validationErrors.length === 0) {
      return payload;
    }

    // Store the errors for this attempt
    lastErrors = payload.result.validationErrors;

    // If this was the last attempt, throw an error
    if (attempt === MAX_QUERY_RETRY_ATTEMPTS) {
      const errorSummary = lastErrors
        .map(err => `${err.path}: ${err.message}${err.suggestion ? ` (${err.suggestion})` : ''}`)
        .join('\n');
      throw new Error(`Query validation failed after ${MAX_QUERY_RETRY_ATTEMPTS} attempts:\n${errorSummary}`);
    }

    // Ask AI to fix the query based on validation errors
    chatStatus(`Validation failed (attempt ${attempt}/${MAX_QUERY_RETRY_ATTEMPTS}), requesting correction...`);

    const errorDetails = lastErrors
      .map(err => `- ${err.path}: ${err.message}${err.suggestion ? ` (Suggestion: ${err.suggestion})` : ''}`)
      .join('\n');

    const queryFixer = ai.prompt({
      name: 'query_fixer',
      description: 'Fix a query based on validation errors',
      content: `You are a database query fixer. You will be given a query that failed validation and the validation errors.
Your task is to correct the query to resolve all validation errors.

{{#if queryDescription}}Original user request:
{{queryDescription}}{{/if}}

Original query:
{{queryJson}}

Validation errors:
{{errorDetails}}

Analyze the errors and provide a corrected query that resolves all validation issues. Make minimal changes necessary to fix the errors${queryDescription ? ', while ensuring the query still satisfies the original user request' : ''}.`,
      schema: QueryOutput,
      input: ({ queryJson, errorDetails, queryDescription }: { queryJson: string; errorDetails: string; queryDescription?: string; types: TypeDefinition[] }) => ({ queryJson, errorDetails, queryDescription }),
      metadataFn: () => ({
        model: config.getData().user.models?.chat,
      }),
    });

    const { query: correctedQuery } = await queryFixer.get('result', {
      queryJson: JSON.stringify(currentQuery, null, 2),
      errorDetails,
      queryDescription,
      types,
    }, ctx) as { query: Query };

    currentQuery = correctedQuery;
  }

  // This should never be reached due to the throw in the loop, but TypeScript needs it
  throw new Error('Unexpected: validation retry loop ended without result');
}

/**
 * Validates and executes a query, retrying on validation errors up to MAX_QUERY_RETRY_ATTEMPTS times.
 *
 * @param queryInput - The query to validate and execute (can be a string description or Query object)
 * @param ctx - The Cletus AI context
 * @param getManager - Function to get a data manager for a type
 * @returns A valid QueryExecutionPayload
 * @throws Error if validation fails after all retries or if the query cannot be built
 */
async function validateAndExecuteQuery(
  queryInput: Query | string,
  ctx: CletusAIContext,
  getManager: (typeName: string) => DataManager
): Promise<{ payload: QueryExecutionPayload; builtQuery?: Query; queryString?: string }> {
  const { config, ai, chatStatus } = ctx;

  // Store the original query string for cache
  const queryDescription = typeof queryInput === 'string' ? queryInput : undefined;

  // The types the query may use (for corrections)
  let queryTypes: TypeDefinition[];

  // If query is a string, we need to build it first
  let parsedQuery: Query;

  if (typeof queryInput === 'string') {
    chatStatus('Analyzing query requirements...');

    // Step 1: Get list of types needed for the query
    const types = config.getData().types;
    const typeNames = types.map(t => t.name);
    const typeDescriptions = describeTypes(types);

    // Guard against empty type names array
    if (typeNames.length === 0) {
      throw new Error('No data types available to build query');
    }

    const typeSelector = ai.prompt({
      name: 'query_type_selector',
      description: 'Determine which data types are needed for a query',
      content: `You are a database query analyzer. Given a natural language query description and a list of available data types, determine which types are needed to execute the query.

Available types:
{{typeDescriptions}}

Query description:
{{queryDescription}}

Return a JSON object with an array of type names that are needed to execute this query. Only include types that are absolutely necessary.`,
      schema: TypeSelectorOutput,
      input: ({ queryDescription }: { queryDescription: string; types: TypeDefinition[] }) => ({ typeDescriptions, queryDescription }),
      metadataFn: () => ({
        model: config.getData().user.models?.chat,
      }),
    });

    const { types: neededTypeNames } = await typeSelector.get('result', { queryDescription: queryInput, types }, ctx) as { types: string[] };

    // Validate that all needed types exist
    const neededTypes = neededTypeNames
      .map(name => types.find(t => t.name === name))
      .filter((t): t is TypeDefinition => t !== undefined);

    if (neededTypes.length === 0) {
      throw new Error('Could not determine which data types are needed for this query');
    }

    chatStatus(`Building query for types: ${neededTypes.map(t => t.friendlyName).join(', ')}...`);

    // Step 2: Build the query using the selected types
    queryTypes = neededTypes;
    const neededTypeDescriptions = describeTypes(neededTypes);

    const queryBuilder = ai.prompt({
      name: 'query_builder',
      description: 'Build a structured query from a natural language description',
      content: `You are a database query builder. Given a natural language query description and the schema for relevant data types, build a structured query object that accomplishes the desired operation.

Available types:
{{neededTypeDescriptions}}

Query description:
{{queryDescription}}

Build a query object that satisfies this description. The query must be valid according to the schema and should precisely match the intent of the description.

Here are some examples of valid query structures:

{{queryExamples}}`,
      schema: QueryOutput,
      input: ({ queryDescription }: { queryDescription: string; types: TypeDefinition[] }) => ({ 
        neededTypeDescriptions, 
        queryDescription,
        queryExamples: QUERY_EXAMPLES,
      }),
      metadataFn: () => ({
        model: config.getData().user.models?.chat,
      }),
    });

    const { query } = await queryBuilder.get('result', { queryDescription: queryInput, types: neededTypes }, ctx) as { query: Query };

    parsedQuery = query;
  } else {
    parsedQuery = queryInput;
    queryTypes = config.getData().types;
  }

  // Validate the query with retry logic
  const payload = await validateQueryWithRetry(parsedQuery, ctx, getManager, queryTypes, queryDescription);

  return {
    payload,
    builtQuery: typeof queryInput === 'string' ? parsedQuery : undefined,
    queryString: queryDescription,
  };
}

export const query = operationOf<
  { query: Query | string; commit?: boolean },
  QueryResult,
  {},
  QueryOperationCache
>({
  mode: 'update', // Can modify data, so requires update mode
  signature: 'query(query: Query | string, commit?: boolean = true)',
  status: ({ query }) => typeof query === 'string' ? `Executing query: ${abbreviate(query, 50)}` : `Executing ${getQueryKind(query)} query`,
  inputFormat: 'json',
  outputFormat: 'json',
  analyze: async ({ input: { query: queryInput } }, { config }) => {
    // If query is a string, we cannot analyze it in the analyze phase
    // Analysis requires executing prompts which is not allowed in analyze phase
    if (typeof queryInput === 'string') {
      return {
        analysis: `The query will be built and validated during execution.`,
        doable: true,
        cache: { queryString: queryInput },
      };
    }

    const kind = getQueryKind(queryInput);
    const description = describeQuery(queryInput);

    // Execute the query without committing to see what would happen
    const payload = await executeQueryWithoutCommit(
      queryInput,
      () => config.getData().types,
      getManager,
      getKnowledge,
      embedQuery,
    );
    
    // Describe what the query would do based on the results
    const result = payload.result;

    // Check for validation errors
    if (!result.canCommit && result.validationErrors && result.validationErrors.length > 0) {
      const errorSummary = result.validationErrors
        .map((err, i) => `[${i + 1}] ${err.path}: ${err.message}`)
        .join('\n');

      return {
        analysis: `This would fail due to validation errors:\n${errorSummary}`,
        doable: false,
        cache: { payload },
      };
    }

    const parts: string[] = [];

    if (result.rows.length > 0) {
      parts.push(`return ${pluralize(result.rows.length, 'row')}`);
    }
    if (result.inserted?.length) {
      const count = result.inserted.reduce((a, b) => a + b.ids.length, 0);
      parts.push(`insert ${pluralize(count, 'record')}`);
    }
    if (result.updated?.length) {
      const count = result.updated.reduce((a, b) => a + b.ids.length, 0);
      parts.push(`update ${pluralize(count, 'record')}`);
    }
    if (result.deleted?.length) {
      const count = result.deleted.reduce((a, b) => a + b.ids.length, 0);
      parts.push(`delete ${pluralize(count, 'record')}`);
    }

    const action = result.affectedCount === 0 ? 'did' : 'will';
    const detailedAnalysis = parts.length > 0
      ? `This ${action} ${parts.join(', ')}.`
      : `This ${action} execute a ${kind} query${description ? ` (${description})` : ''}.`;

    return {
      analysis: detailedAnalysis,
      doable: result.canCommit,
      cache: { payload },
      ...(result.affectedCount === 0 ? {
        done: true,
        output: result
      } : {}),
    };
  },
  do: async ({ input: { query: queryInput, commit = true }, cache }, ctx) => {
    const getManager = (typeName: string) => new DataManager(typeName);

    // Create a copy of the cache to update
    const updatedCache: QueryOperationCache = {
      ...cache,
    };

    // The execution payload (from cache or newly executed)
    let payload = cache?.payload;

    // If no cached payload, we need to validate and execute the query
    if (!payload) {
      // Validate and execute the query (handles string queries with retries)
      const { payload: validatedPayload, builtQuery, queryString } = await validateAndExecuteQuery(queryInput, ctx, getManager);

      // Update cache with new payload and built query info
      updatedCache.builtQuery = builtQuery;
      updatedCache.queryString = queryString;
      updatedCache.canCommit = { canCommit: validatedPayload.result.canCommit };
      updatedCache.payload = payload = validatedPayload;
    } else if (commit) {
      // If we have a cached payload but no canCommit status, check if we can commit now
      const canCommitResult = await canCommitQueryResult(payload, getManager);

      updatedCache.canCommit = canCommitResult;
    }

    // If we are committing and can commit, do so
    if (commit && updatedCache.canCommit?.canCommit) {
      // Commit the changes (single call)
      const output = await commitQueryChanges(payload, getManager);

      // Update knowledge base for affected records (single call)
      await updateKnowledgeFromQueryResult(ctx, output);

      // Update cache payload result to reflect committed changes
      payload.result = output;
    }

    return {
      output: payload.result,
      cache: updatedCache,
    };
  },
  render: (op, ai, showInput, showOutput) => {
    // Check if the query was originally a string
    const isStringQuery = typeof op.input.query === 'string';
    const queryToUse = op.cache?.builtQuery || (typeof op.input.query === 'string' ? null : op.input.query);
    
    let kind: string;
    let description: string;
    
    if (isStringQuery && op.cache?.queryString) {
      // For string queries, use abbreviated string in render
      kind = 'query';
      description = abbreviate(op.cache.queryString, 100);
    } else if (queryToUse) {
      kind = getQueryKind(queryToUse);
      description = describeQuery(queryToUse);
    } else {
      kind = 'query';
      description = '';
    }
    
    // Determine render name based on referenced tables
    const referencedTables = op.cache?.payload?.result?.tables || [];
    let renderName: string;
    if (referencedTables.length === 1) {
      // Single table - use typeName format
      const typeName = getTypeName(ai.config.defaultContext!.config!, referencedTables[0]);
      renderName = `${formatName(typeName)}Query(${kind}${description ? `: ${description}` : ''})`;
    } else {
      // Multiple tables or unknown - just use Query
      renderName = `Query(${kind}${description ? `: ${description}` : ''})`;
    }

    return renderOperation(
      op,
      renderName,
      (op) => {
        if (op.output) {
          const parts: string[] = [];
          if (op.output.rows.length > 0) {
            parts.push(`${pluralize(op.output.rows.length, 'row')}`);
          }
          if (op.output.inserted?.length) {
            parts.push(`${op.output.inserted.reduce((a, b) => a + b.ids.length, 0)} inserted`);
          }
          if (op.output.updated?.length) {
            parts.push(`${op.output.updated.reduce((a, b) => a + b.ids.length, 0)} updated`);
          }
          if (op.output.deleted?.length) {
            parts.push(`${op.output.deleted.reduce((a, b) => a + b.ids.length, 0)} deleted`);
          }
          return parts.length > 0 ? parts.join(', ') : 'Query executed';
        }

        // If no output, check if we have canCommit status in cache
        if (op.cache?.canCommit && !op.cache.canCommit.canCommit) {
          return `Cannot execute: ${op.cache.canCommit.reason}`;
        }

        return null;
      },
      showInput, showOutput
    );
  },
});

/**
 * Update knowledge base after a query with affected rows.
 * 
 * For each type that had records inserted, updated, or deleted,
 * this function updates the knowledge base entries accordingly.
 * Inserted and updated records are re-indexed, while deleted records
 * are removed from the knowledge base.
 * 
 * @param ctx - The Cletus AI context containing config and logging
 * @param result - The query result containing affected rows by type
 */
async function updateKnowledgeFromQueryResult(ctx: CletusAIContext, result: QueryResult): Promise<void> {
  // Collect all affected record IDs by type
  const changesByType = new Map<string, { updated: string[]; deleted: string[] }>();
  
  // Process inserted records
  if (result.inserted) {
    for (const { type, ids } of result.inserted) {
      const byType = changesByType.get(type) || { updated: [], deleted: [] };
      byType.updated.push(...ids);
      changesByType.set(type, byType);
    } 
  }
  
  // Process updated records
  if (result.updated) {
    for (const { type, ids } of result.updated) {
      const byType = changesByType.get(type) || { updated: [], deleted: [] };
      byType.updated.push(...ids);
      changesByType.set(type, byType);
    }
  }
  
  // Process deleted records
  if (result.deleted) {
    for (const { type, ids } of result.deleted) {
      const byType = changesByType.get(type) || { updated: [], deleted: [] };
      byType.deleted.push(...ids);
      changesByType.set(type, byType);
    }
  }
  
  // Update knowledge base for each affected type
  for (const [type, { updated, deleted }] of changesByType.entries()) {
    try {
      await updateKnowledge(ctx, type, updated,deleted);
    } catch (e) {
      ctx.log(`Warning: failed to update knowledge base for ${type}: ${(e as Error).message}`);
    }
  }
}

/**
 * Updates knowledge entries for a given type.
 * 
 * @param ctx 
 * @param type 
 * @param update 
 * @param remove 
 */
async function updateKnowledge(ctx: CletusAIContext, typeName: string, update: string[], remove: string[]): Promise<boolean> {
  const type = ctx.config.getData().types.find(t => t.name === typeName);
  if (!type) {
    throw new Error(`Data type not found: ${typeName}`);
  }
  if (!type.knowledgeTemplate && remove.length === 0) {
    return false;
  }

  if (!await canEmbed()) {
    return false;
  }

  const dataFile = new DataManager(type.name);
  await dataFile.load();
  
  const typeTemplate = type.knowledgeTemplate ? Handlebars.compile(type.knowledgeTemplate, { noEscape: true }) : () => '';
  const updateTemplates = update
    .map(id => {
      const record = dataFile.getById(id);
      if (record) {
        return { id, text: typeTemplate(record.fields) };
      }
      return null;
    })
    .filter(t => t !== null && t.text.trim().length > 0) as { id: string; text: string }[];

  const embeddings = await embed(updateTemplates.map(t => t.text), ctx.signal) || [];
  const knowledge: KnowledgeEntry[] = embeddings.map((vector, i) => ({
    source: `${typeName}:${updateTemplates[i].id}`,
    text: updateTemplates[i].text,
    vector: vector,
    created: Date.now()
  }));

  const removing = new Set(remove.map(id => `${typeName}:${id}`));

  const knowledgeFile = new KnowledgeFile();
  await knowledgeFile.load();
  await knowledgeFile.save(async (data) => {
    // Do delete first, check all models.
    data.knowledge = data.knowledge.filter(e => !removing.has(e.source));
  
    // Do update/insert
    for (const entry of knowledge) {
      const existing = data.knowledge.find(e => e.source === entry.source);
      if (existing) {
        existing.updated = Date.now();
        existing.text = entry.text;
        existing.vector = entry.vector;
      } else {
        data.knowledge.push(entry);
      }
    }
  });

  return true;
} 

/**
 * Determine which fields should be used for uniqueness checking
 */
async function determineUniqueFields(
  ai: CletusAIContext['ai'],
  config: ConfigFile,
  type: TypeDefinition,
  sampleRecords: Record<string, any>[]
): Promise<string[]> {
  const models = config.getData().user.models;
  const model = models?.chat;
  
  const fieldDescriptions = type.fields.map(field => {
    let desc = `- ${field.name} (${field.type})`;
    if (field.required) desc += ' [required]';
    if (field.enumOptions) desc += ` [options: ${field.enumOptions.join(', ')}]`;
    return desc;
  }).join('\n');
  
  const prompt = `Given the following type definition and sample records, determine which field(s) should be used to identify unique records and avoid duplicates.

Type: ${type.friendlyName}
${type.description || ''}

Fields:
${fieldDescriptions}

Sample records (up to 10):
${JSON.stringify(sampleRecords, null, 2)}

Respond with a JSON array of field names that should be used for uniqueness checking. For example: ["email"] or ["firstName", "lastName"] or [] if all records should be considered unique.

Consider:
- ID fields (id, userId, email, etc.)
- Natural keys (combinations of fields that make a record unique)
- Return empty array [] if there's no reliable way to determine uniqueness`;
  
  try {
    const response = await ai.chat.get({
      model,
      messages: [
        { role: 'system', content: 'You are a database design assistant. Analyze data schemas and identify unique key fields.' },
        { role: 'user', content: prompt },
      ],
      responseFormat: { type: UniqueFieldsOutput.bind(), strict: true },
    });
    
    // Parse JSON from content
    const results = JSON.parse(response.content) as { fields: string[] };
    
    // Validate that all fields exist in the type
    const validFields = results.fields.filter(field => 
      type.fields.some(f => f.name === field)
    );
    
    return validFields;
  } catch (error) {
    return [];
  }
}