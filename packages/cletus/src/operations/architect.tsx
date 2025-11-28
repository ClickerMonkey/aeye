import Handlebars from 'handlebars';
import path from 'path';
import { z } from 'zod';
import { deleteUndefined, formatName, pluralize } from "../common";
import { ConfigFile } from "../config";
import type { TypeDefinition, TypeField } from "../schemas";
import { operationOf } from "./types";
import { renderOperation } from '../helpers/render';
import { searchFiles, processFile } from '../helpers/files';
import { getAssetPath } from '../file-manager';


function validateTemplate(template: string, fields: TypeField[]): string | true {
  try {
    const compiled = Handlebars.compile(template);
    // Test with sample data based on fields
    const testData: Record<string, any> = {};

    for (const field of fields) {
      testData[field.name] = field.default ?? (
        field.type === 'string' ? '' :
        field.type === 'number' ? 0 :
        field.type === 'boolean' ? false :
        field.type === 'date' ? new Date().toISOString() :
        field.type === 'enum' ? (field.enumOptions?.[0] ?? '') :
        ''
      );
    }

    compiled(testData);

    return true;
  } catch (error: any) {
    return `Invalid knowledge template: ${error.message}`;
  }
}


export const type_info = operationOf<
  { name: string },
  { type: TypeDefinition | null }
>({
  mode: 'local',
  signature: 'type_info(name: string)',
  status: (input) => `Getting type info: ${input.name}`,
  analyze: async (input, { config }) => {
    return {
      analysis: `This will get information about data type "${input.name}".`,
      doable: true,
    };
  },
  do: async (input, { config }) => {
    const types = config.getData().types;
    const type = types.find((t) => t.name === input.name);
    
    return { type: type || null };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `${formatName(op.input.name)}Info()`,
    (op) => {
      if (op.output?.type) {
        return `Found type: ${op.output.type.friendlyName}`;
      } else if (op.output?.type === null) {
        return `Type not found`;
      }
      return null;
    },
    showInput, showOutput
  ),
});

export const type_list = operationOf<
  {},
  { types: Pick<TypeDefinition, 'name' | 'friendlyName' | 'description'>[] }
>({
  mode: 'local',
  signature: 'type_list()',
  status: () => `Listing all types`,
  analyze: async (input, { config }) => {
    return {
      analysis: `This will list all existing data types.`,
      doable: true,
    };
  },
  do: async (input, { config }) => {
    const types = config.getData().types;
    const typeSummaries = types.map(t => ({
      name: t.name,
      friendlyName: t.friendlyName,
      description: t.description,
    }));
    return { types: typeSummaries };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `TypeList()`,
    (op) => {
      if (op.output?.types.length) {
        return `Found ${pluralize(op.output.types.length, 'type', 'types')}`;
      } else {
        return `No types found`;
      }
    },
    showInput, showOutput
  ),
});


type TypeUpdate = { 
  name: string; 
  update: { 
    friendlyName?: string; 
    description?: string; 
    knowledgeTemplate?: string; 
    fields?: {
      field: string;
      change: null | Partial<TypeField>
    }[];
  };
}

export const type_update = operationOf<
  TypeUpdate,
  { name: string; updated: boolean },
  { validate: (input: TypeUpdate, config: ConfigFile) => string; fieldify(input: TypeUpdate, fields: TypeField[]): TypeField[] }
