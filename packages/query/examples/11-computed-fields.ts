/**
 * Example 11 — Type backing: one conceptual `project` Type, MANY tables.
 *
 * This is the headline demonstration of the dev-side BACKING layer. The Type the
 * LLM sees (`projectTypeDef`) is a flat, friendly list of fields:
 *
 *     id · name · status · owner · ownerName · taskCount · totalHours ·
 *     budgetLabel · secretField · latestTaskTitle
 *
 * Behind the scenes a single `TypeBacking` wires each of those fields to its real
 * implementation — a real source table, an auto-joined owner, two aggregates over
 * a has-many, a per-mode money formatter, a field-level-security gate, and a
 * LATERAL sub-select — none of which leaks into the conceptual schema. The SAME
 * definition runs IN-MEMORY (`engine.run`) and emits SQL (`engine.toSQL`), so the
 * conceptual model stays simple while the data model is arbitrarily rich:
 *
 *   - `name` / `status`     — plain STORED columns (zero overhead).
 *   - source table          — `TypeBacking.name = 'projects'` ⇒ `FROM "projects"
 *                             AS "project"`; references still use the Type name.
 *   - RLS (`access`)         — rows where `orgId = <currentOrg>`; applied in BOTH
 *                             `run` (drops rows on load) and `toSQL` (a WHERE).
 *   - `ownerName`           — a COMPUTE that reads a named RELATION join to `user`
 *                             (auto-join; dual `expr` ⇒ same value in run + SQL).
 *   - `taskCount`/`totalHours` — two COMPUTES that share ONE named LATERAL join
 *                             aggregating `tasks` (count + sum) ⇒ the join is
 *                             planned ONCE (dedup), referenced by both fields.
 *   - `budgetLabel`         — a COMPUTE with BOTH `sql` and `run` overrides, so
 *                             each mode formats the money its own way.
 *   - `secretField`         — FLS: an `access` predicate ⇒ `CASE WHEN … THEN
 *                             value ELSE NULL` in SQL, nulled in memory.
 *   - `latestTaskTitle`     — a named LATERAL join (`pick`ed column) selecting the
 *                             most-recent task per project; `LEFT JOIN LATERAL`.
 *
 * `orgId` (the RLS key) is deliberately NOT a conceptual field — it lives only in
 * the data + the backing predicate, showing how backing hides complexity.
 */
