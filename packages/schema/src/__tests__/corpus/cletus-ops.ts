/**
 * CORPUS: the schemas cletus operations give models inside an operation
 * (packages/cletus/src/operations/*.tsx and helpers/type.ts):
 *
 * - architect.tsx `type_extractor` prompt's six tools, whose enums are the
 *   types discovered SO FAR in the import (closure state, mutated by the
 *   tools themselves between calls) — `z.never()` when there are none;
 * - dba.tsx `extractor` prompt: `{ results: buildFieldsSchema(typeDef)[] }`,
 *   an object built from a user type definition (helpers/type.ts);
 * - dba.tsx `query_type_selector` prompt: an array of the type names;
 * - dba.tsx:1123 the unique-fields `responseFormat` (strict structured output).
 */
import { expectTypeOf } from 'expect-type';
import { a, type AnySchema, type SchemaOf } from '../../index';
import { prompt, tool, type Context } from '../../proposal/core-api';
import type { TypeDefinition, TypeField } from './cletus-tools';

// ============================================================================
// architect.tsx:584-924 — the type_extractor's tools
// ============================================================================

/**
 * The import's state, which the closures read: existing type names (fixed)
 * and discovered ones (added/renamed/removed by the tools). Passed as ctx so
 * the dynamic step can be keyed by its version.
 */
export interface ImportState {
  existing: string[];
  discovered: Map<string, { name: string; friendlyName: string; description?: string; fields: TypeField[]; instanceCount: number }>;
  version: number;
  max?: number;
}
export type ImportCtx = Context<{ importState: ImportState }>;

const nonEmpty = (xs: string[]) => (xs.length ? xs : ['(none)']) as [string, ...string[]];
const byVersion = { key: (ctx: ImportCtx) => ctx.importState.version };

/**
 * architect.tsx:584 `getDiscoveredTypeEnum()` (z.never() when empty — the
 * tools using it are then not applicable), :595 `getAllTypeEnum()`, and :602
 * `createFieldSchema()`'s type enum (primitives + all names).
 */
const ImportNames = a.declare<{ Discovered: string; AnyType: string; FieldType: string }>()
  .dynamic((ctx: ImportCtx) => {
    const discovered = [...ctx.importState.discovered.keys()];
    const all = [...ctx.importState.existing, ...discovered];
    return {
      Discovered: a.enum(nonEmpty(discovered)),
      AnyType: a.enum(nonEmpty(all)),
      FieldType: a.enum(['string', 'number', 'boolean', 'date', 'enum', ...all]).describe('Field type'),
    };
  }, byVersion);

/** architect.tsx:602 createFieldSchema() */
const FieldDef = a.object({
  name: a.string().describe('Field name (lowercase, no spaces)'),
  friendlyName: a.string().describe('Field display name'),
  type: a.ref('FieldType'),
  required: a.boolean().optional().describe('Is field required?'),
  enumOptions: a.array(a.string()).optional().describe('Valid enum values (required for enum type)'),
  onDelete: a.enum(['restrict', 'cascade', 'setNull']).optional().describe('Cascade delete behavior for reference fields'),
});
export type FieldDefT = {
  name: string; friendlyName: string; type: string; required?: boolean; enumOptions?: string[];
  onDelete?: 'restrict' | 'cascade' | 'setNull';
};

// architect.tsx:680
export const AddDiscoveredArgs = ImportNames.result(a.object({
  name: a.string().describe('Type name (lowercase, no spaces)'),
  friendlyName: a.string().describe('Display name'),
  description: a.string().optional().describe('Type description'),
  fields: a.array(FieldDef).describe('Field definitions'),
  instanceCount: a.number().optional().describe('Estimated number of instances found'),
}));
expectTypeOf<a.infer<typeof AddDiscoveredArgs>>().toEqualTypeOf<{ name: string; friendlyName: string; description?: string; fields: FieldDefT[]; instanceCount?: number }>();
export const addDiscovered = tool({
  name: 'add_discovered',
  description: 'Add a new discovered type definition. Only available if max types limit has not been reached.',
  schema: AddDiscoveredArgs,
  applicable: (ctx: ImportCtx) => !ctx.importState.max || ctx.importState.discovered.size < ctx.importState.max,
  call: (input) => input.fields.length,
});

// architect.tsx:734
export const RenameDiscoveredArgs = ImportNames.result(a.object({
  oldName: a.ref('Discovered').describe('Current type name'),
  newName: a.string().describe('New type name (lowercase, no spaces)'),
}));
expectTypeOf<a.infer<typeof RenameDiscoveredArgs>>().toEqualTypeOf<{ oldName: string; newName: string }>();
const anyDiscovered = (ctx: ImportCtx) => ctx.importState.discovered.size > 0;
export const renameDiscovered = tool({ name: 'rename_discovered', description: 'Rename a discovered type', schema: RenameDiscoveredArgs, applicable: anyDiscovered, call: (i) => i.newName });

