/**
 * Generated table fns, end to end on SQLite (`node:sqlite`): the list for a
 * schema with an enum, a number, a date, a unique column and foreign keys; the
 * projects/owners derived fields (counts, totals, enum splits, ranks, shares,
 * a depth-2 parent field); a refused ratio; idempotency; a schema change.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDialect } from '../sql/index';
import { queryArgProblems, withArgDefaults } from '../signature';
import { canCompare, ratio, tableFns, tableFnQuery, tableSchemaHash, TableFnError, TableFnSchema, type TableFn, type TableSpec } from '../ddl/index';
import type { JsonValue } from '../schema';

const owners: TableSpec = {
  name: 'owners',
  columns: [
    { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
    { name: 'name', type: { kind: 'text' }, nullable: false },
  ],
  primaryKey: ['id'],
  foreignKeys: [],
  unique: [],
};
const projects: TableSpec = {
  name: 'projects',
  columns: [
    { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
    { name: 'code', type: { kind: 'text' }, nullable: false },
    { name: 'status', type: { kind: 'text' }, nullable: false, values: ['active', 'done'], default: { kind: 'value', value: 'active' } },
    { name: 'value', type: { kind: 'decimal' }, nullable: true },
    { name: 'started', type: { kind: 'date' }, nullable: true },
    { name: 'owner', type: { kind: 'integer' }, nullable: false },
  ],
  primaryKey: ['id'],
  foreignKeys: [{ columns: ['owner'], table: 'owners', references: ['id'] }],
  unique: [{ columns: ['code'] }],
};
const tasks: TableSpec = {
  name: 'tasks',
  columns: [
    { name: 'id', type: { kind: 'integer' }, nullable: false, generated: true },
    { name: 'title', type: { kind: 'text' }, nullable: false },
    { name: 'project_id', type: { kind: 'integer' }, nullable: false },
  ],
  primaryKey: ['id'],
  foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
  unique: [],
};
const schema = [owners, projects, tasks];
const dialect = new SqliteDialect();

function seeded(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const t of schema) for (const sql of dialect.ddl.createTable(t).sql) db.exec(sql);
  db.exec(`INSERT INTO owners (name) VALUES ('Ann'), ('Bo')`);
  db.exec(`INSERT INTO projects (code, status, value, started, owner) VALUES
    ('a', 'active', 10, '2026-01-03', 1), ('b', 'done', 30, '2026-01-20', 1), ('c', 'done', 5, '2026-02-01', 2)`);
  db.exec(`INSERT INTO tasks (title, project_id) VALUES ('t1', 1), ('t2', 1), ('t3', 3)`);
  return db;
}

/** Run a fn's query with args; params left out bind NULL, as a caller's optional args do. */
function call(db: DatabaseSync, fn: TableFn, args: Record<string, JsonValue> = {}): Record<string, unknown>[] {
  const s = new TableFnSchema(schema);
  const params: Record<string, JsonValue> = {};
  const given = withArgDefaults(fn.args, args);
  for (const p of s.engine.parameters(fn.query)) params[p.name] = given[p.name] ?? null;
  const out = s.engine.toSQL(fn.query, 'sqlite', { params });
  return db.prepare(out.sql).all(...out.params).map((row) => ({ ...row }));
}

const byName = (list: readonly TableFn[], name: string): TableFn => {
  const fn = list.find((f) => f.name === name);
  if (!fn) throw new Error(`no fn ${name} in ${list.map((f) => f.name).join(', ')}`);
  return fn;
};