import {
  createRegistry,
  QueryEngine,
  arrayExecutor,
  joinAlias,
  Value,
  SqlText,
  type TypeDef,
  type SelectDef,
  type ExprDef,
  type TypeBacking,
  type SourceRecord,
} from '../src/index';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { ExampleReport } from './_util';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read + parse one bundled JSON dataset file. */
function loadRows(file: string): SourceRecord[] {
  const parsed: unknown = JSON.parse(readFileSync(join(HERE, 'data', file), 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} is not a JSON array.`);
  return parsed;
}

// ─── Tiny expr-JSON builders (the developer's backing exprs) ─────────────────
const ref = (source: string, field: string): ExprDef => ({ kind: 'field-ref', source, field });
const lit = (value: string | number): ExprDef => ({ kind: 'literal', value });
const cmp = (op: '=' | '<>', left: ExprDef, right: ExprDef): ExprDef => ({ kind: 'comparison', op, left, right });

/**
 * The CONCEPTUAL `project` Type — exactly what the LLM is shown. It is a simple
 * flat list; nothing here hints at the joins/aggregates/security underneath.
 */
const projectTypeDef: TypeDef = {
  name: 'project',
  label: 'Project',
  description: 'A unit of work owned by a user.',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
    { name: 'status', type: { kind: 'text' } },
    // The structural belongs-to relation (FK stored under `owner`).
    { name: 'owner', type: { kind: 'relation', to: 'user', count: 1 } },
    // Everything below is BACKED — computed / joined / gated behind the scenes.
    { name: 'ownerName', type: { kind: 'text' }, nullable: true },
    { name: 'taskCount', type: { kind: 'number', whole: true }, nullable: true },
    { name: 'totalHours', type: { kind: 'number', whole: true }, nullable: true },
    { name: 'budgetLabel', type: { kind: 'text' } },
    { name: 'secretField', type: { kind: 'text' }, nullable: true },
    { name: 'latestTaskTitle', type: { kind: 'text' }, nullable: true },
  ],
  indexes: [{ exprs: [{ expr: ref('project', 'id'), count: 1 }] }],
  count: 500,
  bytes: 96,
};

/** A minimal `user` Type (the owner-relation target). */
const userTypeDef: TypeDef = {
  name: 'user',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: ref('user', 'id'), count: 1 }] }],
  count: 1000,
  bytes: 48,
};

/** A minimal `task` Type (the aggregate + lateral source). */
const taskTypeDef: TypeDef = {
  name: 'task',
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'projectId', type: { kind: 'number', whole: true } },
    { name: 'title', type: { kind: 'text' } },
    { name: 'hours', type: { kind: 'number', whole: true } },
    { name: 'doneAt', type: { kind: 'text' } },
  ],
  indexes: [{ exprs: [{ expr: ref('task', 'id'), count: 1 }] }],
  count: 5000,
  bytes: 48,
};

export async function run(): Promise<ExampleReport> {
  const output: string[] = [];
  let errors = 0;

  // The RLS "current org" the request runs under — supplied by the app, not the
  // LLM. Only org 1's projects are ever visible.
  const currentOrg = 1;

  const registry = createRegistry();
  const project = registry.parseType(projectTypeDef);
  registry.registerType(registry.parseType(userTypeDef));
  registry.registerType(registry.parseType(taskTypeDef));

  // ── The backing: all the hidden complexity for `project`, in ONE place ──────
  const backing: TypeBacking = {
    // The real source table; SQL emits `FROM "projects" AS "project"`.
    name: 'projects',

    // ROW-LEVEL SECURITY: every `project` occurrence is filtered to the current
    // org. Dual `expr` ⇒ a runtime row filter AND a SQL WHERE. `orgId` is not a
    // conceptual field — it lives only here + in the data.
    access: {
      expr: () => registry.parseExpr(cmp('=', ref('project', 'orgId'), lit(currentOrg))),
    },

    // Named hidden joins — each added to a query ONCE, and only if a referenced
    // field opts in (`FieldBacking.joins`).
    joins: {
      // (a) A RELATION join to the owning `user` (belongs-to `owner`).
      owner: {
        expr: (alias) => ({ kind: 'relation', source: alias, relation: 'owner' }),
      },
      // (b) A LATERAL aggregate over this project's `tasks` — count + sum in one
      //     correlated sub-select. Shared by `taskCount` AND `totalHours`, so the
      //     planner emits it ONCE.
      taskStats: {
        expr: () => ({
          kind: 'lateral',
          joinType: 'left',
          query: (outer) => ({
            kind: 'select',
            fields: [
              { expr: { kind: 'aggregate', function: 'count', args: {} }, as: 'cnt' },
              { expr: { kind: 'aggregate', function: 'sum', args: { value: ref('task', 'hours') } }, as: 'hrs' },
            ],
            from: { kind: 'type', type: 'task' },
            where: [cmp('=', ref('task', 'projectId'), ref(outer, 'id'))],
          }),
        }),
      },
      // (c) A LATERAL sub-select for the most-recent task title (a `pick`ed col).
      latestTask: {
        expr: () => ({
          kind: 'lateral',
          pick: 'title',
          joinType: 'left',
          query: (outer) => ({
            kind: 'select',
            fields: [{ expr: ref('task', 'title'), as: 'title' }],
            from: { kind: 'type', type: 'task' },
            where: [cmp('=', ref('task', 'projectId'), ref(outer, 'id'))],
            order: [{ expr: ref('task', 'doneAt'), dir: 'desc' }],
            limit: 1,
          }),
        }),
      },
    },

    fields: {
      // ownerName: dual COMPUTE reading the auto-joined owner's name.
      ownerName: {
        joins: ['owner'],
        compute: { expr: () => registry.parseExpr(ref(joinAlias('project', 'owner'), 'name')) },
      },
      // taskCount / totalHours: two computes SHARING the single `taskStats` join.
      taskCount: {
        joins: ['taskStats'],
        compute: { expr: () => registry.parseExpr(ref(joinAlias('project', 'taskStats'), 'cnt')) },
      },
      totalHours: {
        joins: ['taskStats'],
        compute: { expr: () => registry.parseExpr(ref(joinAlias('project', 'taskStats'), 'hrs')) },
      },
      // budgetLabel: per-mode COMPUTE — `sql` formats in SQL, `run` in memory.
      budgetLabel: {
        compute: {
          sql: (alias, ctx) => SqlText.concat([SqlText.raw("'$' || "), ctx.dialect.field(alias, 'budget')]),
          run: (row) => {
            const budget = row['project']?.['budget'];
            const n = typeof budget === 'number' ? budget : 0;
            return Value.of(`$${n.toLocaleString('en-US')}`);
          },
        },
      },
      // secretField: FIELD-LEVEL SECURITY — visible only for `active` projects.
      // The stored column is `secret`; the gate nulls it otherwise.
      secretField: {
        name: 'secret',
        access: { expr: () => registry.parseExpr(cmp('=', ref('project', 'status'), lit('active'))) },
      },
      // latestTaskTitle: no `compute` ⇒ its value defaults to the lateral `pick`.
      latestTaskTitle: { joins: ['latestTask'] },
    },
  };

  // Register the Type WITH its backing — the JSON `TypeDef` above is untouched.
  registry.registerType(project, backing);
  registry.finalize();

  const engine = new QueryEngine(registry, {
    executors: {
      project: arrayExecutor(loadRows('projects.json')),
      user: arrayExecutor(loadRows('users.json')),
      task: arrayExecutor(loadRows('tasks.json')),
    },
  });

  // A plain SELECT over the SIMPLE conceptual fields — this is all a caller (or
  // the LLM) ever authors.
  const select: SelectDef = {
    kind: 'select',
    fields: [
      'id',
      'name',
      'status',
      'ownerName',
      'taskCount',
      'totalHours',
      'budgetLabel',
      'secretField',
      'latestTaskTitle',
    ].map((f) => ({ expr: ref('project', f), as: f })),
    from: { kind: 'type', type: 'project' },
    order: [{ expr: ref('project', 'id'), dir: 'asc' }],
  };

  errors += engine.validateQuery(select).list.filter((p) => p.severity === 'error').length;
  output.push(`validation errors: ${errors}`);

  // ── 1. RUN IN-MEMORY ────────────────────────────────────────────────────────
  // RLS drops org-2's "Draco"; FLS nulls "Borealis".secretField (archived);
  // computes/aggregates/laterals all resolve per row.
  const result = await engine.run(select);
  output.push(`\nrun() rows (RLS-filtered, FLS-nulled, computes resolved):`);
  for (const row of result.rows) output.push(`  ${JSON.stringify(row)}`);

  // ── 2. EMIT SQL (base + postgres) ────────────────────────────────────────────
  // Note in the output: `FROM "projects" AS "project"`, the single owner JOIN,
  // ONE `LATERAL` for taskStats (shared by taskCount + totalHours), another for
  // latestTask, the RLS `WHERE`, and the FLS `CASE WHEN … ELSE NULL`.
  const dialects: ReadonlyArray<'base' | 'postgres'> = ['base', 'postgres'];
  for (const dialect of dialects) {
    const { sql } = engine.toSQL(select, dialect);
    output.push(`\ntoSQL(${dialect}):`);
    output.push(`  ${sql}`);
  }

  return { title: 'Type backing — one conceptual Type, many tables', output, errors };
}
