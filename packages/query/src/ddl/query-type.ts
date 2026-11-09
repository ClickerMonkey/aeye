/**
 * A table as a query Type: the conceptual schema a query (and a model writing
 * one) is checked against. Each column is a field; a single-column foreign key
 * onto another table's key is a `relation` field of the same name (so the
 * query can cross it, and SQL still reads the stored key column); the primary
 * key is the identity and a unique index; a column's closed set of values is
 * its `values`.
 */
import type { FieldDef, FieldTypeDef, IndexDef, TypeDef } from '../schema';
import type { ColumnSpec, ColumnType, TableSpec } from './table';

/** What `tableToQueryType` needs besides the table. */
export interface QueryTypeOptions {
  /** The query Type name of a table (default: the table name). Relations name their targets with it too. */
  readonly typeName?: (table: string) => string;
  /** The estimated row count (drives cost estimates; default 1000). */
  readonly rowCount?: number;
  /** The tables a foreign key may point at, to check the reference is onto their key. */
  readonly tables?: readonly TableSpec[];
}

/** The query Type for a table. */
export function tableToQueryType(table: TableSpec, options: QueryTypeOptions = {}): TypeDef {
  const name = options.typeName ?? ((t: string) => t);
  const fields: FieldDef[] = table.columns.map((c) => {
    const field: FieldDef = { name: c.name, type: relationOf(table, c, options, name) ?? fieldTypeOf(c) };
    if (c.nullable) field.nullable = true;
    if (c.comment) field.description = c.comment;
    if (c.generated) field.insertable = false;
    return field;
  });
  const indexes: IndexDef[] = [];
  const unique = [table.primaryKey, ...table.unique.map((u) => u.columns)].filter((cols) => cols.length > 0);
  for (const cols of unique) {
    indexes.push({ exprs: cols.map((field, i) => ({ expr: { kind: 'field-ref', source: name(table.name), field }, count: i === cols.length - 1 ? 1 : 10 })) });
  }
  const def: TypeDef = { name: name(table.name), fields, count: options.rowCount ?? 1000 };
  if (table.comment) def.description = table.comment;
  if (indexes.length > 0) def.indexes = indexes;
  if (table.primaryKey.length > 0) def.identity = table.primaryKey.length === 1 ? (table.primaryKey[0] ?? 'id') : [...table.primaryKey];
  return def;
}

/** A belongs-to relation for a column that is a whole single-column foreign key onto a known table's key. */
function relationOf(table: TableSpec, c: ColumnSpec, options: QueryTypeOptions, name: (t: string) => string): FieldTypeDef | undefined {
  const fk = table.foreignKeys.find((f) => f.columns.length === 1 && f.columns[0] === c.name);
  if (!fk) return undefined;
  const target = options.tables?.find((t) => t.name === fk.table);
  if (options.tables && (!target || target.primaryKey.length !== 1 || target.primaryKey[0] !== fk.references[0])) return undefined;
  return { kind: 'relation', to: name(fk.table), count: 1 };
}

/** The field type of a column. */
function fieldTypeOf(c: ColumnSpec): FieldTypeDef {
  const t = scalarFieldType(c.type);
  if (!c.values) return t;
  const values = c.values.map((value) => ({ value }));
  if (t.kind === 'text') return { ...t, values };
  if (t.kind === 'number') return { ...t, values };
  return t;
}

/** The query field type for a column type. */
export function scalarFieldType(t: ColumnType): FieldTypeDef {
  switch (t.kind) {
    case 'text':
      return t.maxLength === undefined ? { kind: 'text' } : { kind: 'text', maxLength: t.maxLength };
    case 'uuid':
    case 'bytes':
    case 'other':
      return { kind: 'text' };
    case 'integer':
      return { kind: 'number', whole: true };
    case 'decimal':
      return t.scale === undefined ? { kind: 'number' } : { kind: 'number', maxPlaces: t.scale };
    case 'float':
      return { kind: 'number' };
    case 'bool':
      return { kind: 'bool' };
    case 'date':
      return { kind: 'date' };
    case 'timestamp':
      return { kind: 'timestamp', timezone: t.timezone !== false };
    case 'json':
      return { kind: 'json' };
  }
}
