/**
 * product's query kind in `a` (corpus/product.ts), over a REAL @aeye/query
 * registry holding product-shaped types: a read-only core type with
 * admin-only and computed fields (query-types.ts `fn_use`, `user`), business
 * types as `toQueryType` derives them (query-filters.test.ts `task`,
 * query-autocrud.test.ts `ticket` → `project`, type-parse.test.ts `order`).
 * query_set is checked value-for-value against product's own call,
 * `buildSchemas(engine, { strict: true, maxEnumSize })`.
 */
import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';
import { buildSchemas, createRegistry, type QueryDef, type Registry, type TypeDef } from '@aeye/query';
import { ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, ModelProfile, OPENAI_STRICT, XAI_STRICT, type RequestItem } from '../../index';
import { asTool, clone, profileProblems } from './_check';
import {
  COUNT_ROWS, DbFnLoadArgs, FlowDeclineArgs, FlowFailuresArgs, FlowLoadArgs, FlowReuseArgs, FlowSearchArgs, IdentityReturnArgs, PopulateExpr,
  QUERY_SCHEMA_MAX_ENUM_SIZE_DEFAULT, QUERY_SET_EXAMPLES, QueryFnArgs, QuerySetArgs, QueryTestArgs, SearchArgs, SystemSetArgs, TypeComputeArgs,
  dbFnLoadApplicable, querySetApplicable, type QuerySessionCtx,
} from './product';
import { catalogOf } from './query-fixtures';

// ============================================================================
// product-shaped types in a real registry
// ============================================================================

const T = { text: { kind: 'text' }, uuid: { kind: 'text', casing: 'exact' }, int: { kind: 'number', whole: true }, num: { kind: 'number' }, bool: { kind: 'bool' }, ts: { kind: 'timestamp' }, json: { kind: 'json' } } as const;
const READ_ONLY = { insertable: false, updatable: false, deletable: false } as const;
const f = (name: string, type: TypeDef['fields'][number]['type'], description: string, nullable = false) => ({ name, type, description, ...(nullable ? { nullable: true } : {}) });

// core/src/query-types.ts:613 fnUseType (read-only; admin-only + computed fields)
const fnUse: TypeDef = {
  name: 'fn_use', label: 'Function run',
  description: 'One execution of a fn (the audit spine): its input/output, status, timing, and attempts.',
  count: 1_000_000, bytes: 2_048, ...READ_ONLY,
  fields: [
    f('id', T.uuid, 'Stable unique identifier (UUID).'),
    f('fnId', T.uuid, 'The fn that ran.'),
    f('messageId', T.uuid, 'The message that triggered the run (admin only).', true),
    f('status', T.text, 'Run status: queued | active | success | error | … .'),
    f('input', T.json, 'The validated input the fn ran on (secrets redacted).'),
    f('createdAt', T.ts, 'When the run was created.'),
    f('startedAt', T.ts, 'When execution began.', true),
    f('endedAt', T.ts, 'When execution ended.', true),
    f('attempts', T.int, 'Number of execution attempts.'),
    f('durationMs', T.num, 'Run duration in milliseconds (endedAt − startedAt).', true),
  ],
};
// query-types.ts:1166 userType (source table renamed, read-only)
const user: TypeDef = {
  name: 'user', label: 'User', description: 'A person\'s account.', count: 1_000_000, bytes: 256, ...READ_ONLY,
  fields: [f('id', T.uuid, 'Stable unique identifier (UUID).'), f('email', T.text, 'The login email.'), f('role', T.text, 'Account role: user | admin.'), f('disabled', T.bool, 'Whether the account is disabled.')],
};
// query-filters.test.ts:134 taskTypeRow → toQueryType
const task: TypeDef = {
  name: 'task', description: 'a stored task', count: 100,
  fields: [
    { name: 'title', type: { kind: 'text' } },
    { name: 'description', type: { kind: 'text' } },
    { name: 'status', type: { kind: 'text', values: [{ value: 'open' }, { value: 'done', label: 'Done' }] } },
    { name: 'due_date', type: { kind: 'timestamp' }, nullable: true },
    { name: 'priority', type: { kind: 'text', values: [{ value: 'high' }, { value: 'low' }] } },
    { name: 'code', type: { kind: 'text', maxLength: 12 }, nullable: true },
    { name: 'points', type: { kind: 'number' }, nullable: true },
    { name: 'archived', type: { kind: 'bool' } },
    { name: 'note', type: { kind: 'json' }, nullable: true },
  ],
};
// query-autocrud.test.ts:278 ticket → project (a relation); updatable/deletable off (query-extension-backfill.test.ts:307)
const project: TypeDef = { name: 'project', description: 'a project', count: 5, fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'name', type: { kind: 'text' } }] };
const ticket: TypeDef = {
  name: 'ticket', description: 'a ticket on a project', count: 10, updatable: false, deletable: false,
  fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'title', type: { kind: 'text' } }, { name: 'project', type: { kind: 'relation', to: 'project', count: 1 } }],
};
// type-parse.test.ts:210 order (+ total for QUERY_SET_EXAMPLES)
const order: TypeDef = { name: 'order', description: 'orders', count: 100, fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'city', type: { kind: 'text' } }, { name: 'total', type: { kind: 'number' } }] };

