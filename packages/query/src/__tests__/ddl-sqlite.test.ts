/**
 * DDL and the SQLite dialect against a real SQLite database (`node:sqlite`):
 * create tables from table shapes, read them back, plan no change for the same
 * shape, alter through ADD COLUMN and through a rebuild, run queries emitted by
 * the SQLite dialect over the tables as query Types, and map tables to gin
 * types and back.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createRegistry } from '../registry';
import { QueryEngine } from '../engine';
import type { QueryDef } from '../schema';
import { SqliteDialect } from '../sql/index';
import {
  type ColumnSpec,
  type TableSpec,
  type DdlStep,
  tableToGinType,
  ginTypeToTable,
  tableToQueryType,
  UUID_PATTERN,
} from '../ddl/index';

const customers: TableSpec = {
  name: 'customers',
  columns: [
    { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
    { name: 'name', type: { kind: 'text' }, nullable: false, comment: 'Full name.' },
    { name: 'email', type: { kind: 'text', maxLength: 120 }, nullable: true },
    { name: 'tier', type: { kind: 'text' }, nullable: false, values: ['free', 'pro'], default: { kind: 'value', value: 'free' } },
    { name: 'joined', type: { kind: 'timestamp', timezone: false }, nullable: true, default: { kind: 'now' } },
  ],
  primaryKey: ['id'],
  foreignKeys: [],
  unique: [{ columns: ['email'] }],
};

const orders: TableSpec = {
  name: 'orders',
  columns: [
    { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
    { name: 'customer_id', type: { kind: 'integer' }, nullable: false },
    { name: 'total', type: { kind: 'decimal', precision: 10, scale: 2 }, nullable: false },
    { name: 'paid', type: { kind: 'bool' }, nullable: false, default: { kind: 'value', value: false } },
  ],
  primaryKey: ['id'],
  foreignKeys: [{ columns: ['customer_id'], table: 'customers', references: ['id'] }],
  unique: [],
};

const dialect = new SqliteDialect();

/** A small SQLite schema reader (the database system has the real one). */
function readTable(db: DatabaseSync, name: string): TableSpec {
  const sql = String((db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) ?? {})['sql'] ?? '');
  const info = db.prepare(`PRAGMA table_info(${dialect.quoteIdent(name)})`).all();
  const columns: ColumnSpec[] = info.map((r) => {
    const col = String(r['name']);
    const c: ColumnSpec = { name: col, type: dialect.ddl.readColumnType(String(r['type'])), nullable: Number(r['notnull']) === 0 && Number(r['pk']) === 0 };
    const d = r['dflt_value'] === null ? undefined : dialect.ddl.readDefault(String(r['dflt_value']));
    if (d) c.default = d;
    if (Number(r['pk']) === 1 && /AUTOINCREMENT/iu.test(sql)) c.generated = true;
    const check = new RegExp(`CHECK \\("${col}" IN \\(([^)]*)\\)\\)`, 'u').exec(sql);
    if (check) c.values = (check[1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
    return c;
  });
  const primaryKey = info.filter((r) => Number(r['pk']) > 0).sort((a, b) => Number(a['pk']) - Number(b['pk'])).map((r) => String(r['name']));
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${dialect.quoteIdent(name)})`).all().map((r) => ({
    columns: [String(r['from'])],
    table: String(r['table']),
    references: [String(r['to'])],
  }));
  const unique = db
    .prepare(`PRAGMA index_list(${dialect.quoteIdent(name)})`)
    .all()
    .filter((r) => r['origin'] === 'u')
    .map((r) => ({ columns: db.prepare(`PRAGMA index_info(${dialect.quoteIdent(String(r['name']))})`).all().map((i) => String(i['name'])) }));
  return { name, columns, primaryKey, foreignKeys, unique };
}

function run(db: DatabaseSync, steps: readonly DdlStep[]): void {
  db.exec('BEGIN');
  for (const s of steps) for (const sql of s.sql) db.exec(sql);
  db.exec('COMMIT');
}

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  run(db, [dialect.ddl.createTable(customers), dialect.ddl.createTable(orders)]);
  return db;
}

describe('DDL on SQLite (real database)', () => {
  it('creates tables that read back as the same shape', () => {
    const db = fresh();
    expect(dialect.ddl.createTable(customers).sql[0]).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT');
    for (const t of [customers, orders]) expect(dialect.ddl.alterTable(readTable(db, t.name), t)).toEqual([]);
  });

  it('adds a plain column with ADD COLUMN, and rebuilds for a type change, keeping the rows', () => {
    const db = fresh();
    db.prepare(`INSERT INTO "customers" ("name", "email") VALUES (?, ?)`).run('Ada', 'ada@x.io');
    const added: TableSpec = { ...customers, columns: [...customers.columns, { name: 'notes', type: { kind: 'text' }, nullable: true }] };
    const add = dialect.ddl.alterTable(readTable(db, 'customers'), added);
    expect(add.map((s) => s.action)).toEqual(['add-column']);
    expect(add[0]?.irreversible).toBe(false);
    run(db, add);

    const narrowed: TableSpec = { ...added, columns: added.columns.map((c) => (c.name === 'email' ? { ...c, type: { kind: 'text', maxLength: 40 } } : c)) };
    const steps = dialect.ddl.alterTable(readTable(db, 'customers'), narrowed);
    expect(steps.map((s) => s.action)).toEqual(['rebuild-table']);
    expect(steps[0]?.irreversible).toBe(true);
    run(db, steps);
    expect(dialect.ddl.alterTable(readTable(db, 'customers'), narrowed)).toEqual([]);
    expect(db.prepare('SELECT "name", "tier" FROM "customers"').all()).toEqual([{ name: 'Ada', tier: 'free' }]);
  });

  it('drops a column as an irreversible step', () => {
    const db = fresh();
    const dropped: TableSpec = { ...orders, columns: orders.columns.filter((c) => c.name !== 'paid') };
    const steps = dialect.ddl.alterTable(readTable(db, 'orders'), dropped);
    expect(steps).toMatchObject([{ action: 'drop-column', target: 'paid', irreversible: true }]);
    run(db, steps);
    expect(readTable(db, 'orders').columns.map((c) => c.name)).toEqual(['id', 'customer_id', 'total']);
  });

  it('runs dialect SQL over the tables as query types', () => {
    const db = fresh();
    db.exec(`INSERT INTO "customers" ("name", "email", "tier") VALUES ('Ada', 'ada@x.io', 'pro'), ('Bob', NULL, 'free'), ('Abe', 'abe@x.io', 'free')`);
    db.exec(`INSERT INTO "orders" ("customer_id", "total", "paid") VALUES (1, 10.5, 1), (1, 3, 0), (2, 7, 1)`);
    const registry = createRegistry();
    for (const t of [customers, orders]) registry.registerType(registry.parseType(tableToQueryType(t, { tables: [customers, orders] })));
    registry.finalize();
    const engine = new QueryEngine(registry);
    const all = (q: QueryDef, params?: Record<string, string | number | boolean>) => {
      const out = engine.toSQL(q, 'sqlite', { includeTotal: true, ...(params ? { params } : {}) });
      return db.prepare(out.sql).all(...out.params);
    };
    const page = all({
      kind: 'select',
      fields: [{ expr: { kind: 'field-ref', source: 'customers', field: 'name' }, as: 'name' }],
      from: { kind: 'type', type: 'customers' },
      where: [{ kind: 'comparison', op: 'ilike', left: { kind: 'field-ref', source: 'customers', field: 'name' }, right: { kind: 'literal', value: 'a%' } }],
      order: [{ expr: { kind: 'field-ref', source: 'customers', field: 'email' }, dir: 'desc', nulls: 'last' }],
      offset: 1,
    });
    expect(page).toEqual([{ name: 'Abe', $total: 2 }]);
    const paid = all(
      {
        kind: 'select',
        fields: [{ expr: { kind: 'field-ref', source: 'orders', field: 'total' }, as: 'total' }],
        from: { kind: 'type', type: 'orders' },
        where: [{ kind: 'comparison', op: '=', left: { kind: 'field-ref', source: 'orders', field: 'paid' }, right: { kind: 'param', name: 'paid' } }],
        order: [{ expr: { kind: 'field-ref', source: 'orders', field: 'total' }, dir: 'asc' }],
        limit: 5,
      },
      { paid: true },
    );
    expect(paid).toEqual([{ total: 7, $total: 2 }, { total: 10.5, $total: 2 }]);
    const ins = engine.toSQL({ kind: 'insert', into: 'customers', rows: [{ name: { kind: 'literal', value: 'Cy' } }] }, 'sqlite');
    db.prepare(ins.sql).run(...ins.params);
    expect(db.prepare('SELECT COUNT(*) AS n FROM "customers"').get()).toEqual({ n: 4 });
  });
});

describe('tables as gin types', () => {
  it('gives a plain row type with nullable, enum, defaults and docs', () => {
    const t = tableToGinType(orders);
    expect(t.name).toBe('obj');
    expect(t.docs).toContain('Key: id.');
    expect(t.props?.['customer_id']).toEqual({ type: { name: 'num', options: { whole: true } }, docs: 'References customers.id.' });
    expect(t.props?.['total']?.type).toEqual({ name: 'num', options: { maxPrecision: 2 } });
    expect(t.props?.['paid']?.default).toEqual({ kind: 'new', type: { name: 'bool' }, value: false });
    const c = tableToGinType(customers);
    expect(c.props?.['email']?.type).toEqual({ name: 'nullable', generic: { T: { name: 'text', options: { maxLength: 120 } } } });
    expect(c.props?.['tier']?.type).toEqual({ name: 'enum', generic: { V: { name: 'text' } }, options: { values: { free: 'free', pro: 'pro' } } });
  });

  it('maps an enriched type back to the same table, and a real change to ALTER steps', () => {
    const gin = tableToGinType(customers);
    const props = { ...gin.props };
    props['email'] = { type: { name: 'nullable', generic: { T: { name: 'text', options: { maxLength: 120, pattern: '^[^@]+@[^@]+$' } } } }, docs: 'Work email.' };
    props['name'] = { type: { name: 'text', options: { minLength: 1 } }, docs: 'Full name as written.' };
    const enriched = { ...gin, props };
    expect(dialect.ddl.alterTable(customers, ginTypeToTable('customers', enriched, { current: customers }))).toEqual([]);
    props['email'] = { type: { name: 'nullable', generic: { T: { name: 'text', options: { maxLength: 255 } } } } };
    props['score'] = { type: { name: 'num', options: { whole: true } } };
    const steps = dialect.ddl.alterTable(customers, ginTypeToTable('customers', { ...gin, props }, { current: customers }));
    expect(steps.map((s) => s.action)).toEqual(['rebuild-table']);
    expect(steps[0]?.irreversible).toBe(false);
  });

  it('makes a new table from a type, with a generated id and a reference', () => {
    const table = ginTypeToTable(
      'invoices',
      {
        name: 'obj',
        props: {
          id: { type: { name: 'num', options: { whole: true } } },
          ref: { type: { name: 'text', options: { pattern: UUID_PATTERN } } },
          customer: { type: { name: 'shop.Customer' } },
          due: { type: { name: 'optional', generic: { T: { name: 'date' } } } },
        },
      },
      { resolveTable: (n) => (n === 'shop.Customer' ? customers : undefined) },
    );
    expect(table.primaryKey).toEqual(['id']);
    expect(table.columns).toEqual([
      { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
      { name: 'ref', type: { kind: 'uuid' }, nullable: false },
      { name: 'customer', type: { kind: 'integer' }, nullable: false },
      { name: 'due', type: { kind: 'date' }, nullable: true },
    ]);
    expect(table.foreignKeys).toEqual([{ columns: ['customer'], table: 'customers', references: ['id'] }]);
    const db = fresh();
    run(db, [dialect.ddl.createTable(table)]);
    expect(dialect.ddl.alterTable(readTable(db, 'invoices'), table)).toEqual([]);
  });
});
