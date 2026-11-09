/**
 * Tables as gin types, and gin types as tables.
 *
 * `tableToGinType` gives the plain type of a table's rows: one prop per column,
 * `nullable<…>` for a column that may be empty, an `enum` for a column with a
 * closed set of values, the column's default as the prop's default, and docs
 * saying what the type cannot (the key, references, values the database
 * assigns). A foreign key stays its scalar value, because a row holds the key,
 * not the row it points at; the reference is in the docs and in the table.
 *
 * `ginTypeToTable` goes the other way, for making or altering a table from a
 * type. Given the `current` table it keeps every physical detail the type does
 * not speak to (a decimal's precision, a default the database computes, the
 * identity column, check and constraint names), so a type that only gained
 * descriptions, formats or ranges (an enriched type) maps back to the same
 * table and plans no change.
 */
import type { ExprDef, PropDef, TypeDef as GinTypeDef } from '@aeye/gin';
import type { ColumnDefault, ColumnSpec, ColumnType, ForeignKeySpec, TableSpec, UniqueSpec } from './table';

/** The pattern a gin `text` carries to mean a UUID. */
export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** The gin type of a table's rows: an `obj` with one prop per column. */
export function tableToGinType(table: TableSpec): GinTypeDef {
  const props: Record<string, PropDef> = {};
  for (const c of table.columns) props[c.name] = columnToProp(table, c);
  const key = table.primaryKey.length > 0 ? ` Key: ${table.primaryKey.join(', ')}.` : ' No primary key.';
  return { name: 'obj', docs: `${table.comment ?? `A row of table ${table.name}.`}${key}`, props };
}

/** The prop for one column. */
function columnToProp(table: TableSpec, c: ColumnSpec): PropDef {
  const base = valueType(c);
  const docs = [
    c.comment,
    c.generated ? 'Assigned by the database.' : undefined,
    ...table.foreignKeys.filter((f) => f.columns.includes(c.name)).map((f) => `References ${f.table}.${f.references[f.columns.indexOf(c.name)] ?? f.references[0]}.`),
    c.default?.kind === 'now' ? 'Defaults to the current time.' : undefined,
    c.default?.kind === 'sql' ? `Defaults to \`${c.default.sql}\`.` : undefined,
  ].filter((d): d is string => d !== undefined && d !== '');
  const prop: PropDef = { type: c.nullable ? { name: 'nullable', generic: { T: base } } : base };
  if (docs.length > 0) prop.docs = docs.join(' ');
  if (c.default?.kind === 'value' && c.default.value !== null) prop.default = { kind: 'new', type: scalarType(c.type), value: c.default.value };
  return prop;
}

/** A column's value type: its scalar type, or an enum of its values. */
function valueType(c: ColumnSpec): GinTypeDef {
  const scalar = scalarType(c.type);
  if (!c.values) return scalar;
  const values: Record<string, string | number> = {};
  for (const v of c.values) values[String(v)] = v;
  return { name: 'enum', generic: { V: scalar }, options: { values } };
}

/** The gin scalar for a column type. */
export function scalarType(t: ColumnType): GinTypeDef {
  switch (t.kind) {
    case 'text':
      return t.maxLength === undefined ? { name: 'text' } : { name: 'text', options: { maxLength: t.maxLength } };
    case 'uuid':
      return { name: 'text', options: { pattern: UUID_PATTERN } };
    case 'integer':
      return { name: 'num', options: { whole: true } };
    case 'decimal':
      return t.scale === undefined ? { name: 'num' } : { name: 'num', options: { maxPrecision: t.scale } };
    case 'float':
      return { name: 'num' };
    case 'bool':
      return { name: 'bool' };
    case 'date':
      return { name: 'date' };
    case 'timestamp':
      return { name: 'timestamp' };
    case 'json':
      return { name: 'any' };
    case 'bytes':
      return { name: 'text', docs: 'Binary data, base64.' };
    case 'other':
      return { name: 'any', docs: `Stored as ${t.native}.` };
  }
}

