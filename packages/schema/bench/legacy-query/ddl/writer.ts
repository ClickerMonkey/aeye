// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * DDL from table shapes: `CREATE TABLE` for a {@link TableSpec}, and the ordered
 * `ALTER` steps that turn the table a database has into the table that is
 * wanted. Each dialect has one writer (`dialect.ddl`); the diff and the step
 * order are shared here, and a dialect overrides only its spelling (types,
 * identity columns, how a column is altered) or, for SQLite, how a change that
 * `ALTER TABLE` cannot express is made (a table rebuild).
 */
import { z } from 'zod';
import type { Dialect } from '../sql/dialect';
import {
  type ColumnDefault,
  type ColumnSpec,
  type ColumnType,
  type ForeignKeySpec,
  type TableSpec,
  type UniqueSpec,
  columnTypeWidens,
  sameColumnType,
} from './table';

/** What a DDL step does. */
export const DdlAction = z.enum([
  'create-table',
  'drop-table',
  'rebuild-table',
  'add-column',
  'drop-column',
  'alter-column',
  'add-constraint',
  'drop-constraint',
]);
export type DdlAction = z.infer<typeof DdlAction>;

/** One step of a schema change: its statements, in order, and whether it can lose data. */
export const DdlStep = z.object({
  action: DdlAction,
  table: z.string(),
  /** The column or constraint the step is about, when it is about one. */
  target: z.string().optional(),
  /** The statements to run, in order. */
  sql: z.array(z.string()).min(1),
  /** True when the step can lose data: a drop, or a type change that narrows. */
  irreversible: z.boolean(),
  /** One plain sentence saying what the step does. */
  summary: z.string(),
});
export type DdlStep = z.infer<typeof DdlStep>;

/** A schema change DDL cannot express (a renamed table, a missing constraint name the dialect needs). */
export class DdlError extends Error {
  override readonly name = 'DdlError';
}

/** How one column differs between the current and the wanted table. */
export interface ColumnChange {
  readonly from: ColumnSpec;
  readonly to: ColumnSpec;
  readonly type: boolean;
  readonly nullable: boolean;
  readonly default: boolean;
  readonly values: boolean;
}

/** Everything that differs between two shapes of one table. */
export interface TableDiff {
  readonly added: readonly ColumnSpec[];
  readonly dropped: readonly ColumnSpec[];
  readonly changed: readonly ColumnChange[];
  readonly primaryKey: boolean;
  readonly foreignKeysAdded: readonly ForeignKeySpec[];
  readonly foreignKeysDropped: readonly ForeignKeySpec[];
  readonly uniqueAdded: readonly UniqueSpec[];
  readonly uniqueDropped: readonly UniqueSpec[];
}

/** A dialect's DDL: native types both ways, defaults read back, `CREATE`, `DROP` and `ALTER`. */
export interface DdlWriter {
  /** The native type this dialect gives a column type. */
  columnType(type: ColumnType): string;
  /** The column type for a native type as a database reports it (`character varying(40)`, `nvarchar(max)`). */
  readColumnType(native: string): ColumnType;
  /** A column default as a database reports it (`('x'::text)`, `((0))`, `now()`), or undefined for none / `NULL`. */
  readDefault(sql: string): ColumnDefault | undefined;
  /** The column type a database reports back after creating `type` (types it has no exact spelling for widen). */
  canonicalType(type: ColumnType): ColumnType;
  /** What differs between two shapes of one table, compared the way this dialect stores them. */
  diff(current: TableSpec, wanted: TableSpec): TableDiff;
  /** `CREATE TABLE` for a table, constraints included. */
  createTable(table: TableSpec): DdlStep;
  /** `DROP TABLE`. */
  dropTable(table: TableSpec): DdlStep;
  /** The ordered steps that turn `current` into `wanted` (empty when they match). Throws {@link DdlError}. */
  alterTable(current: TableSpec, wanted: TableSpec): DdlStep[];
}

/** The shared DDL algorithm; a dialect supplies its spelling through the protected hooks. */
export abstract class SqlDdl implements DdlWriter {
  constructor(protected readonly dialect: Dialect) {}

  abstract columnType(type: ColumnType): string;
  abstract readColumnType(native: string): ColumnType;

  canonicalType(type: ColumnType): ColumnType {
    return this.readColumnType(this.columnType(type));
  }