function sessionRegistry(types: readonly TypeDef[]): Registry {
  const registry = createRegistry();
  for (const t of types) registry.registerType(registry.parseType(t));
  registry.finalize();
  return registry;
}

const ALL = [fnUse, user, task, project, ticket, order];
const prefedRegistry = sessionRegistry(ALL);
const prefed = catalogOf(prefedRegistry);
/** A progressive session that loaded only `task` and `order` (type_load). */
const progressiveRegistry = sessionRegistry([task, order]);
const progressive = catalogOf(progressiveRegistry);

const ctx = (over: Partial<QuerySessionCtx> = {}): QuerySessionCtx => ({
  inQueryAgent: true, system: 'core', catalog: prefed, prefed: true, maxEnumSize: QUERY_SCHEMA_MAX_ENUM_SIZE_DEFAULT,
  systems: ['core', 'crm'], unloadedDbFns: ['jsonExtract'], usableLoaded: true, embedder: true, ...over,
});

// ============================================================================
// Model-written query_set values (product's examples + its tests' queries)
// ============================================================================

const ref = (source: string, field: string) => ({ kind: 'field-ref' as const, source, field });
const ANSWERS: Record<string, QueryDef> = {
  example0: QUERY_SET_EXAMPLES[0]!.value,
  example1: QUERY_SET_EXAMPLES[1]!.value,
  example2: QUERY_SET_EXAMPLES[2]!.value,
  // catalog-language-guides.ts:78 SELECT_GROUP_COUNT_EXAMPLE
  groupCount: {
    kind: 'select',
    fields: [{ expr: ref('task', 'status') }, { expr: COUNT_ROWS, as: 'count' }],
    from: { kind: 'type', type: 'task' },
    groupBy: [ref('task', 'status')],
    order: [{ expr: COUNT_ROWS, dir: 'desc' }],
  },
  // query-filters.test.ts:411 a top-level filters placeholder, then nested
  filters: { kind: 'select', from: { kind: 'type', type: 'task' }, fields: ['status', 'priority'].map((field) => ({ expr: ref('task', field) })), where: [{ kind: 'filters', source: 'task', fields: ['priority'] }] },
  nestedFilters: { kind: 'select', from: { kind: 'type', type: 'task' }, fields: [{ expr: ref('task', 'status') }], where: [{ kind: 'logical', op: 'and', operands: [{ kind: 'filters', source: 'task', fields: ['priority'] }] }] },
  // query-relation-fns.test.ts:832 a relation join (paired refs name the type, not the alias)
  join: { kind: 'select', fields: [{ expr: ref('ticket', 'title') }], from: { kind: 'type', type: 'ticket' }, joins: [{ on: { kind: 'relation', source: 'ticket', field: 'project', as: 'project__p' }, joinType: 'left' }] },
  // query-signature.test.ts:181 TASK_INSERT_TEMPLATE (params into every row cell)
  insert: { kind: 'insert', into: 'task', rows: [{ title: { kind: 'param', name: 'title' }, description: { kind: 'param', name: 'description' }, status: { kind: 'param', name: 'status' }, due_date: { kind: 'param', name: 'due_date' }, priority: { kind: 'param', name: 'priority' }, archived: false }] },
  // typed write values: a closed-set member and a timestamp
  insertValues: { kind: 'insert', into: 'task', rows: [{ title: 'Ship', description: 'v1', status: 'open', priority: 'high', archived: false, due_date: '2026-12-01 09:00' }] },
  // query-signature.test.ts:237 an UPDATE with logical OR / is-null / a param
  update: { kind: 'update', type: 'task', set: { status: 'done' }, where: [{ kind: 'logical', op: 'or', operands: [{ kind: 'is-null', value: ref('task', 'due_date') }, { kind: 'comparison', op: '=', left: ref('task', 'title'), right: { kind: 'param', name: 'emptyString' } }] }] },
  // query-signature.test.ts:213 a delete addressed by a param
  delete: { kind: 'delete', from: 'task', where: [{ kind: 'comparison', op: '=', left: ref('task', 'title'), right: { kind: 'param', name: 'title' } }] },
  // the read-only core type, admin-only field included (RLS/FLS is at run time, not in the schema)
  fnUse: { kind: 'select', fields: [{ expr: ref('fn_use', 'messageId') }, { expr: ref('fn_use', 'durationMs') }], from: { kind: 'type', type: 'fn_use' }, where: [{ kind: 'comparison', op: '>', left: ref('fn_use', 'attempts'), right: { kind: 'literal', value: 1 } }] },
};
const REJECTED: Record<string, unknown> = {
  insertReadOnly: { kind: 'insert', into: 'fn_use', rows: [{}] },
  updateNotUpdatable: { kind: 'update', type: 'ticket', set: { title: 'x' } },
  deleteNotDeletable: { kind: 'delete', from: 'user' },
  badClosedSet: { kind: 'insert', into: 'task', rows: [{ title: 'a', description: 'b', status: 'later', priority: 'high', archived: false }] },
  missingRequired: { kind: 'insert', into: 'task', rows: [{ title: 'a' }] },
  crossField: { kind: 'select', fields: [{ expr: ref('task', 'city') }], from: { kind: 'type', type: 'task' } },
  filtersCross: { kind: 'select', fields: [], from: { kind: 'type', type: 'task' }, where: [{ kind: 'filters', source: 'task', fields: ['city'] }] },
  unknownType: { kind: 'select', fields: [], from: { kind: 'type', type: 'invoice' } },
};