/** What `ginTypeToTable` needs besides the type. */
export interface GinTableOptions {
  /** The table as the database has it now; its physical details are kept where the type does not change them. */
  readonly current?: TableSpec;
  /** The primary key (else the current one, else `id` when there is such a prop). */
  readonly primaryKey?: readonly string[];
  readonly foreignKeys?: readonly ForeignKeySpec[];
  readonly unique?: readonly UniqueSpec[];
  readonly schema?: string;
  readonly comment?: string;
  /**
   * The table behind a named type, for a prop whose type is another table's
   * type: the column takes that table's key type and becomes a foreign key.
   */
  readonly resolveTable?: (typeName: string) => TableSpec | undefined;
}

/** A table for a gin `obj` type. Throws when the type is not an `obj` with props. */
export function ginTypeToTable(name: string, def: GinTypeDef, options: GinTableOptions = {}): TableSpec {
  if (def.name !== 'obj' || !def.props || Object.keys(def.props).length === 0) {
    throw new Error(`ginTypeToTable: ${name} must be an obj type with at least one prop (got '${def.name}').`);
  }
  const current = options.current;
  const refs: ForeignKeySpec[] = [];
  const columns: ColumnSpec[] = [];
  for (const [prop, spec] of Object.entries(def.props)) {
    if (spec.get) continue; // a computed prop is not stored
    const had = current?.columns.find((c) => c.name === prop);
    const { column, ref } = propToColumn(prop, spec, had, options.resolveTable);
    columns.push(column);
    if (ref) refs.push(ref);
  }
  const names = new Set(columns.map((c) => c.name));
  const keep = <T extends { columns: readonly string[] }>(xs: readonly T[] | undefined): T[] =>
    (xs ?? []).filter((x) => x.columns.every((c) => names.has(c)));
  const primaryKey = [...(options.primaryKey ?? (current && keep([{ columns: current.primaryKey }]).length ? current.primaryKey : names.has('id') ? ['id'] : []))];
  const foreignKeys = options.foreignKeys ? [...options.foreignKeys] : keep(current?.foreignKeys);
  for (const r of refs) if (!foreignKeys.some((f) => f.columns.join() === r.columns.join())) foreignKeys.push(r);
  // A new single whole-number key is one the database assigns.
  const key = primaryKey.length === 1 ? columns.find((c) => c.name === primaryKey[0]) : undefined;
  if (key && !current?.columns.some((c) => c.name === key.name) && key.type.kind === 'integer' && !key.default) key.generated = true;
  for (const c of columns) if (primaryKey.includes(c.name)) c.nullable = false;
  const table: TableSpec = {
    name,
    columns,
    primaryKey,
    foreignKeys,
    unique: options.unique ? [...options.unique] : keep(current?.unique),
  };
  const schema = options.schema ?? current?.schema;
  if (schema !== undefined) table.schema = schema;
  if (current?.primaryKeyName !== undefined && primaryKey.join() === current.primaryKey.join()) table.primaryKeyName = current.primaryKeyName;
  const comment = options.comment ?? current?.comment;
  if (comment !== undefined) table.comment = comment;
  return table;
}

