import { a } from '@aeye/schema';
import { globalToolProperties, type CletusAI } from '../ai';
import { getOperationInput } from '../operations/types';
import { typesKey } from '../helpers/dba';
import { typeNameSchema, type TypesContext } from '../helpers/type';

const FIELD_TYPE_DOC = 'Field type - can be a primitive type (string, number, boolean, date, enum) or the name of another type to create a relationship';

/**
 * `TypeName` (the configured type names) and `FieldType` (the primitives plus
 * every type name), bound per call from the configured types.
 */
const TypeNamesModule = a
  .declare<{ TypeName: string; FieldType: string }>()
  .dynamic((ctx: TypesContext) => {
    const types = ctx.config.getData().types;
    return {
      TypeName: typeNameSchema(types),
      FieldType: a.enum(['string', 'number', 'boolean', 'date', 'enum', ...types.map((t) => t.name)]).describe(FIELD_TYPE_DOC),
    };
  }, { key: (ctx) => typesKey(ctx.config.getData().types) });

const TypeInfoArgs = TypeNamesModule.result(a.object({
  name: a.ref('TypeName').describe('Type name to get information about'),
  ...globalToolProperties,
}));

const TypeListArgs = a.object({
  ...globalToolProperties,
});

const TypeUpdateArgs = TypeNamesModule.result(a.object({
  name: a.ref('TypeName').describe('Type name to update'),
  update: a.object({
    friendlyName: a.string().optional().describe('New friendly name'),
    description: a.string().optional().describe('New description'),
    knowledgeTemplate: a.string().optional().describe('New Handlebars template for knowledge generation, ie: {{name}} and {{#if field}}...{{/if}}. It should include all fields and if the fields are optional #if statements should be used. Newlines & markdown can be used for formatting.'),
    fields: a.array(a.object({
      field: a.string().describe('Field name to update (lowercase, no spaces)'),
      change: a.union([
        a.null(),
        a.object({
          friendlyName: a.string().optional().describe('Field display name, only specify if changing'),
          type: a.ref('FieldType').optional().describe('Field type, only specify if changing'),
          required: a.boolean().optional().describe('Is field required? Only specify if changing'),
          default: a.union([a.string(), a.number(), a.boolean()]).optional().describe('Default value, only specify if changing'),
          enumOptions: a.array(a.string()).optional().describe('Valid enum values (required for enum type), only specify if changing or adding enum field'),
          onDelete: a.enum(['restrict', 'cascade', 'setNull']).optional().describe('Cascade delete behavior for reference fields, only specify if changing: restrict (default, prevent deletion), cascade (delete referencing records), setNull (set field to null)'),
        }),
      ]).describe('Field updates: set to null to delete'),
    })),
  }).describe('Updates to apply'),
  ...globalToolProperties,
}));

const TypeCreateArgs = TypeNamesModule.result(a.object({
  name: a.string().describe('Type name (lowercase, no spaces)'),
  friendlyName: a.string().describe('Display name'),
  description: a.string().optional().describe('Type description'),
  knowledgeTemplate: a.string().describe('Handlebars template for knowledge generation, ie: {{name}} and {{#if field}}...{{/if}}. It should include all fields and if the fields are optional #if statements should be used. Newlines & markdown can be used for formatting.'),
  fields: a.array(
    a.object({
      name: a.string().describe('Field name (lowecase, no spaces)'),
      friendlyName: a.string().describe('Field display name'),
      type: a.ref('FieldType'),
      default: a.union([a.string(), a.number(), a.boolean()]).optional().describe('Default value'),
      required: a.boolean().optional().describe('Is field required?'),
      enumOptions: a.array(a.string()).optional().describe('Valid enum values (required for enum type)'),
      onDelete: a.enum(['restrict', 'cascade', 'setNull']).optional().describe('Cascade delete behavior for reference fields: restrict (default, prevent deletion), cascade (delete referencing records), setNull (set field to null)'),
    })
  ).describe('Field definitions'),
  ...globalToolProperties,
}));

