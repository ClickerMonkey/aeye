/**
 * Runtime tests for harness-database.ts: tables as types (create_table's `typ<obj>`), the enricher's structured
 * answer, ResultData, and saved queries' computed args checked by `run_query`.
 */
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_STRICT, GOOGLE_OPENAPI, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, PEOPLE, XAI_STRICT, type Profile } from '../../index';
import { asTool, clone, profileProblems } from './_check';
import { modelFnNames, type QualifiedName } from './harness-fns';
import type { ProgramSessionLike } from './harness-grammar';
import * as D from './harness-database';

const tool = <T>(bound: { render(p: Profile): T }, p: Profile): T => bound.render(asTool(p));
const session: ProgramSessionLike = { named: [{ name: 'database/main.tasks', def: { name: 'obj', props: { title: { type: { name: 'text' } } } } }] };

describe('create_table / alter_table (shapes.ts:261): the row type as gin `typ<obj>`', () => {
  const args = D.TableArgs.bind(session);
  /** shared/index.ts:414 create_table's example, and an alter with a named type and an enum column. */
  const samples = [
    { table: 'notes', type: { name: 'obj' as const, props: { id: { type: { name: 'num' as const, options: { whole: true } } }, text: { type: { name: 'text' as const } }, due: { type: { name: 'optional' as const, generic: { T: { name: 'date' as const } } } } } } },
    { table: 'invoices', database: 'billing', type: { name: 'obj' as const, docs: 'One per sale.', props: { status: { type: { name: 'enum' as const, options: { values: { open: 'open', paid: 'paid' } } }, docs: 'Where it stands.' }, task: { type: { name: 'database/main.tasks' } } } } },
  ];

  it('renders and round-trips on every profile; the example in each model\'s shape', () => {
    expect(profileProblems(args, samples)).toEqual([]);
    // OpenAI strict: props (a record) as pairs; Gemini's JSON Schema mode: an open object
    expect(tool(args, OPENAI_STRICT).jsonSchema['description']).toContain('"type":{"name":"obj","docs":null,"props":[{"key":"id","value":{"type":');
    // Gemini (guarded recursion): a TypeDef recurring through a required field is JSON text, named types described once
    const gemini = tool(args, GOOGLE_STRICT).jsonSchema['description'] as string;
    expect(gemini).toContain('Example: {"table":"notes","type":{"name":"obj","props":{"id":{"type":{"name":"num","options":{"whole":true}}},"text":{"type":{"name":"text"}},"due":{"type":{"name":"optional","generic":{"T":"{\\"name\\":\\"date\\"}"}}}}}}');
    expect(gemini).toContain('Named types used by the fields written as JSON text:\ntype TypeDef = ');
  });

  it('decodes a model\'s table and refuses a type that is not an obj, where it was written', () => {
    const answer = { table: 'notes', type: { name: 'obj', props: [{ key: 'text', value: { type: { name: 'text', docs: null, options: null }, docs: null } }] }, database: null };
    const res = tool(args, OPENAI_STRICT).parse(answer);
    expect(res.ok && res.value).toEqual({ table: 'notes', type: { name: 'obj', props: { text: { type: { name: 'text' } } } } });
    const list = tool(args, XAI_STRICT).parse({ table: 'notes', type: { name: 'list', generic: { V: { name: 'text' } } } });
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.issues[0]?.path).toEqual(['type', 'name']);
    const named = tool(args, XAI_STRICT).parse({ table: 'bad name', type: { name: 'obj', props: { x: { type: { name: 'crm/Unknown' } } } } });
    expect(named.ok).toBe(false);
    if (!named.ok) expect(named.issues.map((i) => i.path[0])).toEqual(['table', 'type']);
  });
});

