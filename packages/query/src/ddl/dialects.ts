/**
 * The DDL writers of the Postgres, SQLite and SQL Server dialects. Each changes
 * only what its database spells differently from the shared algorithm in
 * `writer.ts`; SQLite also rebuilds a table for a change `ALTER TABLE` cannot
 * make there.
 */
import type { ColumnDefault, ColumnSpec, ColumnType, TableSpec } from './table';
import { columnTypeWidens } from './table';
import {
  type ColumnChange,
  type DdlStep,
  type TableDiff,
  SqlDdl,
  decimalSpelling,
  readCommonType,
  splitNative,
} from './writer';

/** Postgres: native `text`, `jsonb`, `bytea`, identity columns, `ALTER COLUMN … TYPE … USING`. */
export class PostgresDdl extends SqlDdl {
  columnType(type: ColumnType): string {
    switch (type.kind) {
      case 'text':
        return type.maxLength === undefined ? 'text' : `varchar(${type.maxLength})`;
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
        return type.timezone === false ? 'timestamp' : 'timestamptz';
      case 'uuid':
        return 'uuid';
      case 'json':
        return 'jsonb';
      case 'bytes':
        return 'bytea';
      case 'other':
        return type.native;
    }
  }

  readColumnType(native: string): ColumnType {
    return readCommonType(native);
  }

  protected override alterColumn(table: TableSpec, c: ColumnChange): string[] {
    const out = super.alterColumn(table, c);
    if (!c.type) return out;
    // A type change names its conversion, so text → integer and the like convert instead of failing.
    const type = this.columnType(c.to.type);
    return out.map((s) => (s.endsWith(` TYPE ${type}`) ? `${s} USING ${this.q(c.to.name)}::${type}` : s));
  }
}

/** SQL Server: `[ident]`, `nvarchar`, `bit`, `IDENTITY(1,1)`, named default constraints, `ALTER COLUMN` with nullability. */
export class SqlServerDdl extends SqlDdl {
  columnType(type: ColumnType): string {
    switch (type.kind) {
      case 'text':
        return type.maxLength === undefined || type.maxLength > 4000 ? 'nvarchar(max)' : `nvarchar(${type.maxLength})`;
      case 'integer':
        return type.big ? 'bigint' : 'int';
      case 'decimal':
        return `decimal(${type.precision ?? 38},${type.scale ?? 10})`;
      case 'float':
        return 'float';
      case 'bool':
        return 'bit';
      case 'date':
        return 'date';
      case 'timestamp':
        return type.timezone === false ? 'datetime2' : 'datetimeoffset';
      case 'uuid':
        return 'uniqueidentifier';
      case 'json':
        return 'nvarchar(max)';
      case 'bytes':
        return 'varbinary(max)';
      case 'other':
        return type.native;
    }
  }

  readColumnType(native: string): ColumnType {
    const { name, args, max } = splitNative(native);
    if (/^n?varchar$/u.test(name) && max) return { kind: 'text' };
    // SQL Server reports nvarchar lengths in bytes through some catalog views; readers pass characters.
    if (name === 'bit') return { kind: 'bool' };
    if (name === 'float' && args[0] !== undefined && args[0] <= 24) return { kind: 'float' };
    return readCommonType(native);
  }

  protected override addColumnKeyword(): string {
    return 'ADD';
  }

  protected override generatedClause(): string {
    return 'IDENTITY(1,1)';
  }