>({
  mode: 'update',
  signature: 'type_update(name: string, update...)',
  status: (input) => `Updating type: ${input.name}`,
  validate(input: TypeUpdate, config: ConfigFile): string {
    const existing = config.getData().types.find((t) => t.name === input.name);
    if (!existing) {
      return `Type not found: ${input.name}`;
    }

    // Validate field updates if provided
    if (input.update.fields) {
      for (const { field: fieldName, change: fieldUpdate } of input.update.fields) {
        if (fieldName !== fieldName.toLowerCase()) {
          return `Field name "${fieldName}" must be lowercase`;
        }

        if (!fieldUpdate) {
          // Deleting a field - check if it's required (breaking change)
          const existingField = existing.fields.find((f) => f.name === fieldName);
          if (existingField?.required) {
            return `Cannot delete required field "${fieldName}" - this is a breaking change`;
          }
        } else {
          // Adding or updating a field
          const existingField = existing.fields.find((f) => f.name === fieldName);

          if (existingField) {
            // Updating existing field - check for breaking changes
            if (fieldUpdate.type && fieldUpdate.type !== existingField.type) {
              return `Cannot change type of field "${fieldName}" from "${existingField.type}" to "${fieldUpdate.type}" - this is a breaking change`;
            }
            if (fieldUpdate.required && !existingField.required && !fieldUpdate.default && !existingField.default) {
              return `Cannot make field "${fieldName}" required without a default value - this is a breaking change`;
            }
          } else {
            // Adding new field - ensure it has required properties
            if (!fieldUpdate.type) {
              return `New field "${fieldName}" must have a type`;
            }
            if (fieldUpdate.friendlyName === undefined) {
              return `New field "${fieldName}" must have a friendlyName`;
            }
            if (fieldUpdate.required && !fieldUpdate.default) {
              return `New required field "${fieldName}" must have a default value`;
            }
          }
        }
      }
    }

    const templateFields = this.fieldify(input, existing.fields);
    const template = input.update.knowledgeTemplate || existing?.knowledgeTemplate;
    if (template) {
      const validation = validateTemplate(template, templateFields);
      if (validation !== true) {
        return validation;
      }
    }

    return '';
  },
  fieldify(input: TypeUpdate, fields: TypeField[]): TypeField[] {
    const newFields = fields.slice();
    // Handle field updates
    if (input.update.fields) {
      for (const { field: fieldName, change: fieldUpdate } of input.update.fields) {
        if (!fieldUpdate) {
          // Delete field
          const fieldIndex = newFields.findIndex((f) => f.name === fieldName);
          if (fieldIndex !== -1) {
            newFields.splice(fieldIndex, 1);
          }
        } else {
          // Update or add field
          const existingField = newFields.find((f) => f.name === fieldName);
          if (existingField) {
            // Update existing field
            deleteUndefined(fieldUpdate)
            Object.assign(existingField, fieldUpdate);
          } else {
            // Add new field (must provide full field definition)
            if (fieldUpdate.type && fieldUpdate.friendlyName !== undefined) {
              newFields.push({
                name: fieldName,
                friendlyName: fieldUpdate.friendlyName,
                type: fieldUpdate.type,
                required: fieldUpdate.required ?? false,
                default: fieldUpdate.default,
                enumOptions: fieldUpdate.enumOptions,
              });
            }
          }
        }
      }
    }
    return newFields;
  },
  async analyze(input, { config }) {
    const validation = this.validate(input, config);
    if (validation) {
      return {
        analysis: `This would fail - ${validation}`,
        doable: false,
      };
    }
    
    const changes: string[] = [];
    if (input.update.friendlyName) {
      changes.push(`friendlyName to "${input.update.friendlyName}"`);
    }
    if (input.update.description) {
      changes.push(`description to "${input.update.description}"`);
    }
    if (input.update.knowledgeTemplate) {
      changes.push(`knowledgeTemplate to "${input.update.knowledgeTemplate}"`);
    }
    if (input.update.fields) {
      changes.push(`field updates`);
    }

    return {
      analysis: `This will update type "${input.name}": ${changes.join(', ')}.`,
      doable: true,
    };
  },
  async do(input, { config }) {
    const validation = this.validate(input, config);
    if (validation) {
      throw new Error(`Type update failed - ${validation}`);
    }

    await config.saveWithTypeCheck((data) => {
      const dataType = data.types.find((t) => t.name === input.name);
      if (dataType) {
        if (input.update.friendlyName) {
          dataType.friendlyName = input.update.friendlyName;
        }
        if (input.update.description) {
          dataType.description = input.update.description;
        }
        if (input.update.knowledgeTemplate) {
          dataType.knowledgeTemplate = input.update.knowledgeTemplate;
        }

        // Handle field updates
        if (input.update.fields) {
          dataType.fields = this.fieldify(input, dataType.fields);
        }
      }
    });

    return { name: input.name, updated: true };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `${formatName(op.input.name)}Update(${Object.keys(op.input.update).join(', ')})`,
    (op) => op.output?.updated ? 'Updated type successfully' : null,
    showInput, showOutput
  ),
});

export const type_create = operationOf<
  TypeDefinition,
  { type: TypeDefinition; created: boolean },
  { validate: (input: TypeDefinition, config: ConfigFile) => string; }
