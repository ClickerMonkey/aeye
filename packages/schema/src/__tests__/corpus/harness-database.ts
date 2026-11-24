/**
 * CORPUS: the database system (E:\GitHub\harness\systems\database), ported to `a`.
 *
 * Sources:
 * - shared/shapes.ts:261 `TableArgs` (create_table / alter_table: a table's row type as gin's `typ<obj>`,
 *   `GinObjTypeDef`) with create_table's example (shared/index.ts:414);
 * - server/types.ts:29-60 `ColumnEnrichment`, `TableEnrichment`, `EnrichmentAnswer` (the enricher's structured answer:
 *   columns as a LIST naming each column, "since a structured answer can't have keys of the model's choosing");
 * - core/src/registries.ts:170-230 `ResultColumn`, `ResultTable` (`ResultData = ginAs(ResultTable)`, a fn's result);
 * - server/compile.ts:160-213 `ginOfField` / `argsTypeOf`: a saved query's args computed from the compiled query
 *   (params, `limit`/`offset` for a list, `sort` over the sorters), and :226 `argProblems` (how `run_query` checks
 *   its any-JSON args against them).
 */
import { expectTypeOf } from 'expect-type';
import { a, fromGin, type AnySchema, type GinTypeDef, type JsonValue } from '../../index';
import { Grammar, type ObjTypeDefT } from './harness-grammar';
import { fnNameOf, QualifiedName, type ModelFnNamesLike } from './harness-fns';

// ============================================================================
// Tables as types: create_table / alter_table (shapes.ts:261)
// ============================================================================

/** shapes.ts:261 `TableArgs`: `type` is `GinObjTypeDef` (gin's `typ<obj>`), the session grammar's obj TypeDef. */
export const TableArgs = Grammar.result(a.object({
  table: a.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).describe('The table\'s name (`invoices`).'),
  type: a.ref('ObjTypeDef').describe('The row type: a gin `obj` type whose props are the columns. An `id` column (or `key`) is the primary key; an `optional` column may be empty.'),
  database: a.string().min(1).optional().describe('The database instance; the only one when empty.'),
}).example({
  // shared/index.ts:414 create_table's example
  table: 'notes',
  type: { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } }, text: { type: { name: 'text' } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } },
}));
expectTypeOf<a.infer<typeof TableArgs>['type']>().toMatchTypeOf<ObjTypeDefT>();
expectTypeOf<a.infer<typeof TableArgs>['table']>().toEqualTypeOf<string>();

// ============================================================================
// Enrichment (server/types.ts)
// ============================================================================

/** types.ts:14 */
export const TextFormat = a.enum(['email', 'url', 'uuid', 'phone', 'iso-date', 'country-code', 'currency-code']);
/** types.ts:29 */
export const ColumnEnrichment = a.object({
  description: a.string().min(1).optional().describe('What the column holds.'),
  values: a.array(a.union([a.string(), a.number()])).min(1).max(40).optional()
    .describe('The closed set of values, only when the column clearly holds one: a status, a type, a category.'),
  format: TextFormat.optional().describe('The format of a text column, when every value has it.'),
  min: a.number().optional().describe('The smallest value, only for a clear bound like a percentage or a rating.'),
  max: a.number().optional().describe('The largest value, only for a clear bound like a percentage or a rating.'),
  examples: a.array(a.string()).max(5).optional().describe('Up to 3 typical values, as text.'),
});
/** types.ts:42: what is kept with the table's type (columns by name). */
export const TableEnrichment = a.object({
  description: a.string().min(1).describe('One sentence on what a row is.'),
  columns: a.record(ColumnEnrichment),
});
/** types.ts:57: the enricher's answer (`TableEnrichment.extend({ columns: list })`). */
export const EnrichmentAnswer = TableEnrichment.extend({
  columns: a.array(ColumnEnrichment.extend({ column: a.string().min(1).describe('The column\'s name, exactly as given.') }))
    .describe('Only the columns there is something sure to say about.'),
});
type ColumnEnrichmentT = {
  description?: string; values?: (string | number)[]; format?: 'email' | 'url' | 'uuid' | 'phone' | 'iso-date' | 'country-code' | 'currency-code';
  min?: number; max?: number; examples?: string[];
};
expectTypeOf<a.infer<typeof TableEnrichment>>().toEqualTypeOf<{ description: string; columns: Record<string, ColumnEnrichmentT> }>();
expectTypeOf<a.infer<typeof EnrichmentAnswer>>().toEqualTypeOf<{
  description: string;
  columns: { description?: string; values?: (string | number)[]; format?: ColumnEnrichmentT['format']; min?: number; max?: number; examples?: string[]; column: string }[];
}>();

