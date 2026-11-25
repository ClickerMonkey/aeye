// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * The physical shape of a table, as a database reports it or as DDL should make
 * it: columns with a portable column type, nullability, defaults, the primary
 * key, foreign keys and unique sets. One shape for both directions, so a schema
 * read from a live database and a table wanted from a type compare directly
 * (`Dialect.ddl.alterTable(current, wanted)`).
 *
 * Constraint names are optional: a schema reader fills the names the database
 * uses, and DDL that creates a constraint names it `pk_<table>`,
 * `fk_<table>_<columns>`, `uq_<table>_<columns>`, `ck_<table>_<column>` and
 * (SQL Server defaults) `df_<table>_<column>`. A drop with no recorded name uses
 * that same convention.
 */
import { z } from 'zod';

/** A portable column type: what a column holds, independent of any dialect's spelling. */
export const ColumnType = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), maxLength: z.number().int().positive().optional() }),
  z.object({ kind: z.literal('integer'), big: z.boolean().optional() }),
  z.object({
    kind: z.literal('decimal'),
    precision: z.number().int().positive().optional(),
    scale: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('float') }),
  z.object({ kind: z.literal('bool') }),
  z.object({ kind: z.literal('date') }),
  z.object({ kind: z.literal('timestamp'), timezone: z.boolean().optional() }),
  z.object({ kind: z.literal('uuid') }),
  z.object({ kind: z.literal('json') }),
  z.object({ kind: z.literal('bytes') }),
  /** A native type with no portable equivalent, kept by name so it survives a round trip. */
  z.object({ kind: z.literal('other'), native: z.string().min(1) }),
]);
export type ColumnType = z.infer<typeof ColumnType>;

/** The kinds of {@link ColumnType}. */
export type ColumnTypeKind = ColumnType['kind'];

/** A column default: a constant, the current time, or a native SQL expression as the database reported it. */
export const ColumnDefault = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ kind: z.literal('now') }),
  z.object({ kind: z.literal('sql'), sql: z.string().min(1) }),
]);
export type ColumnDefault = z.infer<typeof ColumnDefault>;

/** One column. */
export const ColumnSpec = z.object({
  name: z.string().min(1),
  type: ColumnType,
  nullable: z.boolean(),
  default: ColumnDefault.optional(),
  /** The database assigns the value (an identity / autoincrement key). */
  generated: z.boolean().optional(),
  /** The closed set of values the column may hold (a `CHECK (… IN …)` constraint). */
  values: z.array(z.union([z.string(), z.number()])).min(1).optional(),
  /** The name of that check constraint, when read from a database. */
  checkName: z.string().optional(),
  /** The name of the default constraint (SQL Server), when read from a database. */
  defaultName: z.string().optional(),
  /** A comment or description, when the database has one. */
  comment: z.string().optional(),
});
export type ColumnSpec = z.infer<typeof ColumnSpec>;

/** A foreign key: `columns` of this table reference `references` of `table`. */
export const ForeignKeySpec = z.object({
  name: z.string().optional(),
  columns: z.array(z.string().min(1)).min(1),
  table: z.string().min(1),
  references: z.array(z.string().min(1)).min(1),
  onDelete: z.enum(['no-action', 'cascade', 'set-null', 'restrict']).optional(),
});
export type ForeignKeySpec = z.infer<typeof ForeignKeySpec>;

/** A set of columns whose values together are unique. */
export const UniqueSpec = z.object({ name: z.string().optional(), columns: z.array(z.string().min(1)).min(1) });
export type UniqueSpec = z.infer<typeof UniqueSpec>;

/** A table. */
export const TableSpec = z.object({
  name: z.string().min(1),
  /** The schema (namespace) it lives in, when the database has them (`public`, `dbo`). */
  schema: z.string().optional(),
  columns: z.array(ColumnSpec).min(1),
  primaryKey: z.array(z.string().min(1)),
  primaryKeyName: z.string().optional(),
  foreignKeys: z.array(ForeignKeySpec),
  unique: z.array(UniqueSpec),
  comment: z.string().optional(),
});
export type TableSpec = z.infer<typeof TableSpec>;

/** True when two column types are the same type. */
export function sameColumnType(a: ColumnType, b: ColumnType): boolean {
  return JSON.stringify(normalizeColumnType(a)) === JSON.stringify(normalizeColumnType(b));
}

/** A column type with its optional fields in a fixed order, so equal types serialize equally. */
function normalizeColumnType(t: ColumnType): ColumnType {
  switch (t.kind) {
    case 'text':
      return t.maxLength === undefined ? { kind: 'text' } : { kind: 'text', maxLength: t.maxLength };
    case 'integer':
      return t.big ? { kind: 'integer', big: true } : { kind: 'integer' };
    case 'decimal':
      return { kind: 'decimal', ...(t.precision !== undefined ? { precision: t.precision } : {}), ...(t.scale !== undefined ? { scale: t.scale } : {}) };
    case 'timestamp':
      return { kind: 'timestamp', timezone: t.timezone !== false };
    default:
      return t;
  }
}

/**
 * True when every value of `from` fits `to` unchanged, so converting a column is
 * safe; false for a narrowing change that can lose or refuse data.
 */
export function columnTypeWidens(from: ColumnType, to: ColumnType): boolean {
  if (sameColumnType(from, to)) return true;
  switch (to.kind) {
    case 'text':
      if (to.maxLength === undefined) return from.kind !== 'bytes';
      return from.kind === 'text' && from.maxLength !== undefined && from.maxLength <= to.maxLength;
    case 'integer':
      return from.kind === 'bool' || (from.kind === 'integer' && to.big === true);
    case 'decimal':
      if (from.kind === 'integer' || from.kind === 'bool') return true;
      if (from.kind !== 'decimal') return false;
      return (to.precision ?? 38) >= (from.precision ?? 38) && (to.scale ?? 0) >= (from.scale ?? 0);
    case 'float':
      return from.kind === 'integer' || from.kind === 'bool';
    case 'timestamp':
      return from.kind === 'date' || (from.kind === 'timestamp' && to.timezone !== false);
    default:
      return false;
  }
}