>({
  mode: 'create',
  signature: 'type_create(type: TypeDefinition)',
  status: (input) => `Creating type: ${input.name}`,
  validate(input: TypeDefinition, config: ConfigFile): string {
    const existing = config.getData().types.find((t) => t.name === input.name);
    if (existing) {
      return `Type already exists: ${input.name}`;
    }

    // Validate fields for duplicates and required properties
    const fieldNames = new Set<string>();
    for (const field of input.fields) {
      if (fieldNames.has(field.name)) {
        return `Duplicate field name: "${field.name}"`;
      }
      fieldNames.add(field.name);

      if (!field.name) {
        return `Field must have a name`;
      }
      if (!field.friendlyName) {
        return `Field "${field.name}" must have a friendlyName`;
      }
      if (!field.type) {
        return `Field "${field.name}" must have a type`;
      }
      if (field.type === 'enum' && (!field.enumOptions || field.enumOptions.length === 0)) {
        return `Enum field "${field.name}" must have enumOptions`;
      }
    }

    // Validate knowledgeTemplate
    if (input.knowledgeTemplate) {
      const validation = validateTemplate(input.knowledgeTemplate, input.fields);
      if (validation !== true) {
        return validation;
      }
    }

    return '';
  },
  async analyze(input, { config }) {
    const validation = this.validate(input, config);
    
    if (validation) {
      return {
        analysis: `This would fail - ${validation}`,
        doable: false,
      };
    }

    return {
      analysis: `This will create a new data type: ${JSON.stringify(input, undefined, 2)}`,
      doable: true,
    };
  },
  async do(input, { config }) {
    const validation = this.validate(input, config);
    if (validation) {
      throw new Error(`Type creation failed - ${validation}`);
    }

    await config.addType(input);

    return { type: input, created: true };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `${formatName(op.input.name)}Create(fields: [${op.input.fields.map(f => f.friendlyName).join(', ')}])`,
    (op) => op.output?.created ? `Created type: ${op.output.type.friendlyName}` : null,
    showInput, showOutput
  ),
});

// Type import constants
const TYPE_IMPORT_CONSTS = {
  BATCH_SIZE: 128_000, // Characters to accumulate before processing
  MAX_QUEUE_SIZE: 1_000_000_000, // 1GB memory limit for queue
  SECTION_SIZE: 64_000, // Size to split files into sections
};

// Discovered type during import
export interface DiscoveredType {
  name: string;
  friendlyName: string;
  description?: string;
  fields: TypeField[];
  instanceCount: number;
}

export const type_delete = operationOf<
  { name: string },
  { name: string; deleted: boolean }
>({
  mode: 'delete',
  signature: 'type_delete(name: string)',
  status: (input) => `Deleting type: ${input.name}`,
  analyze: async (input, { config }) => {
    const types = config.getData().types;
    const type = types.find((t) => t.name === input.name);
    
    if (!type) {
      return {
        analysis: `This would fail - type not found: ${input.name}`,
        doable: false,
      };
    }

    // Check if any other types reference this type
    const referencingTypes = types.filter(t => 
      t.fields.some(f => f.type === input.name)
    );

    if (referencingTypes.length > 0) {
      const typeList = referencingTypes.map(t => t.friendlyName).join(', ');
      return {
        analysis: `This would fail - type "${type.friendlyName}" is referenced by: ${typeList}. Delete these references first.`,
        doable: false,
      };
    }

    return {
      analysis: `This will delete type "${type.friendlyName}".`,
      doable: true,
    };
  },
  do: async (input, { config }) => {
    const types = config.getData().types;
    const type = types.find((t) => t.name === input.name);
    
    if (!type) {
      throw new Error(`Type not found: ${input.name}`);
    }

    // Check if any other types reference this type
    const referencingTypes = types.filter(t => 
      t.fields.some(f => f.type === input.name)
    );

    if (referencingTypes.length > 0) {
      const typeList = referencingTypes.map(t => t.friendlyName).join(', ');
      throw new Error(`Cannot delete type "${type.friendlyName}" - it is referenced by: ${typeList}`);
    }

    await config.saveWithTypeCheck((data) => {
      const index = data.types.findIndex((t) => t.name === input.name);
      if (index !== -1) {
        data.types.splice(index, 1);
      }
    });

    return { name: input.name, deleted: true };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `${formatName(op.input.name)}Delete()`,
    (op) => op.output?.deleted ? `Deleted type: ${op.input.name}` : null,
    showInput, showOutput
  ),
});

export const type_import = operationOf<
  { glob: string; hints?: string[]; max?: number },
  { discovered: DiscoveredType[]; existingTypeUpdates: Map<string, TypeField[]>; filesProcessed: number }