  readDefault(sql: string): ColumnDefault | undefined {
    let s = sql.trim();
    while (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim();
    s = s.replace(/::[\w\s"[\].]+(\(\d+(,\s*\d+)?\))?$/u, '').trim();
    if (/^null$/iu.test(s)) return undefined;
    if (/^(current_timestamp|now\(\)|getdate\(\)|sysdatetime\(\)|sysdatetimeoffset\(\)|getutcdate\(\)|sysutcdatetime\(\)|datetime\('now'\))$/iu.test(s)) {
      return { kind: 'now' };
    }
    if (/^(true|false)$/iu.test(s)) return { kind: 'value', value: s.toLowerCase() === 'true' };
    if (/^-?\d+(\.\d+)?$/u.test(s)) return { kind: 'value', value: Number(s) };
    const quoted = /^N?'((?:[^']|'')*)'$/u.exec(s);
    if (quoted) return { kind: 'value', value: (quoted[1] ?? '').replace(/''/g, "'") };
    return { kind: 'sql', sql: s };
  }

  diff(current: TableSpec, wanted: TableSpec): TableDiff {
    const have = new Map(current.columns.map((c) => [c.name, c]));
    const want = new Map(wanted.columns.map((c) => [c.name, c]));
    const changed: ColumnChange[] = [];
    for (const to of wanted.columns) {
      const from = have.get(to.name);
      if (!from) continue;
      const change: ColumnChange = {
        from,
        to,
        type: !sameColumnType(this.canonicalType(from.type), this.canonicalType(to.type)),
        nullable: from.nullable !== to.nullable,
        default: this.comparableDefault(from) !== this.comparableDefault(to),
        values: JSON.stringify(from.values ?? null) !== JSON.stringify(to.values ?? null),
      };
      if (change.type || change.nullable || change.default || change.values) changed.push(change);
    }
    const fkKey = (f: ForeignKeySpec): string => JSON.stringify([f.columns, f.table, f.references, f.onDelete ?? 'no-action']);
    const uqKey = (u: UniqueSpec): string => JSON.stringify(u.columns);
    const haveFk = new Set(current.foreignKeys.map(fkKey));
    const wantFk = new Set(wanted.foreignKeys.map(fkKey));
    const haveUq = new Set(current.unique.map(uqKey));
    const wantUq = new Set(wanted.unique.map(uqKey));
    return {
      added: wanted.columns.filter((c) => !have.has(c.name)),
      dropped: current.columns.filter((c) => !want.has(c.name)),
      changed,
      primaryKey: JSON.stringify(current.primaryKey) !== JSON.stringify(wanted.primaryKey),
      foreignKeysAdded: wanted.foreignKeys.filter((f) => !haveFk.has(fkKey(f))),
      foreignKeysDropped: current.foreignKeys.filter((f) => !wantFk.has(fkKey(f))),
      uniqueAdded: wanted.unique.filter((u) => !haveUq.has(uqKey(u))),
      uniqueDropped: current.unique.filter((u) => !wantUq.has(uqKey(u))),
    };
  }

  createTable(table: TableSpec): DdlStep {
    return {
      action: 'create-table',
      table: table.name,
      sql: [this.createSql(table, table.name)],
      irreversible: false,
      summary: `Create table ${table.name} with ${table.columns.length} column${table.columns.length === 1 ? '' : 's'}.`,
    };
  }

  dropTable(table: TableSpec): DdlStep {
    return {
      action: 'drop-table',
      table: table.name,
      sql: [`DROP TABLE ${this.tableName(table)}`],
      irreversible: true,
      summary: `Drop table ${table.name} and every row in it.`,
    };
  }

  alterTable(current: TableSpec, wanted: TableSpec): DdlStep[] {
    if (current.name !== wanted.name) {
      throw new DdlError(`Cannot alter table ${current.name} into ${wanted.name}: renaming a table is not a schema change DDL plans.`);
    }
    return this.planAlter(current, wanted, this.diff(current, wanted));
  }