// ============================================================================

describe('product query_set: same verdicts as product\'s buildSchemas(engine, { strict: true, maxEnumSize })', () => {
  for (const [label, registry, cat] of [['prefed', prefedRegistry, prefed], ['progressive', progressiveRegistry, progressive]] as const) {
    for (const maxEnumSize of [QUERY_SCHEMA_MAX_ENUM_SIZE_DEFAULT, 3, 1]) {
      it(`${label} catalog, maxEnumSize ${maxEnumSize}`, () => {
        const real = buildSchemas(registry, { strict: true, maxEnumSize });
        const port = QuerySetArgs.render(LENIENT, ctx({ catalog: cat, maxEnumSize }));
        const out: string[] = [];
        for (const [n, v] of Object.entries({ ...ANSWERS, ...REJECTED })) {
          const zod = real.Query.safeParse(clone(v)).success;
          const ours = port.parse({ value: clone(v) });
          if (zod !== ours.ok) out.push(`${n}: zod ${zod}, a ${ours.ok}${ours.ok ? '' : `\n${ours.message}`}`);
        }
        expect(out).toEqual([]);
      });
    }
  }

  it('the answers are accepted on the prefed catalog at the default budget; the wrong ones are not', () => {
    const r = QuerySetArgs.render(LENIENT, ctx());
    for (const [n, v] of Object.entries(ANSWERS)) expect([n, r.parse({ value: clone(v) }).ok]).toEqual([n, true]);
    for (const [n, v] of Object.entries(REJECTED)) expect([n, r.parse({ value: clone(v) }).ok]).toEqual([n, false]);
  });

  it('core.test.ts:5160 — maxEnumSize 1 degrades from.type to a free string', () => {
    const js = QuerySetArgs.render(LENIENT, ctx({ maxEnumSize: 1 })).jsonSchema as any;
    const typeSource = js.$defs.Source.anyOf[0];
    expect(typeSource.properties.type).toEqual({ type: 'string', description: 'A Type name.' });
    const paired = QuerySetArgs.render(LENIENT, ctx()).jsonSchema as any;
    expect(paired.$defs.Source.anyOf[0].properties.type.enum).toEqual(['fn_use', 'user', 'task', 'project', 'ticket', 'order']);
  });

  it('progressive disclosure: only the loaded types are offered; a load is a new catalog version (new bind), a re-read is cached', () => {
    const c = ctx({ catalog: progressive, prefed: false });
    const r = QuerySetArgs.render(asTool(OPENAI_STRICT), c);
    const res = r.parse({ value: { kind: 'select', distinct: null, fields: [], from: { kind: 'type', type: 'fn_use' }, joins: null, where: null, groupBy: null, having: null, order: null, limit: null, offset: null } });
    expect(!res.ok && res.issues.map((i) => [i.path, i.message])).toEqual([[['value', 'from', 'type'], 'Expected one of: task, order.']]);
    expect(QuerySetArgs.bind(c)).toBe(QuerySetArgs.bind({ ...c }));
    expect(QuerySetArgs.bind(c)).not.toBe(QuerySetArgs.bind(ctx({ catalog: catalogOf(sessionRegistry([task, order, user])), prefed: false })));
  });

  it('the tool is absent outside a query agent, with no system set, an empty engine, or nothing usable loaded', () => {
    expect(querySetApplicable(ctx())).toBe(true);
    expect(querySetApplicable(ctx({ inQueryAgent: false }))).toBe(false);
    expect(querySetApplicable(ctx({ system: undefined as never }))).toBe(false);
    expect(querySetApplicable(ctx({ catalog: { ...prefed, types: [] } }))).toBe(false);
    expect(querySetApplicable(ctx({ prefed: false, usableLoaded: false }))).toBe(false);
    expect([dbFnLoadApplicable(ctx()), dbFnLoadApplicable(ctx({ unloadedDbFns: [] }))]).toEqual([true, false]);
  });
});

