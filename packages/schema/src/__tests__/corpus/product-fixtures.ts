/**
 * product-shaped types in a real @aeye/query registry, the session ctx and the
 * model-written query_set answers (shared by product.test.ts and the bench).
 */
import { createRegistry, type QueryDef, type Registry, type TypeDef } from '@aeye/query';
import { QUERY_SCHEMA_MAX_ENUM_SIZE_DEFAULT, QUERY_SET_EXAMPLES, COUNT_ROWS, type QuerySessionCtx } from './product';
import { catalogOf } from './query-fixtures';

// ============================================================================
// product-shaped types in a real registry
// ============================================================================

const T = { text: { kind: 'text' }, uuid: { kind: 'text', casing: 'exact' }, int: { kind: 'number', whole: true }, num: { kind: 'number' }, bool: { kind: 'bool' }, ts: { kind: 'timestamp' }, json: { kind: 'json' } } as const;
const READ_ONLY = { insertable: false, updatable: false, deletable: false } as const;
const f = (name: string, type: TypeDef['fields'][number]['type'], description: string, nullable = false) => ({ name, type, description, ...(nullable ? { nullable: true } : {}) });

// core/src/query-types.ts:613 fnUseType (read-only; admin-only + computed fields)
export const fnUse: TypeDef = {
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
export const user: TypeDef = {
  name: 'user', label: 'User', description: 'A person\'s account.', count: 1_000_000, bytes: 256, ...READ_ONLY,
  fields: [f('id', T.uuid, 'Stable unique identifier (UUID).'), f('email', T.text, 'The login email.'), f('role', T.text, 'Account role: user | admin.'), f('disabled', T.bool, 'Whether the account is disabled.')],
};
// query-filters.test.ts:134 taskTypeRow → toQueryType
export const task: TypeDef = {
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
export const project: TypeDef = { name: 'project', description: 'a project', count: 5, fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'name', type: { kind: 'text' } }] };
export const ticket: TypeDef = {
  name: 'ticket', description: 'a ticket on a project', count: 10, updatable: false, deletable: false,
  fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'title', type: { kind: 'text' } }, { name: 'project', type: { kind: 'relation', to: 'project', count: 1 } }],
};
// type-parse.test.ts:210 order (+ total for QUERY_SET_EXAMPLES)
export const order: TypeDef = { name: 'order', description: 'orders', count: 100, fields: [{ name: 'id', type: { kind: 'text' } }, { name: 'city', type: { kind: 'text' } }, { name: 'total', type: { kind: 'number' } }] };

export function sessionRegistry(types: readonly TypeDef[]): Registry {
  const registry = createRegistry();
  for (const t of types) registry.registerType(registry.parseType(t));
  registry.finalize();
  return registry;
}

export const ALL = [fnUse, user, task, project, ticket, order];
export const prefedRegistry = sessionRegistry(ALL);
export const prefed = catalogOf(prefedRegistry);
/** A progressive session that loaded only `task` and `order` (type_load). */
export const progressiveRegistry = sessionRegistry([task, order]);
export const progressive = catalogOf(progressiveRegistry);

export const ctx = (over: Partial<QuerySessionCtx> = {}): QuerySessionCtx => ({
  inQueryAgent: true, system: 'core', catalog: prefed, prefed: true, maxEnumSize: QUERY_SCHEMA_MAX_ENUM_SIZE_DEFAULT,
  systems: ['core', 'crm'], unloadedDbFns: ['jsonExtract'], usableLoaded: true, embedder: true, ...over,
});

// ============================================================================
// Model-written query_set values (product's examples + its tests' queries)
// ============================================================================

const ref = (source: string, field: string) => ({ kind: 'field-ref' as const, source, field });
export const ANSWERS: Record<string, QueryDef> = {
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
export const REJECTED: Record<string, unknown> = {
  insertReadOnly: { kind: 'insert', into: 'fn_use', rows: [{}] },
  updateNotUpdatable: { kind: 'update', type: 'ticket', set: { title: 'x' } },
  deleteNotDeletable: { kind: 'delete', from: 'user' },
  badClosedSet: { kind: 'insert', into: 'task', rows: [{ title: 'a', description: 'b', status: 'later', priority: 'high', archived: false }] },
  missingRequired: { kind: 'insert', into: 'task', rows: [{ title: 'a' }] },
  crossField: { kind: 'select', fields: [{ expr: ref('task', 'city') }], from: { kind: 'type', type: 'task' } },
  filtersCross: { kind: 'select', fields: [], from: { kind: 'type', type: 'task' }, where: [{ kind: 'filters', source: 'task', fields: ['city'] }] },
  unknownType: { kind: 'select', fields: [], from: { kind: 'type', type: 'invoice' } },
};