  /**
   * The ALTER steps for a diff, in an order that never trips a constraint:
   * drop the constraints that go or change, drop columns, add columns, alter
   * columns, then add the constraints that are new or changed.
   */
  protected planAlter(current: TableSpec, wanted: TableSpec, diff: TableDiff): DdlStep[] {
    const steps: DdlStep[] = [];
    const t = wanted.name;
    for (const f of diff.foreignKeysDropped) steps.push(this.dropConstraint(current, f.name ?? fkName(t, f.columns)));
    for (const u of diff.uniqueDropped) steps.push(this.dropConstraint(current, u.name ?? uqName(t, u.columns)));
    if (diff.primaryKey && current.primaryKey.length > 0) steps.push(this.dropConstraint(current, current.primaryKeyName ?? pkName(t)));
    for (const c of diff.changed) {
      if (c.values && c.from.values) steps.push(this.dropConstraint(current, c.from.checkName ?? ckName(t, c.from.name)));
    }
    for (const c of diff.dropped) {
      if (c.values) steps.push(this.dropConstraint(current, c.checkName ?? ckName(t, c.name)));
      steps.push({
        action: 'drop-column',
        table: t,
        target: c.name,
        sql: [`ALTER TABLE ${this.tableName(current)} DROP COLUMN ${this.q(c.name)}`],
        irreversible: true,
        summary: `Drop column ${c.name} and its data.`,
      });
    }
    for (const c of diff.added) {
      steps.push({
        action: 'add-column',
        table: t,
        target: c.name,
        sql: [`ALTER TABLE ${this.tableName(wanted)} ${this.addColumnKeyword()} ${this.columnDefinition(wanted, c)}`],
        irreversible: false,
        summary: `Add column ${c.name} (${this.columnType(c.type)}${c.nullable ? '' : ', required'}).`,
      });
      if (c.values) steps.push(this.addConstraint(wanted, ckName(t, c.name), this.checkClause(c)));
    }
    for (const c of diff.changed) {
      if (!(c.type || c.nullable || c.default)) continue;
      const narrows = c.type && !columnTypeWidens(c.from.type, c.to.type);
      steps.push({
        action: 'alter-column',
        table: t,
        target: c.to.name,
        sql: this.alterColumn(wanted, c),
        irreversible: narrows,
        summary: changeSummary(c, this, narrows),
      });
    }
    for (const c of diff.changed) {
      if (c.values && c.to.values) steps.push(this.addConstraint(wanted, ckName(t, c.to.name), this.checkClause(c.to)));
    }
    if (diff.primaryKey && wanted.primaryKey.length > 0) {
      steps.push(this.addConstraint(wanted, pkName(t), `PRIMARY KEY (${this.list(wanted.primaryKey)})`));
    }
    for (const u of diff.uniqueAdded) steps.push(this.addConstraint(wanted, uqName(t, u.columns), `UNIQUE (${this.list(u.columns)})`));
    for (const f of diff.foreignKeysAdded) steps.push(this.addConstraint(wanted, fkName(t, f.columns), this.foreignKeyClause(f)));
    return steps;
  }

  // ─── Spelling hooks ─────────────────────────────────────────────────────────

  /** A quoted identifier. */
  protected q(name: string): string {
    return this.dialect.quoteIdent(name);
  }

  /** The table's quoted, schema-qualified name. */
  protected tableName(table: TableSpec): string {
    return table.schema ? `${this.q(table.schema)}.${this.q(table.name)}` : this.q(table.name);
  }

  /** Quoted, comma-separated column names. */
  protected list(columns: readonly string[]): string {
    return columns.map((c) => this.q(c)).join(', ');
  }

  /** The keyword between `ALTER TABLE t` and a new column (`ADD COLUMN`; SQL Server `ADD`). */
  protected addColumnKeyword(): string {
    return 'ADD COLUMN';
  }

  /** The words after the type that make the database assign the value. */
  protected generatedClause(): string {
    return 'GENERATED BY DEFAULT AS IDENTITY';
  }

  /** A constant as a SQL literal. */
  protected literal(value: string | number | boolean | null): string {
    if (value === null) return 'NULL';
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return String(value);
    return `'${value.replace(/'/g, "''")}'`;
  }

  /** A default as SQL. */
  protected defaultSql(d: ColumnDefault): string {
    switch (d.kind) {
      case 'value':
        return this.literal(d.value);
      case 'now':
        return 'CURRENT_TIMESTAMP';
      case 'sql':
        return d.sql;
    }
  }

  /**
   * A column's default as it compares: the SQL this dialect would write for it,
   * so `false` and a read-back `0` match on SQLite, and absent and `NULL` are the same.
   */
  protected comparableDefault(c: ColumnSpec): string | null {
    if (!c.default) return null;
    const d = c.default.kind === 'sql' ? this.readDefault(c.default.sql) : c.default;
    if (!d || (d.kind === 'value' && d.value === null)) return null;
    return this.defaultSql(d);
  }

  /** One column of a `CREATE TABLE` or `ADD COLUMN`. */
  protected columnDefinition(table: TableSpec, c: ColumnSpec): string {
    const parts = [this.q(c.name), this.columnType(c.type)];
    if (c.generated) parts.push(this.generatedClause());
    if (!c.nullable) parts.push('NOT NULL');
    if (c.default) parts.push(this.defaultClause(table, c, c.default));
    return parts.join(' ');
  }