describe('product query_set: rendering, answers, errors, encoding', () => {
  it('every profile family renders the tool and round-trips the answers', () => {
    expect(profileProblems(QuerySetArgs.bind(ctx()), Object.values(ANSWERS).map((value) => ({ value })))).toEqual([]);
    expect(profileProblems(QuerySetArgs.bind(ctx({ catalog: progressive, prefed: false })), QUERY_SET_EXAMPLES)).toEqual([]);
  });

  it('OpenAI strict: a model\'s typed insert (nulls for absent fields and options) decodes to product\'s QueryDef', () => {
    const r = QuerySetArgs.render(asTool(OPENAI_STRICT), ctx());
    const wire = { value: { kind: 'insert', into: 'task', rows: [{ title: 'Ship', description: 'v1', status: 'open', due_date: null, priority: 'high', code: null, points: 3, archived: false, note: { json: '{"tags":["x"]}' } }], select: null, returning: null, onConflict: null } };
    // (`note` is json: `toValueSchema() | Expr`; its JSON-text option is written {"json": "…"} so it can't pass for a plain string)
    const res = r.parse(wire);
    expect(res.ok && res.value).toEqual({ value: { kind: 'insert', into: 'task', rows: [{ title: 'Ship', description: 'v1', status: 'open', priority: 'high', points: 3, archived: false, note: { tags: ['x'] } }] } });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 6, parsed: 1, repaired: 0 });
    // a value outside the closed set: at the cell the model wrote
    const bad = r.parse({ value: { ...wire.value, rows: [{ ...wire.value.rows[0], status: 'later', note: null }] } });
    expect(!bad.ok && bad.issues[0]!.path).toEqual(['value', 'rows', 0, 'status']);
  });

  it('{{encode}} shows QUERY_SET_EXAMPLES in each model\'s shape', () => {
    const t = Handlebars.compile('{{#each examples}}{{encode this}}\n{{/each}}', { noEscape: true });
    const entry = (p: typeof OPENAI_STRICT) => ModelProfile.of(p).request([{ kind: 'tool', name: 'query_set', schema: QuerySetArgs.bind(ctx()) }]).get('query_set');
    // xAI: open records, but no recursive $defs — the nested exprs of a comparison are JSON text
    const grokEntry = entry(XAI_STRICT);
    const grok = t({ examples: QUERY_SET_EXAMPLES }, { helpers: grokEntry.helpers() }).trim().split('\n');
    expect(JSON.parse(grok[1]!).value.where[0].left).toBe('{"kind":"field-ref","source":"order","field":"city"}');
    expect(grok.map((l) => grokEntry.parseText(l)).map((r) => r.ok && r.value)).toEqual(QUERY_SET_EXAMPLES);
    const openai = t({ examples: QUERY_SET_EXAMPLES }, { helpers: entry(OPENAI_STRICT).helpers() }).trim().split('\n');
    expect(openai[0]).toContain('"joins":null');
    expect(entry(OPENAI_STRICT).encoder(QUERY_SET_EXAMPLES[2]!)).toContain('"args":{"value":null}'); // count(value?) typed: the optional param as null
  });
});