describe('generated table fns', () => {
  it('lists CRUD, column helpers and derived fields, the most useful first', () => {
    const list = tableFns('projects', schema, { cap: 500 });
    const names = list.fns.map((f) => f.name);
    expect(names.slice(0, 5)).toEqual(['selectPage', 'selectOne', 'create', 'selectByCode', 'update']);
    for (const name of ['remove', 'updateWhere', 'removeWhere', 'countByStatus', 'valueStats', 'startedPerMonth', 'existsByCode', 'findOrCreateByCode', 'countByOwner', 'tasksOfProject', 'taskCountPerProject', 'setOwner', 'taskCount', 'ownerName', 'ownerRelativeValueRank', 'shareOfOwnerTotalValue', 'ownerValuePosition', 'relativeValueRank', 'totalValue', 'ownerProjectAvgValue', 'ownerProjectStatusDoneTotalValue']) {
      expect(names).toContain(name);
    }
    expect(byName(list.fns, 'remove').mode).toBe('delete');
    expect(byName(list.fns, 'create').mode).toBe('write');
    expect(byName(list.fns, 'selectPage').signature).toContain('status?: "active" | "done"');
    const owner = tableFns('owners', schema, { cap: 500 }).fns.map((f) => f.name);
    for (const name of ['projectCount', 'projectAvgValue', 'projectTotalValue', 'projectStatusDoneAvgValue', 'projectMaxStarted']) expect(owner).toContain(name);
  });

  it('caps the list and counts the rest', () => {
    const list = tableFns('projects', schema, { cap: 10 });
    expect(list.fns).toHaveLength(10);
    expect(list.more).toBeGreaterThan(0);
  });

  it('computes the projects/owners derived fields in SQL', () => {
    const db = seeded();
    const owner = tableFns('owners', schema, { cap: 500 }).fns;
    expect(call(db, byName(owner, 'projectCount'))).toEqual([{ id: 1, name: 'Ann', projectCount: 2 }, { id: 2, name: 'Bo', projectCount: 1 }]);
    expect(call(db, byName(owner, 'projectTotalValue'), { id: 1 })).toEqual([{ id: 1, name: 'Ann', projectTotalValue: 40 }]);
    expect(call(db, byName(owner, 'projectStatusDoneAvgValue')).map((r) => r['projectStatusDoneAvgValue'])).toEqual([30, 5]);
    const project = tableFns('projects', schema, { cap: 500 }).fns;
    expect(call(db, byName(project, 'ownerRelativeValueRank')).map((r) => r['ownerRelativeValueRank'])).toEqual([2, 1, 1]);
    expect(call(db, byName(project, 'shareOfOwnerTotalValue')).map((r) => r['shareOfOwnerTotalValue'])).toEqual([0.25, 0.75, 1]);
    expect(call(db, byName(project, 'ownerValuePosition')).map((r) => r['ownerValuePosition'])).toEqual([0, 1, null]);
    expect(call(db, byName(project, 'shareOfTotalValue')).map((r) => r['shareOfTotalValue'])).toEqual([10 / 45, 30 / 45, 5 / 45]);
    expect(call(db, byName(project, 'ownerProjectAvgValue')).map((r) => r['ownerProjectAvgValue'])).toEqual([20, 20, 5]);
  });

  it('follows relations to the depth asked for', () => {
    const deep = tableFns('tasks', schema, { cap: 500 }).fns.map((f) => f.name);
    expect(deep).toContain('projectOwnerName');
    expect(deep).toContain('projectValue');
    const shallow = tableFns('tasks', schema, { cap: 500, depth: 1 }).fns.map((f) => f.name);
    expect(shallow).toContain('projectValue');
    expect(shallow).not.toContain('projectOwnerName');
    const db = seeded();
    expect(call(db, byName(tableFns('tasks', schema, { cap: 500 }).fns, 'projectOwnerName')).map((r) => r['projectOwnerName'])).toEqual(['Ann', 'Ann', 'Bo']);
  });

  it('refuses a ratio of different tables or columns', () => {
    const v = { kind: 'literal' as const, value: 1 };
    expect(canCompare({ table: 'projects', column: 'value' }, { table: 'projects', column: 'value' })).toBe(true);
    expect(canCompare({ table: 'projects', column: 'value' }, { table: 'owners', column: 'value' })).toBe(false);
    expect(() => ratio({ expr: v, table: 'projects', column: 'value' }, { expr: v, table: 'tasks', column: null })).toThrow(TableFnError);
    expect(() => tableFnQuery({ kind: 'derived', table: 'projects', derived: ['nope'] }, schema)).toThrow(TableFnError);
  });

  it('runs the CRUD and column fns on SQLite', () => {
    const db = seeded();
    const fns = tableFns('projects', schema, { cap: 500 }).fns;
    expect(call(db, byName(fns, 'selectPage'), { status: 'done' }).map((r) => r['code'])).toEqual(['b', 'c']);
    expect(call(db, byName(fns, 'selectByCode'), { code: 'c' })[0]?.['owner']).toBe(2);
    expect(call(db, byName(fns, 'countByStatus'))).toEqual([{ status: 'done', count: 2 }, { status: 'active', count: 1 }]);
    expect(call(db, byName(fns, 'valueStats'))).toEqual([{ count: 3, total: 45, avg: 15, min: 5, max: 30 }]);
    expect(call(db, byName(fns, 'startedPerMonth'))).toEqual([{ month: '2026-01-01', count: 2 }, { month: '2026-02-01', count: 1 }]);
    expect(call(db, byName(fns, 'existsByCode'), { code: 'a' })).toEqual([{ exists: 1 }]);
    const made = call(db, byName(fns, 'create'), { code: 'd', owner: 2 });
    expect(made[0]).toMatchObject({ code: 'd', status: 'active' });
    call(db, byName(fns, 'update'), { id: 4, setValue: 7 });
    expect(call(db, byName(fns, 'selectOne'), { id: 4 })[0]).toMatchObject({ value: 7, status: 'active' });
    expect(call(db, byName(fns, 'findOrCreateByCode'), { code: 'd', owner: 1 })[0]).toMatchObject({ id: 4 });
    call(db, byName(fns, 'remove'), { id: 4 });
    expect(call(db, byName(fns, 'selectPage')).length).toBe(3);
    expect(call(db, byName(tableFns('owners', schema, { cap: 500 }).fns, 'projectCountPerOwner'))[0]).toMatchObject({ name: 'Ann', projectCount: 2 });
  });

  it('adds derived columns to selectPage, to show, sort and filter on', () => {
    const db = seeded();
    const page = tableFnQuery({ kind: 'selectPage', table: 'projects', derived: ['shareOfOwnerTotalValue'] }, schema);
    expect(page.sorters).toContain('shareOfOwnerTotalValue');
    expect(call(db, page, { minShareOfOwnerTotalValue: 0.5 }).map((r) => r['code'])).toEqual(['b', 'c']);
  });

  it('checks call args against the signature: a missing required arg is refused', () => {
    const fns = tableFns('projects', schema, { cap: 500 }).fns;
    const one = byName(fns, 'selectOne');
    expect(queryArgProblems(one.args, {})).toEqual(['id is required: give a value for it.']);
    expect(queryArgProblems(one.args, { id: 1 })).toEqual([]);
    expect(queryArgProblems(byName(fns, 'selectPage').args, { status: 'gone' }).length).toBeGreaterThan(0);
  });

  it('is idempotent, and a schema change moves the hash and the fns', () => {
    expect(JSON.stringify(tableFns('projects', schema))).toBe(JSON.stringify(tableFns('projects', schema)));
    const hash = tableSchemaHash('projects', schema);
    const changed: TableSpec = { ...projects, columns: [...projects.columns, { name: 'budget', type: { kind: 'float' }, nullable: true }] };
    const next = [owners, changed, tasks];
    expect(tableSchemaHash('projects', next)).not.toBe(hash);
    expect(tableFns('projects', next, { cap: 500 }).fns.map((f) => f.name)).toContain('budgetStats');
    expect(tableFns('projects', schema, { cap: 500 }).fns.map((f) => f.name)).not.toContain('budgetStats');
  });
});