  /** `DEFAULT <sql>` (SQL Server names it). */
  protected defaultClause(_table: TableSpec, _c: ColumnSpec, d: ColumnDefault): string {
    return `DEFAULT ${this.defaultSql(d)}`;
  }

  /** The `CREATE TABLE` statement; its constraints are named after `owner` (the table, unless it is a stand-in). */
  protected createSql(table: TableSpec, owner: string): string {
    const lines = [...table.columns.map((c) => this.columnDefinition(table, c)), ...this.tableConstraints(table, owner)];
    return `CREATE TABLE ${this.tableName(table)} (\n  ${lines.join(',\n  ')}\n)`;
  }

  /** The table-level constraints of a `CREATE TABLE`, named after `owner`. */
  protected tableConstraints(table: TableSpec, owner: string): string[] {
    const out: string[] = [];
    if (table.primaryKey.length > 0) out.push(`CONSTRAINT ${this.q(pkName(owner))} PRIMARY KEY (${this.list(table.primaryKey)})`);
    for (const u of table.unique) out.push(`CONSTRAINT ${this.q(uqName(owner, u.columns))} UNIQUE (${this.list(u.columns)})`);
    for (const f of table.foreignKeys) out.push(`CONSTRAINT ${this.q(fkName(owner, f.columns))} ${this.foreignKeyClause(f)}`);
    for (const c of table.columns) if (c.values) out.push(`CONSTRAINT ${this.q(ckName(owner, c.name))} ${this.checkClause(c)}`);
    return out;
  }

  /** `FOREIGN KEY (…) REFERENCES t (…) [ON DELETE …]`. */
  protected foreignKeyClause(f: ForeignKeySpec): string {
    const onDelete = f.onDelete && f.onDelete !== 'no-action' ? ` ON DELETE ${f.onDelete.replace('-', ' ').toUpperCase()}` : '';
    return `FOREIGN KEY (${this.list(f.columns)}) REFERENCES ${this.q(f.table)} (${this.list(f.references)})${onDelete}`;
  }

  /** `CHECK (c IN (…))` for a column with a closed set of values. */
  protected checkClause(c: ColumnSpec): string {
    return `CHECK (${this.q(c.name)} IN (${(c.values ?? []).map((v) => this.literal(v)).join(', ')}))`;
  }