describe('product: the query agent\'s other tools', () => {
  it('query_test: args from the staged query (params, sorters, search roll-up)', () => {
    const staged = { version: 1, params: ['city', 'limit'], sorters: ['byTotal', 'byCity'], searchRollup: true };
    const r = QueryTestArgs.render(asTool(OPENAI_STRICT), staged);
    // query.ts:4055 QUERY_TEST_EXAMPLES: { input: { city: 'Rome' } }
    const res = r.parse({ input: { city: '"Rome"', limit: null }, sort: null, searchTerm: null });
    // every param is a REQUIRED JSON value (JSON text on OpenAI strict); a bare null is taken as the JSON null (a counted repair)
    expect(res.ok && res.value).toEqual({ input: { city: 'Rome', limit: null } });
    expect(res.stats).toEqual({ objects: 0, arrays: 0, edits: 3, parsed: 1, repaired: 1 });
    expect(r.parse({ input: null, sort: 'byName', searchTerm: null }).ok).toBe(false);
    expect(profileProblems(QueryTestArgs.bind(staged), [{ input: { city: 'Rome', limit: 10 } }, { sort: 'byCity', searchTerm: 'ada' }, {}])).toEqual([]);
    expect(Object.keys((QueryTestArgs.render(LENIENT, { version: 2, params: [], sorters: [], searchRollup: false }).jsonSchema.properties as object))).toEqual(['input']);
  });

  it('identity return (query_return): create mode states each derivation; edit mode does not', () => {
    const create = IdentityReturnArgs.render(asTool(OPENAI_STRICT), { mode: 'create', stated: 'top_cities' });
    const props = create.jsonSchema.properties as any;
    expect(props.name.description).toContain("Optional — omit to use 'top_cities'");
    expect(props.statuses.anyOf[0].properties.retry.properties.one.minLength).toBe(1);
    const res = create.parse({ name: null, description: null, query: 'cities by revenue', instructions: null, statuses: null, unredactedParts: null });
    expect(res.ok && res.value).toEqual({ query: 'cities by revenue' });
    const bad = create.parse({ name: '', description: null, query: null, instructions: null, statuses: { active: { one: 'Running', many: '' }, success: { one: 'a', many: 'b' }, retry: { one: 'a', many: 'b' }, failure: { one: 'a', many: 'b' } }, unredactedParts: null });
    expect(!bad.ok && bad.issues.map((i) => i.path)).toEqual([['name'], ['statuses', 'active', 'many']]);
    const edit = IdentityReturnArgs.render(LENIENT, { mode: 'edit' });
    expect((edit.jsonSchema.properties as any).name.description).toBeUndefined();
    const samples = [{}, { name: 'x', statuses: { active: { one: 'a', many: 'b' }, success: { one: 'a', many: 'b' }, retry: { one: 'a', many: 'b' }, failure: { one: 'a', many: 'b' } }, unredactedParts: ['all'] }];
    expect(profileProblems(IdentityReturnArgs.bind({ mode: 'create' }), samples)).toEqual([]);
    expect(profileProblems(IdentityReturnArgs.bind({ mode: 'edit' }), samples)).toEqual([]);
  });

  it('flow args: search (semantic only with an embedder), load, reuse, failures, decline (strict)', () => {
    expect(Object.keys((FlowSearchArgs.render(LENIENT, { embedder: true }).jsonSchema.properties as object))).toEqual(['query', 'semantic']);
    expect(Object.keys((FlowSearchArgs.render(LENIENT, { embedder: false }).jsonSchema.properties as object))).toEqual(['query']);
    // the gin `arg(..., example)` shows in the model's shape
    expect((FlowSearchArgs.render(asTool(OPENAI_STRICT), { embedder: true }).jsonSchema.properties as any).semantic.description).toContain('Example: 0.5');
    const decline = FlowDeclineArgs.render(asTool(ANTHROPIC_STRICT));
    expect(decline.parse({ reason: 'no revenue field', extra: 1 }).ok).toBe(false); // FlowDeclineSchema is strict
    expect((decline.jsonSchema.properties as any).examined.description).toContain('Example: ["order","order_line"]');
    expect(profileProblems(FlowDeclineArgs, [{ reason: 'r' }, { reason: 'r', examined: ['order'], needed: ['x'] }])).toEqual([]);
    expect(profileProblems(FlowSearchArgs.bind({ embedder: true }), [{ query: 'q' }, { query: 'q', semantic: 0.5 }])).toEqual([]);
    for (const [s, sample] of [[FlowLoadArgs, { name: 'top_cities' }], [FlowReuseArgs, { names: ['a'] }], [FlowFailuresArgs, { offset: 2 }], [SearchArgs, { query: 'q' }]] as const) {
      expect(profileProblems(s, [sample])).toEqual([]);
    }
    expect(FlowFailuresArgs.render(LENIENT).parse({ offset: 1.5 }).ok).toBe(false);
  });

  it('system_set / dbfn_load: enums from the session', () => {
    expect(SystemSetArgs.render(asTool(OPENAI_STRICT), ctx()).parse({ system: 'crm' }).ok).toBe(true);
    expect(SystemSetArgs.render(asTool(OPENAI_STRICT), ctx()).parse({ system: 'hr' }).ok).toBe(false);
    const load = DbFnLoadArgs.render(asTool(ANTHROPIC_STRICT), ctx());
    expect(load.parse({ names: [] }).ok).toBe(false); // .min(1), enforced although Anthropic only takes minItems 0/1 (1 is fine)
    expect((load.jsonSchema.properties as any).names.minItems).toBe(1);
    expect(profileProblems(DbFnLoadArgs.bind(ctx()), [{ names: ['jsonExtract'] }])).toEqual([]);
  });

  it('type_compute / populate: the OPEN expr over a bare registry', () => {
    const bare = catalogOf(createRegistry());
    const r = TypeComputeArgs.render(asTool(OPENAI_STRICT), bare);
    const sample = { type: 'task', name: 'isLate', description: 'past due', expr: { kind: 'comparison' as const, op: '<' as const, left: ref('task', 'due_date'), right: { kind: 'function-call' as const, function: 'now', args: {} } } };
    expect(r.parse(r.encode(sample)).ok).toBe(true);
    // loose on purpose: any source/field name (the target type may be another system's)
    expect(PopulateExpr.render(LENIENT, bare).parse(ref('crm:invoice', 'anything')).ok).toBe(true);
    // the same verdicts as product's `buildQuerySchemas(createQueryRegistry(), { strict: false }).Expr`
    const real = buildSchemas(createRegistry(), { strict: false }).Expr;
    for (const v of [sample.expr, ref('x', 'y'), { kind: 'nope' }, { kind: 'aggregate', function: 'whatever', args: { a: { kind: 'literal', value: [1] } } }]) {
      expect(PopulateExpr.render(LENIENT, bare).parse(clone(v)).ok).toBe(real.safeParse(clone(v)).success);
    }
    expect(profileProblems(TypeComputeArgs.bind(bare), [sample])).toEqual([]);
  });

  it('a finished query fn\'s own args (querySignature): params, optional window/filter args, sort enum, searchTerm', () => {
    const sig = {
      version: 'q1',
      params: [{ name: 'city', type: 'text' as const }, { name: 'limit', type: 'num' as const }, { name: 'offset', type: 'num' as const }, { name: '__writeOwner', type: 'text' as const }],
      windowArgs: ['limit', 'offset'],
      filters: [{ arg: 'status', type: 'text' as const }, { arg: 'city', type: 'text' as const }],
      sorters: ['byTotal'],
      searchTerm: true,
    };
    const r = QueryFnArgs.render(asTool(OPENAI_STRICT), sig);
    expect(Object.keys(r.jsonSchema.properties as object)).toEqual(['city', 'limit', 'offset', 'status', 'sort', 'searchTerm']);
    const res = r.parse({ city: 'Rome', limit: null, offset: null, status: 'open', sort: null, searchTerm: 'pizza' });
    expect(res.ok && res.value).toEqual({ city: 'Rome', status: 'open', searchTerm: 'pizza' });
    expect(profileProblems(QueryFnArgs.bind(sig), [{ city: 'Rome', searchTerm: 'x' }, { city: 'Rome', limit: 10, offset: 0, status: 'done', sort: 'byTotal', searchTerm: '' }])).toEqual([]);
  });
});

