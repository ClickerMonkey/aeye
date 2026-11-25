import { a, type AnySchema, type SchemaOf } from "@aeye/schema";
import { TypeDefinition, TypeField } from "../schemas";
import { FieldCondition, WhereClause } from "./data";
import { ConfigFile } from "../config";
import { typesKey } from "./dba";

/**
 * Get a type definition by name from config
 */
export function getType(config: ConfigFile, typeName: string, optional?: false): TypeDefinition
export function getType(config: ConfigFile, typeName: string, optional: true): TypeDefinition | undefined
export function getType(config: ConfigFile, typeName: string, optional: boolean = false): TypeDefinition | undefined {
  const type = config.getData().types.find((t) => t.name === typeName);
  if (!type && !optional) {
    throw new Error(`Data type not found: ${typeName}`);
  }
  return type;
}

/**
 * Get the friendly name of a type, or return the type name if not found
 */
export function getTypeName(config: ConfigFile, typeName: string): string {
  return getType(config, typeName, true)?.friendlyName || typeName;
}

/**
 * A record's field values as decoded for a type (see buildFieldsSchema).
 */
export type FieldValues = { [field: string]: string | number | boolean | null };

/**
 * An enum of the type names (a string when there are none: the tools using
 * it are then not applicable).
 */
export function typeNameSchema(types: ReadonlyArray<TypeDefinition>) {
  const names = types.map((t) => t.name);
  return names.length ? a.enum(names as [string, ...string[]]) : a.string();
}

/**
 * What a tool schema built from the configured types reads from the context.
 */
export type TypesContext = { config: ConfigFile };

/**
 * `TypeName`: an enum of the configured type names, bound per call from the
 * config (cached by the types' content).
 */
export const TypeNameModule = a.declare<{ TypeName: string }>().dynamic(
  (ctx: TypesContext) => ({ TypeName: typeNameSchema(ctx.config.getData().types) }),
  { key: (ctx) => typesKey(ctx.config.getData().types) },
);

/**
 * Build a schema from a TypeField definition
 */
export function buildFieldSchema(field: TypeField): AnySchema {
  let schema: AnySchema;

  switch (field.type) {
    case 'string':
      schema = a.string();
      break;
    case 'number':
      schema = a.number();
      break;
    case 'boolean':
      schema = a.boolean();
      break;
    case 'enum':
      schema = a.enum(field.enumOptions as [string, ...string[]]);
      break;
    case 'date':
      schema = a.string().format('date');
      break;
    default:
      // A reference to another type: its id
      schema = a.string();
      break;
  }

  if (!field.required) {
    schema = a.nullable(schema);
  }

  if (field.default !== undefined) {
    schema = a.default(schema, field.default as never);
  }

  return schema;
}

/**
 * Build an object schema for a type's fields
 */
export function buildFieldsSchema(type: TypeDefinition): SchemaOf<FieldValues> {
  const shape: Record<string, AnySchema> = {};
  for (const field of type.fields) {
    shape[field.name] = buildFieldSchema(field);
  }
  return a.object(shape) as unknown as SchemaOf<FieldValues>;
}