  /** The statements that change one column's type, nullability or default (ANSI / Postgres). */
  protected alterColumn(table: TableSpec, c: ColumnChange): string[] {
    const head = `ALTER TABLE ${this.tableName(table)} ALTER COLUMN ${this.q(c.to.name)}`;
    const out: string[] = [];
    if (c.type) out.push(`${head} TYPE ${this.columnType(c.to.type)}`);
    if (c.nullable) out.push(`${head} ${c.to.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    if (c.default) out.push(c.to.default ? `${head} SET DEFAULT ${this.defaultSql(c.to.default)}` : `${head} DROP DEFAULT`);
    return out;
  }

  /** A step adding a named table constraint. */
  protected addConstraint(table: TableSpec, name: string, clause: string): DdlStep {
    return {
      action: 'add-constraint',
      table: table.name,
      target: name,
      sql: [`ALTER TABLE ${this.tableName(table)} ADD CONSTRAINT ${this.q(name)} ${clause}`],
      irreversible: false,
      summary: `Add constraint ${name}: ${clause}.`,
    };
  }

  /** A step dropping a named table constraint. */
  protected dropConstraint(table: TableSpec, name: string): DdlStep {
    return {
      action: 'drop-constraint',
      table: table.name,
      target: name,
      sql: [`ALTER TABLE ${this.tableName(table)} DROP CONSTRAINT ${this.q(name)}`],
      irreversible: false,
      summary: `Drop constraint ${name}.`,
    };
  }
}

/** The ANSI writer (the base dialect): portable spellings, read leniently. */
export class AnsiDdl extends SqlDdl {
  columnType(type: ColumnType): string {
    switch (type.kind) {
      case 'text':
        return type.maxLength === undefined ? 'varchar' : `varchar(${type.maxLength})`;
      case 'integer':
        return type.big ? 'bigint' : 'integer';
      case 'decimal':
        return decimalSpelling('numeric', type);
      case 'float':
        return 'double precision';
      case 'bool':
        return 'boolean';
      case 'date':
        return 'date';
      case 'timestamp':
        return type.timezone === false ? 'timestamp' : 'timestamp with time zone';
      case 'uuid':
        return 'uuid';
      case 'json':
        return 'json';
      case 'bytes':
        return 'blob';
      case 'other':
        return type.native;
    }
  }

  readColumnType(native: string): ColumnType {
    return readCommonType(native);
  }
}

/** `numeric(p,s)` / `numeric(p)` / `numeric`. */
export function decimalSpelling(word: string, type: { precision?: number | undefined; scale?: number | undefined }): string {
  if (type.precision === undefined) return word;
  return type.scale === undefined ? `${word}(${type.precision})` : `${word}(${type.precision},${type.scale})`;
}

/** A native type split into its lower-case name and numeric arguments (`varchar(40)` → `varchar`, `[40]`). */
export function splitNative(native: string): { name: string; args: number[]; max: boolean } {
  const m = /^\s*([^(]+?)\s*(?:\(([^)]*)\))?\s*(\[\])?\s*$/u.exec(native);
  const name = (m?.[1] ?? native).trim().toLowerCase().replace(/\s+/g, ' ');
  const raw = (m?.[2] ?? '').split(',').map((a) => a.trim()).filter((a) => a !== '');
  return { name, args: raw.map(Number).filter((n) => Number.isFinite(n)), max: raw.some((a) => a.toLowerCase() === 'max') };
}

/**
 * The column type for a native type name most databases share: the SQL
 * standard names and the common Postgres, SQLite and SQL Server spellings. A
 * dialect reader handles its own oddities first and falls back to this.
 */
export function readCommonType(native: string): ColumnType {
  const { name, args } = splitNative(native);
  const length = args[0];
  if (/^(n?varchar|character varying|varying character|n?char|character|nchar varying|string)$/u.test(name)) {
    return length === undefined ? { kind: 'text' } : { kind: 'text', maxLength: length };
  }
  if (/^(n?text|clob|citext|ntext|xml|tinytext|mediumtext|longtext)$/u.test(name)) return { kind: 'text' };
  if (/^(bigint|int8|bigserial|serial8)$/u.test(name)) return { kind: 'integer', big: true };
  if (/^(int|integer|int2|int4|smallint|tinyint|mediumint|serial|serial4|smallserial)$/u.test(name)) return { kind: 'integer' };
  if (/^(numeric|decimal|money|smallmoney)$/u.test(name)) {
    if (name === 'money' || name === 'smallmoney') return { kind: 'decimal', precision: 19, scale: 4 };
    return {
      kind: 'decimal',
      ...(args[0] !== undefined ? { precision: args[0] } : {}),
      ...(args[1] !== undefined ? { scale: args[1] } : {}),
    };
  }
  if (/^(real|float|float4|float8|double|double precision)$/u.test(name)) return { kind: 'float' };
  if (/^(bool|boolean|bit)$/u.test(name)) return { kind: 'bool' };
  if (name === 'date') return { kind: 'date' };
  if (/^(timestamptz|timestamp with time zone|datetimeoffset)$/u.test(name)) return { kind: 'timestamp', timezone: true };
  if (/^(timestamp|timestamp without time zone|datetime|datetime2|smalldatetime)$/u.test(name)) return { kind: 'timestamp', timezone: false };
  if (/^(uuid|uniqueidentifier)$/u.test(name)) return { kind: 'uuid' };
  if (/^(json|jsonb)$/u.test(name)) return { kind: 'json' };
  if (/^(bytea|blob|binary|varbinary|image)$/u.test(name)) return { kind: 'bytes' };
  return { kind: 'other', native: native.trim() };
}

/** `pk_<table>`. */
export function pkName(table: string): string {
  return `pk_${table}`;
}
/** `fk_<table>_<columns>`. */
export function fkName(table: string, columns: readonly string[]): string {
  return `fk_${table}_${columns.join('_')}`;
}
/** `uq_<table>_<columns>`. */
export function uqName(table: string, columns: readonly string[]): string {
  return `uq_${table}_${columns.join('_')}`;
}
/** `ck_<table>_<column>`. */
export function ckName(table: string, column: string): string {
  return `ck_${table}_${column}`;
}

/** True when the parentheses in `s` balance (so stripping an outer pair is safe). */
function balanced(s: string): boolean {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/** One sentence for an altered column. */
function changeSummary(c: ColumnChange, w: DdlWriter, narrows: boolean): string {
  const parts: string[] = [];
  if (c.type) parts.push(`type ${w.columnType(c.from.type)} → ${w.columnType(c.to.type)}${narrows ? ' (narrows: values that do not fit are lost or refused)' : ''}`);
  if (c.nullable) parts.push(c.to.nullable ? 'allow empty values' : 'require a value');
  if (c.default) parts.push(c.to.default ? 'set the default' : 'remove the default');
  return `Change column ${c.to.name}: ${parts.join('; ')}.`;
}