describe('the enricher\'s answer (server/types.ts:57, author.ts:38 `llm.object({ output: ginAs(EnrichmentAnswer) })`)', () => {
  const answer = {
    description: 'One row per task someone has to do.',
    columns: [
      { column: 'status', description: 'Where the task stands.', values: ['open', 'done'] },
      { column: 'estimate', min: 0, max: 40, examples: ['2', '8'] },
      { column: 'email', format: 'email' as const },
    ],
  };

  it('renders and round-trips as an output on every profile', () => {
    expect(profileProblems(D.EnrichmentAnswer, [answer, { description: 'Empty.', columns: [] }], { tool: false })).toEqual([]);
    expect(profileProblems(D.TableEnrichment, [D.enrichmentOf(answer, new Set(['status', 'estimate']))], { tool: false })).toEqual([]);
  });

  it('a strict answer decodes in place; the kept shape (a record by column) is what code keeps', () => {
    const entry = ModelProfile.of(OPENAI_STRICT).request([{ kind: 'output', schema: D.EnrichmentAnswer }]).get('output');
    expect(entry.strict).toBe(true);
    const wire = JSON.stringify({
      description: 'One row per task.', columns: [{ column: 'status', description: null, values: ['open', 'done'], format: null, min: null, max: null, examples: null }],
    });
    const res = entry.parseText(wire);
    expect(res.ok && res.value).toEqual({ description: 'One row per task.', columns: [{ column: 'status', values: ['open', 'done'] }] });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 5, parsed: 0, repaired: 0 });
    expect(res.ok && D.enrichmentOf(res.value, new Set(['status']))).toEqual({ description: 'One row per task.', columns: { status: { values: ['open', 'done'] } } });
    // Claude: optionals left out, `values`' 40-cap said in words
    const claude = ModelProfile.of(ANTHROPIC_STRICT).request([{ kind: 'output', schema: D.EnrichmentAnswer }]).get('output');
    expect(claude.jsonSchema).toMatchObject({ properties: { columns: { items: { properties: { values: { type: 'array', description: expect.stringContaining('At most 40 items.') } } } } } });
  });

  it('refuses what the schema refuses, where the model wrote it', () => {
    const res = D.EnrichmentAnswer.render(GOOGLE_STRICT).parse({ description: '', columns: [{ column: 'status', values: [], format: 'zip' }] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((i) => [i.path, i.message])).toEqual([
        [['description'], 'Must be at least 1 characters.'],
        [['columns', 0, 'values'], 'Must have at least 1 items.'],
        [['columns', 0, 'format'], 'Expected one of: email, url, uuid, phone, iso-date, country-code, currency-code.'],
      ]);
    }
  });
});

describe('ResultData (core/src/registries.ts:210)', () => {
  const data = D.ResultData.bind(session);
  /** sdk widgets.test.ts:33 TABLE, as a result */
  const table = {
    columns: [
      { name: 'owner', kind: 'text' as const, nullable: false, type: { name: 'enum' as const, options: { values: { ann: 'ann', bo: 'bo' } } } },
      { name: 'open', kind: 'integer' as const, nullable: false, type: { name: 'num' as const, options: { min: 0, max: 100 } } },
      { name: 'id', kind: 'uuid' as const, nullable: false, ref: 'tasks/Task' as QualifiedName },
    ],
    rows: [['ann', 3, '6f1c7c1e-0000-4000-8000-000000000001'], ['bo', 5, '6f1c7c1e-0000-4000-8000-000000000002']],
    offset: 0, truncated: false, sort: [],
    drill: { fn: 'database/main.orders_by_status' as QualifiedName, args: {}, keys: ['owner'] },
  };

  it('renders and round-trips on every profile (rows of any JSON, a column\'s gin type)', () => {
    expect(profileProblems(data, [table, { ...table, rows: [], total: 0, limit: 50, write: { affected: 2 }, sort: [{ column: 'open', dir: 'desc' as const }] }], { tool: false })).toEqual([]);
    expect(D.ResultData.bind(session).render(GOOGLE_OPENAPI).jsonSchema['$defs']).toBeUndefined();
  });

  it('people see it in the code shape; a model\'s copy writes rows\' cells as JSON text on strict dialects', () => {
    expect(data.render(PEOPLE).parse(clone(table)).ok).toBe(true);
    const wire = data.render(OPENAI_STRICT).encode(table) as { rows: unknown[][] };
    expect(wire.rows[0]).toEqual(['"ann"', '3', '"6f1c7c1e-0000-4000-8000-000000000001"']);
    const back = data.render(OPENAI_STRICT).parse(clone(wire));
    expect(back.ok && back.value).toEqual(table);
    expect(back.stats.parsed).toBe(6);
  });
});