  protected override literal(value: string | number | boolean | null): string {
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'string') return `N'${value.replace(/'/g, "''")}'`;
    return super.literal(value);
  }

  protected override defaultClause(table: TableSpec, c: ColumnSpec, d: ColumnDefault): string {
    return `CONSTRAINT ${this.q(c.defaultName ?? dfName(table.name, c.name))} DEFAULT ${this.defaultSql(d)}`;
  }

  protected override defaultSql(d: ColumnDefault): string {
    return d.kind === 'now' ? 'SYSDATETIMEOFFSET()' : super.defaultSql(d);
  }

  protected override alterColumn(table: TableSpec, c: ColumnChange): string[] {
    const name = this.tableName(table);
    const out: string[] = [];
    if (c.default && c.from.default) out.push(`ALTER TABLE ${name} DROP CONSTRAINT ${this.q(c.from.defaultName ?? dfName(table.name, c.from.name))}`);
    if (c.type || c.nullable) {
      out.push(`ALTER TABLE ${name} ALTER COLUMN ${this.q(c.to.name)} ${this.columnType(c.to.type)} ${c.to.nullable ? 'NULL' : 'NOT NULL'}`);
    }
    if (c.default && c.to.default) {
      out.push(`ALTER TABLE ${name} ADD CONSTRAINT ${this.q(dfName(table.name, c.to.name))} DEFAULT ${this.defaultSql(c.to.default)} FOR ${this.q(c.to.name)}`);
    }
    return out;
  }

  protected override planAlter(current: TableSpec, wanted: TableSpec, diff: TableDiff): DdlStep[] {
    // A dropped column's default constraint has to go before the column can.
    const steps = super.planAlter(current, wanted, diff);
    const defaults = diff.dropped.filter((c) => c.default);
    if (defaults.length === 0) return steps;
    const first = steps.findIndex((s) => s.action === 'drop-column');
    const drops = defaults.map((c) => this.dropConstraint(current, c.defaultName ?? dfName(current.name, c.name)));
    return [...steps.slice(0, first), ...drops, ...steps.slice(first)];
  }
}

/**
 * SQLite: types by affinity name, `INTEGER PRIMARY KEY AUTOINCREMENT` for a
 * generated key, `ADD COLUMN` / `DROP COLUMN` for plain columns, and a table
 * rebuild (create the new shape, copy the rows, drop, rename) for every other
 * change, since SQLite cannot alter a column or a constraint in place.
 */
export class SqliteDdl extends SqlDdl {
  columnType(type: ColumnType): string {
    switch (type.kind) {
      case 'text':
        return type.maxLength === undefined ? 'TEXT' : `VARCHAR(${type.maxLength})`;
      case 'integer':
        return type.big ? 'BIGINT' : 'INTEGER';
      case 'decimal':
        return decimalSpelling('NUMERIC', type);
      case 'float':
        return 'REAL';
      case 'bool':
        return 'BOOLEAN';
      case 'date':
        return 'DATE';
      case 'timestamp':
        return type.timezone === false ? 'DATETIME' : 'TIMESTAMPTZ';
      case 'uuid':
        return 'UUID';
      case 'json':
        return 'JSON';
      case 'bytes':
        return 'BLOB';
      case 'other':
        return type.native;
    }
  }

  readColumnType(native: string): ColumnType {
    // A column declared with no type has BLOB affinity and holds anything.
    if (native.trim() === '') return { kind: 'other', native: '' };
    const read = readCommonType(native);
    if (read.kind !== 'other') return read;
    // Unknown names follow SQLite's affinity rules.
    const up = native.toUpperCase();
    if (up.includes('INT')) return { kind: 'integer' };
    if (up.includes('CHAR') || up.includes('CLOB') || up.includes('TEXT')) return { kind: 'text' };
    if (up.includes('REAL') || up.includes('FLOA') || up.includes('DOUB')) return { kind: 'float' };
    return read;
  }

  protected override literal(value: string | number | boolean | null): string {
    if (typeof value === 'boolean') return value ? '1' : '0';
    return super.literal(value);
  }

