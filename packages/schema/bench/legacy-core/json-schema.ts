import type { DescriptorFamily } from './descriptor';

/**
 * Format specification for JSON Schema generation
 */
/**
 * Family name for `ToJSONSchemaOptions.format`. Alias of `DescriptorFamily`
 * — the three built-in dialects (`'openai'`, `'anthropic'`, `'google'`)
 * plus any string registered via `registerDescriptor`.
 *
 * @deprecated Prefer `DescriptorFamily`. Both refer to the same widened type.
 */
export type JSONSchemaFormat = DescriptorFamily;

/**
 * Options for toJSONSchema
 */
export interface ToJSONSchemaOptions {
  /**
   * Whether to use strict mode (all fields required, additionalProperties: false)
   */
  strict: boolean;
  /**
   * The target format for the JSON Schema. Resolves to a named FormatDescriptor.
   * Built-in (`'openai'` / `'anthropic'` / `'google'`) or any string
   * registered via `registerDescriptor`.
   */
  format?: DescriptorFamily;
}

export type JSONSchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'integer';

/**
 * JSON Schema type definition
 */
export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  prefixItems?: JSONSchema[];
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  propertyNames?: JSONSchema;
  enum?: any[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  additionalItems?: boolean | JSONSchema;
  not?: JSONSchema;
  $ref?: string;
  description?: string;
  default?: any;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  const?: any;
  title?: string;
  $defs?: Record<string, JSONSchema>;
  /** Gemini-specific: deterministic property emission order for strict mode. */
  propertyOrdering?: string[];
  [metadata: string]: unknown;
}