>({
  mode: 'read',
  signature: 'type_import(glob: string, hints?, max?)',
  status: ({ glob }) => `Importing types from ${glob}`,
  analyze: async ({ glob, hints, max }, { config, cwd }) => {
    const files = await searchFiles(cwd, glob);
    const importable = files.filter(f => f.fileType !== 'unknown' && f.fileType !== 'unreadable' && f.fileType !== 'image');
    
    let analysis = `This will scan ${importable.length} file(s) matching "${glob}" to discover type definitions.`;
    
    if (hints && hints.length > 0) {
      analysis += ` Will focus on types matching: ${hints.join(', ')}.`;
    }
    if (max) {
      analysis += ` Will discover up to ${max} types.`;
    }
    
    analysis += ` Results will be presented for review - no types will be automatically added.`;
    
    return {
      analysis,
      doable: importable.length > 0,
    };
  },
  do: async ({ glob, hints, max }, ctx) => {
    const { ai, config, cwd, log, chatStatus } = ctx;
    
    // Find and filter files
    const files = await searchFiles(cwd, glob);
    const importableFiles = files.filter(f => 
      f.fileType !== 'unknown' && f.fileType !== 'unreadable' && f.fileType !== 'image'
    );
    
    log(`type_import: found ${files.length} files, ${importableFiles.length} importable`);
    chatStatus(`Found ${importableFiles.length} files to process`);
    
    // Get existing types
    const existingTypes = config.getData().types;
    const existingTypeNames = existingTypes.map(t => t.name);
    
    // Initialize discovered types storage and track existing type updates
    const discoveredTypes = new Map<string, DiscoveredType>();
    const existingTypeUpdates = new Map<string, TypeField[]>();
    
    // Initialize existing type updates map with existing fields
    for (const existingType of existingTypes) {
      existingTypeUpdates.set(existingType.name, [...existingType.fields]);
    }
    
    // Helper functions for dynamic schema generation
    const getDiscoveredTypeEnum = () => {
      const discoveredNames = Array.from(discoveredTypes.keys());
      return discoveredNames.length ? z.enum(discoveredNames as [string, ...string[]]) : z.never();
    };

    // Get all type names (existing + discovered)
    const getAllTypeNames = () => {
      const discoveredNames = Array.from(discoveredTypes.keys());
      return [...existingTypeNames, ...discoveredNames];
    };
    
    // Dynamic enum of all type names
    const getAllTypeEnum = () => {
      const allNames = getAllTypeNames();
      return allNames.length ? z.enum(allNames as [string, ...string[]]) : z.never();
    };
    
    // Define reusable field schema factory (dynamic to include discovered types)
    const createFieldSchema = () => z.object({
      name: z.string().describe('Field name (lowercase, no spaces)'),
      friendlyName: z.string().describe('Field display name'),
      type: z.enum(['string', 'number', 'boolean', 'date', 'enum', ...getAllTypeNames()] as [string, ...string[]]).describe('Field type'),
      required: z.boolean().optional().describe('Is field required?'),
      enumOptions: z.array(z.string()).optional().describe('Valid enum values (required for enum type)'),
      onDelete: z.enum(['restrict', 'cascade', 'setNull']).optional().describe('Cascade delete behavior for reference fields'),
    });
    
    // Create the prompt with dynamic schemas
    const extractor = ai.prompt({
      name: 'type_extractor',
      description: 'Extract and manage type definitions from text',
      content: `You are an expert data modeling assistant. Your task is to extract structured type definitions from the provided text.

<existingTypes>
{{#if existingTypes.length}}
Existing types already defined:
{{#each existingTypes}}
- {{this.name}}: {{this.friendlyName}}{{#if this.description}} - {{this.description}}{{/if}}
  Fields: {{#each this.fields}}{{this.name}} ({{this.type}}){{#unless @last}}, {{/unless}}{{/each}}
{{/each}}
{{else}}
No existing types defined yet.
{{/if}}
</existingTypes>

<discoveredTypes>
{{#if discoveredTypes.length}}
Types discovered so far in this import:
{{#each discoveredTypes}}
- {{this.name}}: {{this.friendlyName}}{{#if this.description}} - {{this.description}}{{/if}}
  Fields: {{#each this.fields}}{{this.name}} ({{this.type}}){{#unless @last}}, {{/unless}}{{/each}}
  Instance count: {{this.instanceCount}}
{{/each}}
{{else}}
No types discovered yet in this import.
{{/if}}
</discoveredTypes>

<constraints>
{{#if hints}}
Focus on discovering types that match these hints: {{hints}}
{{/if}}
{{#if maxTypes}}
Maximum types to discover: {{maxTypes}}
{{#if discoveredTypes.length}}
Already discovered: {{discoveredTypes.length}}
Remaining slots: {{remainingSlots}}
{{/if}}
{{/if}}
</constraints>

<instructions>
Analyze the text below and extract type definitions. Use the provided tools to manage discovered types:
- add_discovered: Add a new discovered type with fields
- rename_discovered: Rename a discovered type
- update_fields: Add, update, or remove fields on an existing or discovered type
- update_discovered: Update properties of a discovered type
- add_instances: Track instance count for a type
- remove_discovered: Remove a discovered type (e.g., if it's too infrequent)

When managing types:
- Use estimated instance counts to prioritize important types
- If max types is specified and reached, remove less frequent types to make room for more important ones
- Merge similar types using update_fields and remove_discovered
- Field names must be lowercase with no spaces
- For existing types, only new fields can be added via update_fields
</instructions>

<text>
{{text}}
</text>`,
      tools: [
        ai.tool({
          name: 'add_discovered',
          description: 'Add a new discovered type definition. Only available if max types limit has not been reached.',
          instructions: 'Create a new discovered type with the specified name, friendly name, description, fields, and optional instance count.',
          schema: () => z.object({
            name: z.string().describe('Type name (lowercase, no spaces)'),
            friendlyName: z.string().describe('Display name'),
            description: z.string().optional().describe('Type description'),
            fields: z.array(createFieldSchema()).describe('Field definitions'),
            instanceCount: z.number().optional().describe('Estimated number of instances found'),
          }),
          applicable: () => !max || discoveredTypes.size < max,
          call: async (input) => {
            // Check if max limit would be exceeded
            if (max && discoveredTypes.size >= max) {
              return { 
                success: false, 
                message: `Cannot add type "${input.name}": maximum of ${max} types reached. Remove a less frequent type first or increase the max limit.` 
              };
            }
            
            const existing = discoveredTypes.get(input.name);
            if (existing) {
              return { success: false, message: `Type "${input.name}" already discovered. Use update_discovered or update_fields instead.` };
            }
            
            // Check if name conflicts with existing types
            if (existingTypeNames.includes(input.name)) {
              return { success: false, message: `Type "${input.name}" already exists as an existing type. Choose a different name.` };
            }
            
            discoveredTypes.set(input.name, {
              name: input.name,
              friendlyName: input.friendlyName,
              description: input.description,
              fields: input.fields as TypeField[],
              instanceCount: input.instanceCount || 1,
            });
            
            return { success: true, message: `Added discovered type: ${input.friendlyName}` };
          },
        }),
        ai.tool({
          name: 'rename_discovered',
          description: 'Rename a discovered type',
          instructions: 'Change the name of an existing discovered type. This is useful for resolving naming conflicts or improving clarity.',
          schema: () => z.object({
            oldName: getDiscoveredTypeEnum().describe('Current type name'),
            newName: z.string().describe('New type name (lowercase, no spaces)'),
          }),
          applicable: () => discoveredTypes.size > 0,
          call: async (input) => {
            const type = discoveredTypes.get(input.oldName);
            if (!type) {
              return { success: false, message: `Type "${input.oldName}" not found in discovered types.` };
            }
            
            // Check if newName already exists
            if (existingTypeNames.includes(input.newName) || discoveredTypes.has(input.newName)) {
              return { success: false, message: `Type name "${input.newName}" already exists. Choose a different name.` };
            }
            
            discoveredTypes.delete(input.oldName);
            type.name = input.newName;
            discoveredTypes.set(input.newName, type);
            
            return { success: true, message: `Renamed type from ${input.oldName} to ${input.newName}` };
          },
        }),
        ai.tool({
          name: 'update_fields',
          description: 'Add, update, or remove fields on an existing or discovered type. For existing types, only new fields can be added.',
          instructions: `Modify the fields of a specified type. For discovered types, you can add new fields, update existing fields, or remove fields. For existing types, you can only add new fields; updating or removing existing fields is not allowed.`,
          schema: () => z.object({
            typeName: getAllTypeEnum().describe('Type name'),
            fields: z.array(
              z.union([
                createFieldSchema(),
                z.object({
                  name: z.string().describe('Field name to remove'),
                  remove: z.literal(true).describe('Set to true to remove this field'),
                })
              ])
            ).describe('Fields to add/update/remove. To remove, use {name: "fieldname", remove: true}'),
          }),
          applicable: () => discoveredTypes.size > 0 || existingTypeNames.length > 0,
          call: async (input) => {
            // Check if it's a discovered type
            const discoveredType = discoveredTypes.get(input.typeName);
            const isExistingType = existingTypeNames.includes(input.typeName);
            
            if (!discoveredType && !isExistingType) {
              return { success: false, message: `Type "${input.typeName}" not found. Use add_discovered first for new types.` };
            }
            
            // Get the fields list to modify
            let targetFields: TypeField[];
            if (discoveredType) {
              targetFields = discoveredType.fields;
            } else {
              // For existing types, work with the update tracking map
              targetFields = existingTypeUpdates.get(input.typeName)!;
            }
            
            // Track added fields for existing types
            const addedFieldsInImport = discoveredType ? [] : targetFields.filter(f => 
              !existingTypes.find(t => t.name === input.typeName)?.fields.find(ef => ef.name === f.name)
            ).map(f => f.name);
            
            // Validate all operations before making any changes
            const errors: string[] = [];
            for (const field of input.fields) {
              if ('remove' in field && field.remove) {
                // Validate removal
                const fieldIndex = targetFields.findIndex(f => f.name === field.name);
                if (fieldIndex === -1) {
                  errors.push(`Field "${field.name}" does not exist on type "${input.typeName}"`);
                } else if (isExistingType && !discoveredType && !addedFieldsInImport.includes(field.name)) {
                  errors.push(`Cannot remove original field "${field.name}" from existing type "${input.typeName}"`);
                }
              } else {
                // Validate add/update
                const typedField = field as TypeField;
                const existingFieldIndex = targetFields.findIndex(f => f.name === typedField.name);
                
                if (existingFieldIndex !== -1) {
                  // Validate update (only for discovered types)
                  if (!discoveredType) {
                    errors.push(`Cannot update existing field "${typedField.name}" on existing type "${input.typeName}"`);
                  }
                }
              }
            }
            
            if (errors.length > 0) {
              return { success: false, message: `Validation errors: ${errors.join('; ')}` };
            }
            
            // Now perform the actual changes
            let addedCount = 0;
            let updatedCount = 0;
            let removedCount = 0;
            
            for (const field of input.fields) {
              if ('remove' in field && field.remove) {
                // Remove field
                const fieldIndex = targetFields.findIndex(f => f.name === field.name);
                if (fieldIndex !== -1) {
                  targetFields.splice(fieldIndex, 1);
                  removedCount++;
                }
              } else {
                // Add or update field
                const typedField = field as TypeField;
                const existingFieldIndex = targetFields.findIndex(f => f.name === typedField.name);
                
                if (existingFieldIndex !== -1) {
                  // Update existing field (only for discovered types)
                  if (discoveredType) {
                    targetFields[existingFieldIndex] = typedField;
                    updatedCount++;
                  }
                } else {
                  // Add new field
                  targetFields.push(typedField);
                  addedCount++;
                }
              }
            }
            
            return { 
              success: true, 
              message: `Modified ${input.typeName}: ${addedCount} added, ${updatedCount} updated, ${removedCount} removed` 
            };
          },
        }),
        ai.tool({
          name: 'update_discovered',
          description: 'Update properties of a discovered type',
          instructions: 'Update the friendly name or description of a discovered type.',
          schema: () => z.object({
            name: getDiscoveredTypeEnum().describe('Type name'),
            friendlyName: z.string().optional().describe('New friendly name'),
            description: z.string().optional().describe('New description'),
          }),
          applicable: () => discoveredTypes.size > 0,
          call: async (input) => {
            const type = discoveredTypes.get(input.name);
            if (!type) {
              return { success: false, message: `Type "${input.name}" not found in discovered types.` };
            }
            
            if (input.friendlyName) type.friendlyName = input.friendlyName;
            if (input.description) type.description = input.description;
            
            return { success: true, message: `Updated type: ${input.name}` };
          },
        }),
        ai.tool({
          name: 'add_instances',
          description: 'Track instance count for a type',
          instructions: 'Increment the instance count for the specified type by the given count. This is necessary for prioritizing important types during import.',
          schema: () => z.object({
            typeName: getDiscoveredTypeEnum().describe('Type name'),
            count: z.number().describe('Number of instances to add'),
          }),
          applicable: () => discoveredTypes.size > 0,
          call: async (input) => {
            const type = discoveredTypes.get(input.typeName);
            if (!type) {
              return { success: false, message: `Type "${input.typeName}" not found in discovered types.` };
            }
            
            type.instanceCount += input.count;
            
            return { success: true, message: `Added ${input.count} instances to ${input.typeName}, total: ${type.instanceCount}` };
          },
        }),
        ai.tool({
          name: 'remove_discovered',
          description: 'Remove a discovered type',
          instructions: 'Remove the specified discovered type, for example if it is too infrequent or not useful.',
          schema: () => z.object({
            name: getDiscoveredTypeEnum().describe('Type name to remove'),
            reason: z.string().optional().describe('Reason for removal'),
          }),
          applicable: () => discoveredTypes.size > 0,
          call: async (input) => {
            discoveredTypes.delete(input.name);
            return { success: true, message: `Removed type: ${input.name}${input.reason ? ` (${input.reason})` : ''}` };
          },
        }),
      ],
      input: ({ text }: { text: string }) => ({
        text,
        existingTypes,
        discoveredTypes: Array.from(discoveredTypes.values()),
        hints: hints?.join(', '),
        maxTypes: max,
        remainingSlots: max ? Math.max(0, max - discoveredTypes.size) : undefined,
      }),
      metadataFn: () => ({
        model: config.getData().user.models?.chat,
      }),
      excludeMessages: true,
      dynamic: true,
      toolExecution: 'parallel',
      toolsOnly: true,
    });
    
    // Pipeline architecture with two concurrent promises
    // Queue for parsed file data
    interface QueuedData {
      file: string;
      sections: string[];
    }
    
    const dataQueue: QueuedData[] = [];
    let queuedSize = 0;
    const maxQueueSize = TYPE_IMPORT_CONSTS.MAX_QUEUE_SIZE;
    let parsingComplete = false;
    let parsingError = null as Error | null;
    
    // Promise resolvers for flow control
    let queueHasSpace = null as (() => void) | null;
    let queueHasData = null as (() => void) | null;
    
    // Parser promise - reads files and queues data
    const parserPromise = (async () => {
      try {
        for (const file of importableFiles) {
          const fullPath = path.resolve(cwd, file.file);
          
          try {
            // Wait if queue is full
            while (queuedSize >= maxQueueSize) {
              await new Promise<void>(resolve => {
                queueHasSpace = resolve;
              });
            }
            
            // Read and process file
            const parsed = await processFile(fullPath, file.file, {
              assetPath: await getAssetPath(true),
              sections: true,
              transcribeImages: false,
              describeImages: false,
              extractImages: false,
              summarize: false,
            });
            
            // Store sections for smarter splitting
            const fileData = {
              file: fullPath, // Use fullPath instead of file.file
              sections: parsed.sections,
            };
            
            // Calculate total size of sections
            const sectionsSize = parsed.sections.reduce((sum, s) => sum + s.length, 0);
            
            // Add to queue
            dataQueue.push(fileData);
            queuedSize += sectionsSize;
            
            // Notify processor that data is available
            if (queueHasData) {
              const resolver = queueHasData;
              queueHasData = null;
              resolver();
            }
            
          } catch (error) {
            log(`Warning: Failed to process file ${file.file}: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        parsingError = error as Error;
      } finally {
        parsingComplete = true;
        // Wake up processor if it's waiting
        if (queueHasData) {
          const resolver = queueHasData!;
          queueHasData = null;
          resolver();
        }
      }
    })();
    
    // Processor promise - consumes queue and calls AI
    const processorPromise = (async () => {
      let filesProcessed = 0;
      let currentBatch = '';
      let currentBatchFiles: string[] = [];
      
      while (true) {
        // Wait for data if queue is empty and parsing is ongoing
        while (dataQueue.length === 0 && !parsingComplete) {
          await new Promise<void>(resolve => {
            queueHasData = resolve;
          });
        }
        
        // Exit if queue is empty and parsing is done
        if (dataQueue.length === 0 && parsingComplete) {
          break;
        }
        
        // Process available data
        while (dataQueue.length > 0) {
          const fileData = dataQueue.shift()!;
          const sectionsSize = fileData.sections.reduce((sum, s) => sum + s.length, 0);
          queuedSize -= sectionsSize;
          
          // Notify parser that space is available
          if (queueHasSpace && queuedSize < maxQueueSize) {
            const resolver = queueHasSpace;
            queueHasSpace = null;
            resolver();
          }
          
          // Process sections smartly - add sections one by one, batching when needed
          let isFirstSectionOfFile = true;
          for (const section of fileData.sections) {
            // Only add file header for the first section of this file in the batch
            const needsHeader = isFirstSectionOfFile || !currentBatchFiles.includes(fileData.file);
            const sectionContent = needsHeader 
              ? `\n\n=== File: ${fileData.file} ===\n${section}`
              : `\n\n${section}`;
            
            // Check if adding this section would exceed batch size
            if (currentBatch.length > 0 && currentBatch.length + sectionContent.length > TYPE_IMPORT_CONSTS.BATCH_SIZE) {
              // Process current batch
              chatStatus(`Processing batch (${currentBatchFiles.length} files, ${currentBatch.length} chars)...`);
              
              try {
                await extractor.get('result', { text: currentBatch }, ctx);
              } catch (error) {
                log(`Warning: Failed to process batch: ${(error as Error).message}`);
              }
              
              // Start new batch with this section (needs header since it's a new batch)
              currentBatch = `\n\n=== File: ${fileData.file} ===\n${section}`;
              currentBatchFiles = [fileData.file];
              isFirstSectionOfFile = false;
            } else {
              currentBatch += sectionContent;
              if (!currentBatchFiles.includes(fileData.file)) {
                currentBatchFiles.push(fileData.file);
              }
              isFirstSectionOfFile = false;
            }
          }
          
          filesProcessed++;
          chatStatus(`Processed ${filesProcessed}/${importableFiles.length} files`);
        }
      }
      
      // Process final batch if any content remains
      if (currentBatch.length > 0) {
        chatStatus(`Processing final batch (${currentBatchFiles.length} files, ${currentBatch.length} chars)...`);
        
        try {
          await extractor.get('result', { text: currentBatch }, ctx);
        } catch (error) {
          log(`Warning: Failed to process final batch: ${(error as Error).message}`);
        }
      }
    })();
    
    // Wait for both promises to complete
    await Promise.all([parserPromise, processorPromise]);
    
    // Check for parsing errors
    if (parsingError) {
      log(`Warning: Parser encountered error: ${parsingError.message}`);
    }
    
    // Convert discovered types to array and sort by instance count
    const discovered = Array.from(discoveredTypes.values())
      .sort((a, b) => b.instanceCount - a.instanceCount);
    
    // Filter existing type updates to only include those with changes
    const filteredExistingTypeUpdates = new Map<string, TypeField[]>();
    for (const [typeName, updatedFields] of existingTypeUpdates.entries()) {
      const originalType = existingTypes.find(t => t.name === typeName);
      if (originalType) {
        // Check if fields are different
        const hasChanges = updatedFields.length !== originalType.fields.length ||
          updatedFields.some(uf => !originalType.fields.find(of => 
            of.name === uf.name && 
            of.type === uf.type && 
            of.friendlyName === uf.friendlyName &&
            of.required === uf.required
          ));
        
        if (hasChanges) {
          filteredExistingTypeUpdates.set(typeName, updatedFields);
        }
      }
    }
    
    log(`type_import: discovered ${discovered.length} types, ${filteredExistingTypeUpdates.size} existing type updates from ${importableFiles.length} files`);
    
    return {
      discovered,
      existingTypeUpdates: filteredExistingTypeUpdates,
      filesProcessed: importableFiles.length,
    };
  },
  render: (op, ai, showInput, showOutput) => renderOperation(
    op,
    `TypeImport("${op.input.glob}"${op.input.hints ? `, hints=[${op.input.hints.join(',')}]` : ''}${op.input.max ? `, max=${op.input.max}` : ''})`,
    (op) => {
      if (op.output) {
        const discoveredCount = op.output.discovered.length;
        const updatesCount = op.output.existingTypeUpdates.size;
        const parts = [];
        
        if (discoveredCount > 0) {
          parts.push(`${pluralize(discoveredCount, 'new type')}`);
        }
        if (updatesCount > 0) {
          parts.push(`${pluralize(updatesCount, 'type updaye')}`);
        }
        
        return parts.length > 0 
          ? `Discovered ${parts.join(', ')} from ${op.output.filesProcessed} file(s)`
          : `No types discovered from ${op.output.filesProcessed} file(s)`;
      }
      return null;
    },
    showInput, showOutput
  ),
});