describe('product: the whole query-agent request', () => {
  const tools = (c: QuerySessionCtx): RequestItem[] => [
    { kind: 'tool', name: 'system_set', schema: SystemSetArgs.bind(c) },
    { kind: 'tool', name: 'dbfn_load', schema: DbFnLoadArgs.bind(c) },
    { kind: 'tool', name: 'query_set', schema: QuerySetArgs.bind(c) },
    { kind: 'tool', name: 'query_test', schema: QueryTestArgs.bind({ version: 1, params: ['city'], sorters: ['byTotal'], searchRollup: false }) },
    { kind: 'tool', name: 'query_return', schema: IdentityReturnArgs.bind({ mode: 'create' }) },
    { kind: 'tool', name: 'query_decline', schema: FlowDeclineArgs },
  ];

  it('OpenAI strict: every tool strict, nothing degraded', () => {
    const req = ModelProfile.of(OPENAI_STRICT).request(tools(ctx()));
    expect(req.entries.map((e) => [e.name, e.strict, e.adjustments.length])).toEqual(tools(ctx()).map((t) => [t.name, true, 0]));
  });

  it('Anthropic strict: the totals are shared — query_set takes the ladder, the small tools stay exact', () => {
    const req = ModelProfile.of(ANTHROPIC_STRICT).request(tools(ctx()));
    expect(req.problems).toEqual([]);
    expect(req.used.optional).toBeLessThanOrEqual(24);
    expect(req.used.unions).toBeLessThanOrEqual(16);
    const q = req.get('query_set');
    expect(q.adjustments.map((x) => x.kind)).toContain('depth-limited');
    expect(req.get('system_set').adjustments).toEqual([]);
    // decoding follows each entry's own rendering
    expect(q.parse(q.encode(QUERY_SET_EXAMPLES[1]!)).ok).toBe(true);
  });

  it('Gemini: renders (no strict budgets), enums under the 40 cap stay enums', () => {
    const req = ModelProfile.of(GOOGLE_STRICT).request(tools(ctx()));
    expect(req.problems).toEqual([]);
    expect(req.get('query_set').strict).toBe(true);
  });
});