/** One column for a prop, keeping the current column's details where the prop's storage is unchanged. */
function propToColumn(
  name: string,
  spec: PropDef,
  had: ColumnSpec | undefined,
  resolveTable: GinTableOptions['resolveTable'],
): { column: ColumnSpec; ref?: ForeignKeySpec } {
  let type = spec.type;
  let nullable = false;
  while (type.name === 'nullable' || type.name === 'optional') {
    nullable = true;
    type = type.generic?.['T'] ?? { name: 'any' };
  }
  let values: (string | number)[] | undefined;
  if (type.name === 'enum') {
    values = enumValues(type);
    type = type.generic?.['V'] ?? { name: 'text' };
  }
  let ref: ForeignKeySpec | undefined;
  let columnType = ginToColumnType(type);
  const target = BUILTIN_NAMES.has(type.name) ? undefined : resolveTable?.(type.name);
  if (target && target.primaryKey.length === 1) {
    const key = target.columns.find((c) => c.name === target.primaryKey[0]);
    if (key) {
      columnType = key.type;
      ref = { columns: [name], table: target.name, references: [key.name] };
    }
  }
  const sameStorage = had !== undefined && JSON.stringify(storage(scalarType(had.type))) === JSON.stringify(storage(scalarType(columnType)));
  const column: ColumnSpec = { name, type: sameStorage && had ? had.type : columnType, nullable };
  const fallback = defaultOf(spec.default);
  const dflt = fallback ?? had?.default;
  if (dflt) column.default = dflt;
  if (had?.generated) column.generated = true;
  // An enum is a check constraint on a new column, or on one that already has one; on an existing
  // unconstrained column it stays a description (an enriched type must not add constraints).
  const keepValues = values && (!had || had.values) ? values : had?.values;
  if (keepValues) column.values = keepValues;
  if (had?.checkName) column.checkName = had.checkName;
  if (had?.defaultName) column.defaultName = had.defaultName;
  if (had?.comment) column.comment = had.comment;
  return ref ? { column, ref } : { column };
}

/** The gin type names that are not another table's type. */
const BUILTIN_NAMES = new Set([
  'any', 'void', 'null', 'bool', 'num', 'text', 'list', 'map', 'tuple', 'obj', 'optional', 'nullable', 'not', 'or',
  'and', 'enum', 'literal', 'function', 'fn', 'interface', 'iface', 'typ', 'date', 'timestamp', 'duration', 'color',
]);

/** The column type for a gin value type. */
export function ginToColumnType(type: GinTypeDef): ColumnType {
  const o = isRecord(type.options) ? type.options : {};
  switch (type.name) {
    case 'text':
      if (o['pattern'] === UUID_PATTERN) return { kind: 'uuid' };
      return typeof o['maxLength'] === 'number' ? { kind: 'text', maxLength: o['maxLength'] } : { kind: 'text' };
    case 'num':
      if (o['whole'] === true) return { kind: 'integer' };
      return typeof o['maxPrecision'] === 'number' ? { kind: 'decimal', scale: o['maxPrecision'] } : { kind: 'float' };
    case 'bool':
      return { kind: 'bool' };
    case 'date':
      return { kind: 'date' };
    case 'timestamp':
      return { kind: 'timestamp' };
    case 'duration':
      return { kind: 'integer', big: true };
    case 'color':
      return { kind: 'integer' };
    case 'literal':
      return typeof o['value'] === 'number' ? { kind: 'float' } : typeof o['value'] === 'boolean' ? { kind: 'bool' } : { kind: 'text' };
    default:
      return { kind: 'json' };
  }
}

/** The part of a gin scalar that decides how it is stored: its name and size options, not its docs or ranges. */
function storage(type: GinTypeDef): Record<string, unknown> {
  const o = isRecord(type.options) ? type.options : {};
  return { name: type.name, maxLength: o['maxLength'], whole: o['whole'], maxPrecision: o['maxPrecision'], uuid: o['pattern'] === UUID_PATTERN };
}

/** The values of a gin enum def. */
function enumValues(type: GinTypeDef): (string | number)[] | undefined {
  const o = isRecord(type.options) ? type.options : {};
  const values = o['values'];
  if (!isRecord(values)) return undefined;
  const out = Object.values(values).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  return out.length > 0 ? out : undefined;
}

/** A column default for a prop default that is a constant `new`. */
function defaultOf(expr: ExprDef | undefined): ColumnDefault | undefined {
  if (!expr || expr.kind !== 'new' || !('value' in expr)) return undefined;
  const value: unknown = expr['value'];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return { kind: 'value', value };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