  protected override columnDefinition(table: TableSpec, c: ColumnSpec): string {
    if (!this.isRowidKey(table, c)) return super.columnDefinition(table, c);
    return `${this.q(c.name)} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }

  protected override tableConstraints(table: TableSpec, owner: string): string[] {
    const rowid = table.columns.some((c) => this.isRowidKey(table, c));
    const all = super.tableConstraints(table, owner);
    return rowid ? all.filter((s) => !s.includes(' PRIMARY KEY (')) : all;
  }

  /** The one generated integer primary key, which SQLite spells inline as an alias of the rowid. */
  private isRowidKey(table: TableSpec, c: ColumnSpec): boolean {
    return c.generated === true && table.primaryKey.length === 1 && table.primaryKey[0] === c.name;
  }

  protected override planAlter(current: TableSpec, wanted: TableSpec, diff: TableDiff): DdlStep[] {
    const keyed = new Set([...wanted.primaryKey, ...current.primaryKey, ...wanted.unique.flatMap((u) => u.columns), ...current.unique.flatMap((u) => u.columns)]);
    const fkColumns = new Set([...current.foreignKeys, ...wanted.foreignKeys].flatMap((f) => f.columns));
    const constraintsSame =
      !diff.primaryKey &&
      diff.changed.length === 0 &&
      diff.foreignKeysDropped.length === 0 &&
      diff.uniqueAdded.length === 0 &&
      diff.uniqueDropped.length === 0 &&
      diff.foreignKeysAdded.every((f) => f.columns.every((col) => diff.added.some((a) => a.name === col)) && f.columns.length === 1);
    const plainAdds = diff.added.every((c) => !keyed.has(c.name) && !c.generated && (c.nullable || c.default !== undefined) && (c.default?.kind ?? 'value') !== 'now');
    const plainDrops = diff.dropped.every((c) => !keyed.has(c.name) && !fkColumns.has(c.name) && !c.values);
    if (constraintsSame && plainAdds && plainDrops) {
      const steps: DdlStep[] = [];
      for (const c of diff.dropped) {
        steps.push({
          action: 'drop-column',
          table: wanted.name,
          target: c.name,
          sql: [`ALTER TABLE ${this.tableName(current)} DROP COLUMN ${this.q(c.name)}`],
          irreversible: true,
          summary: `Drop column ${c.name} and its data.`,
        });
      }
      for (const c of diff.added) {
        const fk = wanted.foreignKeys.find((f) => f.columns[0] === c.name);
        const refs = fk ? ` REFERENCES ${this.q(fk.table)} (${this.list(fk.references)})` : '';
        const check = c.values ? ` ${this.checkClause(c)}` : '';
        steps.push({
          action: 'add-column',
          table: wanted.name,
          target: c.name,
          sql: [`ALTER TABLE ${this.tableName(wanted)} ADD COLUMN ${super.columnDefinition(wanted, c)}${check}${refs}`],
          irreversible: false,
          summary: `Add column ${c.name} (${this.columnType(c.type)}${c.nullable ? '' : ', required'}).`,
        });
      }
      return steps;
    }
    return [this.rebuild(current, wanted, diff)];
  }

  /** Make the wanted table beside the current one, copy the kept columns across, and swap it in. */
  private rebuild(current: TableSpec, wanted: TableSpec, diff: TableDiff): DdlStep {
    const temp: TableSpec = { ...wanted, name: `${wanted.name}__new` };
    const kept = wanted.columns.filter((c) => current.columns.some((h) => h.name === c.name)).map((c) => c.name);
    const narrows = diff.changed.some((c) => c.type && !columnTypeWidens(c.from.type, c.to.type));
    const what = [
      diff.added.length ? `add ${diff.added.map((c) => c.name).join(', ')}` : '',
      diff.dropped.length ? `drop ${diff.dropped.map((c) => c.name).join(', ')}` : '',
      diff.changed.length ? `change ${diff.changed.map((c) => c.to.name).join(', ')}` : '',
      diff.primaryKey ? 'change the primary key' : '',
      diff.foreignKeysAdded.length || diff.foreignKeysDropped.length ? 'change foreign keys' : '',
      diff.uniqueAdded.length || diff.uniqueDropped.length ? 'change unique keys' : '',
    ].filter((s) => s !== '');
    return {
      action: 'rebuild-table',
      table: wanted.name,
      sql: [
        'PRAGMA defer_foreign_keys = ON',
        // Constraint names follow the real table, not the stand-in.
        this.createSql(temp, wanted.name),
        `INSERT INTO ${this.tableName(temp)} (${this.list(kept)}) SELECT ${this.list(kept)} FROM ${this.tableName(current)}`,
        `DROP TABLE ${this.tableName(current)}`,
        `ALTER TABLE ${this.tableName(temp)} RENAME TO ${this.q(wanted.name)}`,
      ],
      irreversible: diff.dropped.length > 0 || narrows,
      summary: `Rebuild table ${wanted.name} to ${what.join('; ')} (SQLite copies the rows into a new table).`,
    };
  }
}

/** `df_<table>_<column>` (SQL Server default constraints). */
function dfName(table: string, column: string): string {
  return `df_${table}_${column}`;
}