// architect.tsx:766 — a field to add/update, or `{ name, remove: true }`.
export const UpdateFieldsArgs = ImportNames.result(a.object({
  typeName: a.ref('AnyType').describe('Type name'),
  fields: a.array(a.union([
    FieldDef,
    a.object({
      name: a.string().describe('Field name to remove'),
      remove: a.literal(true).describe('Set to true to remove this field'),
    }),
  ])).describe('Fields to add/update/remove. To remove, use {name: "fieldname", remove: true}'),
}));
expectTypeOf<a.infer<typeof UpdateFieldsArgs>>().toEqualTypeOf<{ typeName: string; fields: (FieldDefT | { name: string; remove: true })[] }>();
export const updateFields = tool({
  name: 'update_fields',
  description: 'Add, update, or remove fields on an existing or discovered type. For existing types, only new fields can be added.',
  schema: UpdateFieldsArgs,
  applicable: (ctx: ImportCtx) => ctx.importState.discovered.size > 0 || ctx.importState.existing.length > 0,
  // architect.tsx:812: the code tells the members apart with `'remove' in field`.
  call: (input) => input.fields.filter((f) => 'remove' in f).length,
});

// architect.tsx:878
export const UpdateDiscoveredArgs = ImportNames.result(a.object({
  name: a.ref('Discovered').describe('Type name'),
  friendlyName: a.string().optional().describe('New friendly name'),
  description: a.string().optional().describe('New description'),
}));
// architect.tsx:900
export const AddInstancesArgs = ImportNames.result(a.object({
  typeName: a.ref('Discovered').describe('Type name'),
  count: a.number().describe('Number of instances to add'),
}));
// architect.tsx:920
export const RemoveDiscoveredArgs = ImportNames.result(a.object({
  name: a.ref('Discovered').describe('Type name to remove'),
  reason: a.string().optional().describe('Reason for removal'),
}));
expectTypeOf<a.infer<typeof UpdateDiscoveredArgs>>().toEqualTypeOf<{ name: string; friendlyName?: string; description?: string }>();
expectTypeOf<a.infer<typeof AddInstancesArgs>>().toEqualTypeOf<{ typeName: string; count: number }>();
expectTypeOf<a.infer<typeof RemoveDiscoveredArgs>>().toEqualTypeOf<{ name: string; reason?: string }>();
expectTypeOf(RemoveDiscoveredArgs.bind).parameters.toEqualTypeOf<[ImportCtx]>();
export const removeDiscovered = tool({ name: 'remove_discovered', description: 'Remove a discovered type', schema: RemoveDiscoveredArgs, applicable: anyDiscovered, call: (i) => i.name });

// ============================================================================
// helpers/type.ts — a schema built from a user's type definition
// ============================================================================

/** A record's field values as decoded (string | number | boolean | date string, null when not required). */
export type FieldValue = string | number | boolean | null;
export type Fields = { [field: string]: FieldValue };

/**
 * helpers/type.ts:29 buildFieldSchema(field), with `.default(field.default)`
 * (helpers/type.ts:58); `.meta({ aid: field.name })` names nothing a model sees here.
 */
export function buildFieldSchema(field: TypeField): AnySchema {
  let s: AnySchema;
  switch (field.type) {
    case 'string': s = a.string(); break;
    case 'number': s = a.number(); break;
    case 'boolean': s = a.boolean(); break;
    case 'enum': s = a.enum(field.enumOptions as [string, ...string[]]); break;
    case 'date': s = a.string().format('date'); break; // z.iso.date()
    default: s = a.string(); break; // a reference to another type: its id
  }
  const out: AnySchema = field.required ? s : a.nullable(s);
  return field.default !== undefined ? a.default(out, field.default as never) : out;
}
/** helpers/type.ts:67 buildFieldsSchema(type) — `aid: ${type.name}_fields`. */
export function buildFieldsSchema(type: TypeDefinition): SchemaOf<Fields> {
  return a.object(Object.fromEntries(type.fields.map((f) => [f.name, buildFieldSchema(f)]))) as unknown as SchemaOf<Fields>;
}

/** dba.tsx:141 `extractor`: input carries the typeDef; output `{ results: Fields[] }`. */
export type ExtractorInput = { typeDef: TypeDefinition; text: string };
export const ExtractorOutput = a.declare<{ Fields: Fields }>()
  .dynamic((_ctx: Context<{}>, input: ExtractorInput) => ({ Fields: buildFieldsSchema(input.typeDef) }), { key: (_ctx, input) => input.typeDef })
  .result(a.object({ results: a.array(a.ref('Fields')) }));
expectTypeOf<a.infer<typeof ExtractorOutput>>().toEqualTypeOf<{ results: Fields[] }>();
export const extractor = prompt({
  name: 'extractor',
  content: 'You are an expert data extraction assistant. ... {{typeDef.friendlyName}} ... {{text}}',
  schema: ExtractorOutput,
});
expectTypeOf(extractor.schema!.bind).parameters.toEqualTypeOf<[Context<{}>, ExtractorInput]>();

// ============================================================================
// dba.tsx:682 query_type_selector and dba.tsx:1123 unique fields
// ============================================================================

export const TypeSelectorOutput = a.declare<{ TypeName: string }>()
  .dynamic((_ctx: Context<{}>, input: { types: TypeDefinition[] }) => ({ TypeName: a.enum(nonEmpty(input.types.map((t) => t.name))) }), { key: (_c, i) => i.types })
  .result(a.object({ types: a.array(a.ref('TypeName')).describe('Array of type names needed for the query') }));
expectTypeOf<a.infer<typeof TypeSelectorOutput>>().toEqualTypeOf<{ types: string[] }>();

/** dba.tsx:1123 `responseFormat: { type: z.object({ fields: z.array(z.string()) }), strict: true }` */
export const UniqueFieldsOutput = a.object({ fields: a.array(a.string()) });
expectTypeOf<a.infer<typeof UniqueFieldsOutput>>().toEqualTypeOf<{ fields: string[] }>();