describe('saved queries: args computed from the compiled query (compile.ts:199 argsTypeOf)', () => {
  /** database/main.orders_by_status: `status` compared with orders.status, a list, sortable by customer and total. */
  const ordersByStatus: D.SavedQuery = {
    compiled: {
      params: [{ name: 'status', type: { kind: 'text', values: [{ value: 'open' }, { value: 'paid' }] }, uses: [{ field: { type: 'database/main.orders', field: 'status' } }] }],
      list: true, columns: [{ name: 'customer' }, { name: 'total' }, { name: 'status' }], def: { kind: 'select' },
    },
    sorters: ['customer', 'total', 'missing'],
  };
  /** A generated table fn (table_fns_generate): `database/main.tasks_update`, its changes optional (`optional`). */
  const tasksUpdate: D.SavedQuery = {
    compiled: {
      params: [
        { name: 'id', type: { kind: 'number', whole: true, min: 1 }, uses: [{ field: { type: 'database/main.tasks', field: 'id' } }] },
        { name: 'title', type: { kind: 'text', minLength: 1 }, uses: [] },
        { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, uses: [] },
        { name: 'due', type: { kind: 'date' }, uses: [] },
      ],
      list: false, columns: [], def: { kind: 'update' },
    },
    sorters: [], optional: ['title', 'tags', 'due'],
  };
  const limits = { max: 500, page: 50 };
  const names = modelFnNames({ type: 'tools' });
  const ctx: D.SavedQueries = { names, limits, queries: new Map([['database/main.orders_by_status', ordersByStatus], ['database/main.tasks_update', tasksUpdate]]) };

  it('argsTypeOf: params, then paging and sorting (only sortable columns), docs from the column compared', () => {
    expect(D.argsTypeOf(ordersByStatus.compiled, ordersByStatus.sorters, limits)).toEqual({
      name: 'obj',
      props: {
        status: { type: { name: 'enum', generic: { V: { name: 'text' } }, options: { values: { open: 'open', paid: 'paid' } } }, docs: 'Compared with database/main.orders.status.' },
        limit: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 1, max: 500 } } } }, docs: 'How many rows (50 when empty).' },
        offset: { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 0 } } } }, docs: 'How many rows to skip, for the next page.' },
        sort: expect.objectContaining({ docs: 'Sort by these columns, in order (the query\'s own order when empty).' }),
      },
    });
  });

  it('the computed args render and round-trip on every profile (the run_query examples)', () => {
    const orders = D.savedQueryArgs(ordersByStatus, limits);
    expect(profileProblems(orders as never, [{ status: 'paid' }, { status: 'open', offset: 50, limit: 50, sort: [{ column: 'customer', dir: 'asc' }] }])).toEqual([]);
    expect(profileProblems(D.savedQueryArgs(tasksUpdate, limits) as never, [{ id: 3, title: 'Call back' }, { id: 3, tags: ['home'], due: '2026-11-24' }])).toEqual([]);
    expect(tool(orders as never as { render(p: Profile): { jsonSchema: Record<string, unknown> } }, OPENAI_STRICT).jsonSchema).toMatchObject({
      properties: {
        status: { type: 'string', enum: ['open', 'paid'], description: 'Compared with database/main.orders.status.' },
        sort: { anyOf: [{ type: 'array', items: { properties: { column: { enum: ['customer', 'total'] }, dir: { enum: ['asc', 'desc'] } } } }, { type: 'null' }] },
      },
    });
  });

  it('run_query, checked: the saved query\'s args checked as the model wrote them (compile.ts:226 argProblems)', () => {
    const run = D.CheckedRunQuery.bind(ctx);
    expect(profileProblems(run, [
      { fn: 'database/main.orders_by_status' as QualifiedName, args: { status: 'paid' } },
      { fn: 'database/main.tasks_update' as QualifiedName, args: { id: 3, due: '2026-11-24' } },
    ], { codecs: true })).toEqual([]);
    const ok = tool(run, XAI_STRICT).parse({ fn: 'database__main__orders_by_status', args: { status: 'open', offset: 50, limit: 50, sort: [{ column: 'customer', dir: 'asc' }] } });
    expect(ok.ok && ok.value).toEqual({ fn: 'database/main.orders_by_status', args: { status: 'open', offset: 50, limit: 50, sort: [{ column: 'customer', dir: 'asc' }] } });
    // argProblems' cases: a missing required param, a wrong choice, an unknown arg, a page too big
    for (const [args, path, message] of [
      [{}, ['args', 'status'], 'Required.'],
      [{ status: 'late' }, ['args', 'status'], 'Expected one of: open, paid.'],
      [{ status: 'paid', page: 2 }, ['args', 'page'], 'Unknown field "page".'],
      [{ status: 'paid', limit: 1000 }, ['args', 'limit'], 'Must be at most 500.'],
    ] as const) {
      const res = tool(run, ANTHROPIC_STRICT).parse({ fn: 'database__main__orders_by_status', args: JSON.stringify(args) });
      expect(res.ok, JSON.stringify(args)).toBe(false);
      if (!res.ok) expect(res.issues[0], JSON.stringify(args)).toMatchObject({ path, message });
    }
    // OpenAI strict: the dependent args are JSON text
    expect(tool(run, OPENAI_STRICT).jsonSchema).toMatchObject({ properties: { args: { type: 'string', description: expect.stringContaining('Its type is given by "fn".') } } });
  });
});