const TypeDeleteArgs = TypeNamesModule.result(a.object({
  name: a.ref('TypeName').describe('Type name to delete'),
  ...globalToolProperties,
}));

const TypeImportArgs = a.object({
  glob: a.string().describe('Glob pattern for files to analyze (e.g., "data/*.csv", "**/*.txt")'),
  hints: a.array(a.string()).optional().describe('Optional type name hints to focus discovery (e.g., ["user", "order", "product"])'),
  max: a.number().optional().describe('Maximum number of types to discover (default: unlimited)'),
  ...globalToolProperties,
});

/**
 * Create architect tools for type definition management
 */
export function createArchitectTools(ai: CletusAI) {
  const typeInfo = ai.tool({
    name: 'type_info',
    description: 'Get all information about a type definition',
    instructions: `Use this to see the full schema of a custom data type including all fields and their properties.

Example: Get information about a type:
{ "name": "task" }
 
{{modeInstructions}}`,
    schema: TypeInfoArgs,
    applicable: ({ config }) => config.getData().types.length > 0,
    input: getOperationInput('type_info'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'type_info', input }, ctx),
  });

  const typeList = ai.tool({
    name: 'type_list',
    description: 'List all existing type definitions (names & descriptions',
    instructions: `Use this to get a list of all custom data types defined in the system, including their names and friendly names.
Example: List all types:
{ }
 
{{modeInstructions}}`,
    schema: TypeListArgs,
    input: getOperationInput('type_list'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'type_list', input }, ctx),
  });

  const typeUpdate = ai.tool({
    name: 'type_update',
    description: 'Update an EXISTING type definition in a backwards compatible way',
    instructions: `ONLY use this tool when the user explicitly asks to MODIFY, UPDATE, or CHANGE an existing type definition. DO NOT use this tool unless the user has clearly requested changes to an existing type.

Use this to modify an existing type definition:
- Never change field types (breaking change)
- Never make optional fields required without a default value (breaking change)
- You CAN add new fields (if required, must have default), update descriptions, update knowledgeTemplate, or delete any field
Provide an update object with the changes to make.
- Field names must be lowercase with no spaces.
- Knowledge templates are Handlebars templates used to generate knowledge base entries for records of this type. They should include all fields and use #if statements for optional fields. Use field name and not friendly name.

IMPORTANT:
- All types automatically have an 'id' primary key field - DO NOT add an 'id' field unless explicitly requested by the user
- Field types can be the name of another type to create relationships (e.g., "userId" field with type "user")
- RESERVED NAMES: The following field names are reserved and cannot be used: id, created, updated

Example 1: Add a new optional field:
{ "name": "task", "update": { "fields": [{ "field": "priority", "change": { "friendlyName": "Priority", "type": "number", "required": false } }] } }

Example 2: Add a relationship field to another type:
{ "name": "task", "update": { "fields": [{ "field": "assigneeid", "change": { "friendlyName": "Assignee", "type": "user", "required": false } }] } }

Example 3: Update description:
{ "name": "task", "update": { "description": "A task tracking item with assignee and deadline" } }

Example 4: Make a field optional:
{ "name": "task", "update": { "fields": [{ "field": "deadline", "change": { "required": false } }] } }

Example 5: Delete a field:
{ "name": "task", "update": { "fields": [{ "field": "priority", "change": null }] } }

If fields are being changed knowledgeTemplate MUST be updated to reflect those changes.
If the knowledgeTemplate is updated and there are records for this type the data_index tool should be called to reindex the knowledge base.

{{modeInstructions}}`,
    schema: TypeUpdateArgs,
    input: getOperationInput('type_update'),
    applicable: ({ config }) => config.getData().types.length > 0,
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'type_update', input }, ctx),
  });

  const typeCreate = ai.tool({
    name: 'type_create',
    description: 'Create a new type definition',
    instructions: `Use this to define a new custom data type with fields. Each field should have a name, friendlyName, and type. Required fields must have a default value. Field names must be all lowercase with no spaces.

IMPORTANT:
- All types automatically have an 'id' primary key field - DO NOT add an 'id' field to the fields array unless explicitly requested by the user
- Field types can be the name of another type to create relationships (e.g., "userId" field with type "user")
- When creating multiple related types, create them one at a time in dependency order (create referenced types before types that reference them)
- RESERVED NAMES: The following field names are reserved and cannot be used: id, created, updated
- RESERVED TYPE NAMES: The following type names are reserved and cannot be used: string, number, boolean, date, enum

Example 1: Create a project tracking type:
{ "name": "project", "friendlyName": "Project", "description": "Software project tracking", "knowledgeTemplate": "Project: {{name}}\\nStatus: {{status}}\\n{{#if description}}Description: {{description}}{{/if}}", "fields": [{ "name": "name", "friendlyName": "Name", "type": "string", "required": true }, { "name": "status", "friendlyName": "Status", "type": "enum", "enumOptions": ["planning", "active", "completed"], "required": true, "default": "planning" }, { "name": "description", "friendlyName": "Description", "type": "string", "required": false }] }

Example 2: Create a task type with a relationship to project (create project type first, then task):
{ "name": "task", "friendlyName": "Task", "description": "Task assigned to a project", "knowledgeTemplate": "Task: {{name}}\\nProject: {{projectid}}\\nStatus: {{status}}", "fields": [{ "name": "name", "friendlyName": "Name", "type": "string", "required": true }, { "name": "projectid", "friendlyName": "Project", "type": "project", "required": true }, { "name": "status", "friendlyName": "Status", "type": "string", "required": true, "default": "todo" }] }

{{modeInstructions}}`,
    schema: TypeCreateArgs,
    input: getOperationInput('type_create'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'type_create', input }, ctx),
  });

  const typeDelete = ai.tool({
    name: 'type_delete',
    description: 'Delete a type definition',
    instructions: `Use this to remove a type definition. This will fail if:
- The type is referenced by other types (to prevent breaking references)
- There are existing data records of this type (data must be deleted first)

Example: Delete a type:
{ "name": "task" }
 
{{modeInstructions}}`,
    schema: TypeDeleteArgs,
    applicable: ({ config }) => config.getData().types.length > 0,
    input: getOperationInput('type_delete'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'type_delete', input }, ctx),
  });

  const typeImport = ai.tool({
    name: 'type_import',
    description: 'Import and discover type definitions from files',
    instructions: `Use this to extract type definitions from unstructured files. The tool will:
1. Find files matching the glob pattern
2. Process readable files (text, PDF, Excel, Word documents)
3. Use AI to discover structured type definitions with fields
4. Present discovered types for review without automatically adding them

This is useful when the user wants to:
- "extract all transaction data from all my files"
- "can you convert this document to structured data"
- "discover data types in my CSV files"
- "analyze my JSON files and create type definitions"

This tool should be used when the user wants to discover new types from existing data files. It should NOT be used to create types that the user explicitly defines or describes.
This does not import data records, only type definitions. After types are created the data_import tool can be used to load data.

The discovered types are presented with field definitions and instance counts. The user can then review and selectively add types using type_create.

IMPORTANT:
- RESERVED FIELD NAMES: The following field names are reserved and cannot be used: id, created, updated
- RESERVED TYPE NAMES: The following type names are reserved and cannot be used: string, number, boolean, date, enum

Example 1: Discover all types from data files:
{ "glob": "data/**/*.csv" }

Example 2: Focus on specific types:
{ "glob": "documents/**/*.txt", "hints": ["user", "transaction", "product"] }

Example 3: Limit discovery to top types:
{ "glob": "**/*.json", "max": 5 }
 
{{modeInstructions}}`,
    schema: TypeImportArgs,
    input: getOperationInput('type_import'),
    call: async (input, _, ctx) => ctx.ops.handle({ type: 'type_import', input }, ctx),
  });

  return [
    typeInfo,
    typeUpdate,
    typeCreate,
    typeDelete,
    typeImport,
    typeList,
  ] as [
    typeof typeInfo,
    typeof typeUpdate,
    typeof typeCreate,
    typeof typeDelete,
    typeof typeImport,
    typeof typeList,
  ];
}