/** types.ts:64 `enrichmentOf`: the answer as kept, only the table's columns. */
export function enrichmentOf(answer: a.infer<typeof EnrichmentAnswer>, columns: ReadonlySet<string>): a.infer<typeof TableEnrichment> {
  const kept = answer.columns.filter((entry) => columns.has(entry.column)).map(({ column, ...rest }) => [column, rest] as const);
  return { description: answer.description, columns: Object.fromEntries(kept) };
}

// ============================================================================
// ResultData (core/src/registries.ts:170-230)
// ============================================================================

/** registries.ts:18 */
export const COLUMN_KINDS = ['text', 'integer', 'number', 'boolean', 'date', 'datetime', 'time', 'uuid', 'json', 'binary'] as const;
/** registries.ts:170 `ResultColumn`: `type` is a gin TypeDef (`GinTypeDef`), so it is the grammar's. */
const ResultColumn = a.object({
  name: a.string().min(1),
  label: a.string().optional(),
  kind: a.enum(COLUMN_KINDS),
  nullable: a.boolean(),
  type: a.ref('TypeDef').optional().describe('The column\'s gin type (an enum, a format, a range), when the query\'s row type gives one.'),
  ref: QualifiedName.optional().describe('The named type a column refers to (a foreign key\'s table type).'),
  role: a.enum(['group', 'measure', 'attribute']).optional(),
  key: a.boolean().optional(),
  editable: a.boolean().optional(),
});
/** registries.ts:210 `ResultTable` (= database `ResultData`). */
export const ResultData = Grammar.result(a.object({
  columns: a.array(ResultColumn),
  rows: a.array(a.array(a.json())),
  offset: a.int().min(0),
  limit: a.int().min(1).optional(),
  total: a.int().min(0).optional(),
  truncated: a.boolean(),
  sort: a.array(a.object({ column: a.string().min(1), dir: a.enum(['asc', 'desc']) })),
  write: a.object({ affected: a.int().min(0) }).optional(),
  records: a.object({ type: QualifiedName, id: a.string().min(1) }).optional(),
  drill: a.object({ fn: QualifiedName, args: a.record(a.json()), keys: a.array(a.string().min(1)) }).optional(),
}));
type ResultDataT = a.infer<typeof ResultData>;
expectTypeOf<ResultDataT['rows']>().toEqualTypeOf<JsonValue[][]>();
expectTypeOf<ResultDataT['drill']>().toEqualTypeOf<{ fn: QualifiedName; args: Record<string, JsonValue>; keys: string[] } | undefined>();

// ============================================================================
// Saved queries: args computed from the compiled query (server/compile.ts)
// ============================================================================

/** @aeye/query's merged field type of a param (the parts `ginOfField` reads). */
export type FieldTypeDef =
  | { kind: 'number'; min?: number; max?: number; whole?: boolean; values?: { value: number }[] }
  | { kind: 'money'; number?: { min?: number; max?: number; whole?: boolean; values?: { value: number }[] } }
  | { kind: 'text'; minLength?: number; maxLength?: number; pattern?: string; values?: { value: string }[] }
  | { kind: 'bool' | 'date' | 'timestamp' | 'json' | 'relation' }
  | { kind: 'array'; item?: FieldTypeDef };
/** compile.ts's `CompiledQuery`, the parts `argsTypeOf` reads. */
export interface CompiledQueryLike {
  readonly params: readonly { readonly name: string; readonly type?: FieldTypeDef; readonly uses: readonly { readonly field?: { readonly type: string; readonly field: string } }[] }[];
  readonly list: boolean;
  readonly columns: readonly { readonly name: string }[];
  readonly def: { readonly kind: string };
}

/** compile.ts:181 */
function enumOf(values: readonly (string | number)[], scalar: GinTypeDef): GinTypeDef {
  const members: Record<string, string | number> = {};
  for (const value of values) members[String(value)] = value;
  return { name: 'enum', generic: { V: scalar }, options: { values: members } };
}
/** compile.ts:160 `ginOfField`, verbatim. */
export function ginOfField(def: FieldTypeDef | undefined): GinTypeDef {
  switch (def?.kind) {
    case undefined: return { name: 'any' };
    case 'number': case 'money': {
      const options = def.kind === 'number' ? def : (def.number ?? {});
      if (options.values !== undefined) return enumOf(options.values.map((v) => v.value), { name: 'num' });
      const bounds = { ...(options.min === undefined ? {} : { min: options.min }), ...(options.max === undefined ? {} : { max: options.max }), ...(options.whole === true ? { whole: true } : {}) };
      return Object.keys(bounds).length === 0 ? { name: 'num' } : { name: 'num', options: bounds };
    }
    case 'text': {
      if (def.values !== undefined) return enumOf(def.values.map((v) => v.value), { name: 'text' });
      const bounds = { ...(def.minLength === undefined ? {} : { minLength: def.minLength }), ...(def.maxLength === undefined ? {} : { maxLength: def.maxLength }), ...(def.pattern === undefined ? {} : { pattern: def.pattern }) };
      return Object.keys(bounds).length === 0 ? { name: 'text' } : { name: 'text', options: bounds };
    }
    case 'bool': return { name: 'bool' };
    case 'date': return { name: 'date' };
    case 'timestamp': return { name: 'timestamp' };
    case 'array': return { name: 'list', generic: { V: ginOfField(def.item) } };
    case 'json': case 'relation': return { name: 'any' };
  }
}

/** compile.ts:199 `argsTypeOf`, verbatim: the args a saved query's fn takes. */
export function argsTypeOf(compiled: CompiledQueryLike, sorters: readonly string[], limits: { max: number; page: number }, optional: readonly string[] = []): GinTypeDef {
  const props: Record<string, { type: GinTypeDef; docs?: string }> = {};
  for (const param of compiled.params) {
    const given = ginOfField(param.type);
    const type: GinTypeDef = optional.includes(param.name) ? { name: 'optional', generic: { T: given } } : given;
    const column = param.uses.find((use) => use.field !== undefined)?.field;
    props[param.name] = { type, ...(column === undefined ? {} : { docs: `Compared with ${column.type}.${column.field}.` }) };
  }
  if (compiled.list) {
    props['limit'] = { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 1, max: limits.max } } } }, docs: `How many rows (${limits.page} when empty).` };
    props['offset'] = { type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true, min: 0 } } } }, docs: 'How many rows to skip, for the next page.' };
  }
  const sortable = sorters.filter((name) => compiled.columns.some((column) => column.name === name));
  if (sortable.length > 0 && compiled.def.kind === 'select') {
    props['sort'] = {
      type: { name: 'optional', generic: { T: { name: 'list', generic: { V: { name: 'obj', props: { column: { type: enumOf(sortable, { name: 'text' }) }, dir: { type: enumOf(['asc', 'desc'], { name: 'text' }) } } } } } } },
      docs: 'Sort by these columns, in order (the query\'s own order when empty).',
    };
  }
  return { name: 'obj', props };
}

/** A saved query fn as the instance keeps it: its compiled query and how it pages and sorts. */
export interface SavedQuery {
  readonly compiled: CompiledQueryLike;
  readonly sorters: readonly string[];
  readonly optional?: readonly string[];
}
/** What `run_query` reads per instance: the prompt's names, the saved queries by fn, and the paging limits. */
export interface SavedQueries {
  readonly names: ModelFnNamesLike;
  readonly queries: ReadonlyMap<QualifiedName, SavedQuery>;
  readonly limits: { readonly max: number; readonly page: number };
}

const argsCache = new WeakMap<SavedQuery, AnySchema>();
/** A saved query's args schema: `argsTypeOf` → `a`, refusing unknown args (`toValueSchema({ unknownKeys: 'refuse' })`). */
export function savedQueryArgs(query: SavedQuery, limits: SavedQueries['limits']): AnySchema {
  let s = argsCache.get(query);
  if (!s) argsCache.set(query, (s = (fromGin(argsTypeOf(query.compiled, query.sorters, limits, query.optional)) as unknown as { strict(): AnySchema }).strict()));
  return s;
}

/**
 * `run_query` as `a` types it: `args` checked against the named saved query's computed args (compile.ts:226
 * `argProblems` does it by hand today, after a call whose `args` were any JSON).
 */
export const CheckedRunQuery = a
  .declare<{ Run: { fn: QualifiedName; args?: unknown } }>()
  .dynamic((ctx: SavedQueries) => ({
    FnName: fnNameOf(ctx.names),
    Run: a.object({ fn: a.ref('FnName').describe('The saved query fn, by its name as a search hit, get_query or table_fns_generate gave it (`database/main.orders_by_status`).') })
      .dependent('args', 'fn', (fn) => {
        const query = typeof fn === 'string' ? ctx.queries.get(fn as QualifiedName) : undefined;
        return query === undefined ? undefined : savedQueryArgs(query, ctx.limits);
      }),
  }), { key: (ctx) => ctx })
  .result('Run');
expectTypeOf(CheckedRunQuery.bind).parameters.toEqualTypeOf<[ctx: SavedQueries]>();
