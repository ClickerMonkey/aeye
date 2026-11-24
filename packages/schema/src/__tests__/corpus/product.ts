/**
 * product's query kind (E:\GitHub\product, read-only): every schema it sends
 * a model, ported to `a`.
 *
 * Sources (packages/ relative):
 * - core/src/kinds/query.ts:4265-4314 `query_set` — `z.object({ value: buildSchemas(sessionEngine, { strict: true, maxEnumSize }).Query })`,
 *   absent (schema fn returns undefined) outside a query agent, with no system set, an empty engine,
 *   or a progressive session with no usable loaded type;
 * - core/src/kinds/query.ts:4539-4545 `query_test` — `{ input?: { <param>: json }, sort?: enum(sorters), searchTerm?: string }`;
 * - core/src/kinds/query.ts:4083-4176 `system_search` / `system_set` / `dbfn_search` / `dbfn_load`;
 * - core/src/kinds/shared.ts:614-674 `identityReturnSchema` (`query_return`), create vs edit;
 * - core/src/kinds/flow-decl.ts:659-667, 1009-1104 the gin-declared flow args (`search`, `load`, `reuse`, `failures`, `decline`);
 * - core/src/kinds/type.ts:5173-5195 `type_compute` (`expr`: `buildSchemas(bareRegistry, { strict: false }).Expr`)
 *   and type-configure.ts:463 `populate` (the same open Expr);
 * - core/src/kinds/query.ts:3524-3563 `querySignature`: the finished query fn's own argument schema.
 *
 * The STRICTNESS levels product uses are two (`strict: true` + `maxEnumSize`
 * for query_set, `strict: false` for the expr slots); what varies is the
 * CATALOG — prefed (every type of the system) or progressive (only the types
 * the session loaded) — and the library's maxEnumSize degrade. RLS/FLS is
 * applied when the query runs, not in the schema (admin-only fields are in
 * every role's enum). query-signature-repair.ts is a boot job, not
 * model-facing (no schema).
 */
import { expectTypeOf } from 'expect-type';
import type { QueryDef } from '@aeye/query';
import { a, type AnySchema, type JsonValue, type SchemaOf } from '../../index';
import { QueryModule, type ModelExprDef, type QueryCatalog } from './query';

/** What the query agent's tools read from the session (`CoreCtx` + the session artifact). */
export interface QuerySessionCtx {
  readonly inQueryAgent: boolean;
  /** The set system, if any (`system_set`). */
  readonly system?: string;
  /** The session engine's catalog: prefed (every system type) or the loaded types only. */
  readonly catalog: QueryCatalog;
  readonly prefed: boolean;
  /** holder.querySchemaMaxEnumSize (QUERY_SCHEMA_MAX_ENUM_SIZE, default 100). */
  readonly maxEnumSize: number;
  /** Every system the user can set (`systemUniverse(ctx)`). */
  readonly systems: readonly string[];
  /** DB functions the agent has seen in search hits but not loaded. */
  readonly unloadedDbFns: readonly string[];
  /** Overflowed types and which loaded type/field names are usable (progressive disclosure). */
  readonly usableLoaded: boolean;
  /** An embedder is wired (the `semantic` search weight exists). */
  readonly embedder: boolean;
}

/** holder.ts:281 */
export const QUERY_SCHEMA_MAX_ENUM_SIZE_DEFAULT = 100;

// ============================================================================
// query_set
// ============================================================================

/**
 * query.ts:4265 — the paired schema over what is ACTUALLY loaded, so the model
 * cannot name something out of scope; maxEnumSize degrades it past 100.
 */
export const QuerySetArgs = QueryModule
  .result(a.object({ value: a.ref('Query') }))
  .adapt((ctx: QuerySessionCtx) => [ctx.catalog, { strict: true, maxEnumSize: ctx.maxEnumSize }]);

/** The conditions under which `query_set`'s schema fn returns `undefined` (the tool is absent). */
export function querySetApplicable(ctx: QuerySessionCtx): boolean {
  if (!ctx.inQueryAgent || ctx.system === undefined) return false;
  if (ctx.catalog.types.length === 0) return false;
  if (!ctx.prefed && !ctx.usableLoaded) return false;
  return true;
}

// query.ts:3994-4045 QUERY_SET_EXAMPLES (the tool's examples), over product's `order` type.
const orderField = (field: string) => ({ kind: 'field-ref' as const, source: 'order', field });
export const COUNT_ROWS = { kind: 'aggregate' as const, function: 'count', args: {} };
export const QUERY_SET_EXAMPLES: readonly { value: QueryDef }[] = [
  { value: { kind: 'select', fields: [{ expr: orderField('city') }, { expr: orderField('total') }], from: { kind: 'type', type: 'order' }, order: [{ expr: orderField('total'), dir: 'desc' }] } },
  { value: { kind: 'select', fields: [{ expr: orderField('id') }, { expr: orderField('total') }], from: { kind: 'type', type: 'order' }, where: [{ kind: 'comparison', op: '=', left: orderField('city'), right: { kind: 'param', name: 'city' } }] } },
  { value: { kind: 'select', fields: [{ expr: orderField('city'), as: 'city' }, { expr: COUNT_ROWS, as: 'orders' }], from: { kind: 'type', type: 'order' }, groupBy: [orderField('city')] } },
];

// ============================================================================
// query_test
// ============================================================================

/** query.ts:4539 — the staged query's params, its sorters, and whether it rolls up search scores. */
export interface StagedQuery {
  readonly version: number;
  readonly params: readonly string[];
  readonly sorters: readonly string[];
  readonly searchRollup: boolean;
}
/** QUERY_SEARCH_ARG */
export const QUERY_SEARCH_ARG = 'searchTerm';

export const QueryTestArgs = a
  .declare<{ Args: { input?: Record<string, JsonValue>; sort?: string; searchTerm?: string } }>()
  .dynamic((staged: StagedQuery) => {
    // z.object(Object.fromEntries(params.map((name) => [name, jsonValueSchema()]))).optional()
    const input = a.object(Object.fromEntries(staged.params.map((p) => [p, a.json()]))).optional();
    const shape: Record<string, AnySchema> = { input };
    if (staged.sorters.length) shape.sort = a.enum(staged.sorters).optional();
    if (staged.searchRollup) shape[QUERY_SEARCH_ARG] = a.string().optional();
    return { Args: a.object(shape) as unknown as SchemaOf<{ input?: Record<string, JsonValue>; sort?: string; searchTerm?: string }> };
  }, { key: (s) => s.version })
  .result('Args');

// ============================================================================
// The query agent's other tools
// ============================================================================

/** query.ts:4083 / 4144 — search tools (present only once the catalog overflows / when not prefed). */
export const SearchArgs = a.object({ query: a.string() });

/** query.ts:4111 — `z.object({ system: z.enum(await systemUniverse(ctx)) })`. */
export const SystemSetArgs = a.declare<{ Args: { system: string } }>()
  .dynamic((ctx: QuerySessionCtx) => ({ Args: a.object({ system: a.enum(ctx.systems) }) }), { key: (ctx) => ctx.systems.join('\u0000') })
  .result('Args');

/** query.ts:4176 — only names the agent has seen but not loaded; `undefined` (absent) when none. */
export const DbFnLoadArgs = a.declare<{ Args: { names: string[] } }>()
  .dynamic((ctx: QuerySessionCtx) => ({ Args: a.object({ names: a.array(a.enum(ctx.unloadedDbFns)).min(1) }) }))
  .result('Args');
export const dbFnLoadApplicable = (ctx: QuerySessionCtx) => ctx.unloadedDbFns.length > 0;

// sdk/src/fn-kind.ts:820 FnStatusTemplatesSchema
const statusForms = a.object({ one: a.string().min(1), many: a.string().min(1) });
export const FnStatusTemplates = a.object({ active: statusForms, success: statusForms, retry: statusForms, failure: statusForms });

const STATUS_TEMPLATE_GUIDANCE = 'Status templates: `one` for a single run, `many` with {n} for several.';
const UNREDACTED_PARTS_GUIDANCE = 'OMIT THIS unless the fn genuinely needs its real payload visible. By default everything this fn sends and returns is MASKED in transcripts, status lines and API reads.';

/** shared.ts:614 `identityReturnSchema(ctx, kind)`: `query_return`, create vs edit mode. */
export interface IdentityCtx {
  readonly mode: 'create' | 'edit';
  /** `statedNameOf(requirementsOf(ctx), kind)` */
  readonly stated?: string;
}
const instructionsText = a.string().min(1).describe('free text: a summary AND worked examples (args + expected behavior), one per distinct use case');
const identityCommon = {
  statuses: FnStatusTemplates.optional().describe(`Optional — omit to let the finalize helper draft them.\n${STATUS_TEMPLATE_GUIDANCE}`),
  unredactedParts: a.array(a.string().min(1)).optional().describe(UNREDACTED_PARTS_GUIDANCE),
};
export const IdentityReturnArgs = a
  .declare<{ Args: IdentityReturn }>()
  .dynamic((ctx: IdentityCtx) => ({
    Args: ctx.mode === 'create'
      ? a.object({
          name: a.string().min(1).optional().describe(ctx.stated === undefined
            ? 'Optional — omit and the platform names it. Supply one only when a specific name matters.'
            : `Optional — omit to use '${ctx.stated}', the name your requirements stated.`),
          description: a.string().min(1).optional()
            .describe('Optional — omit to use the requirements you were given. Supply one only when it says something they do not.'),
          query: a.string().optional(),
          instructions: instructionsText.optional().describe('Optional — omit to let the finalize helper draft them from what was actually built and, where the platform ran it, from the real result. Supply them only when you know something the artifact and its run do not show.'),
          ...identityCommon,
        })
      : a.object({
          name: a.string().min(1).optional(),
          description: a.string().min(1).optional(),
          query: a.string().optional(),
          instructions: instructionsText.optional(),
          ...identityCommon,
        }),
  }), { key: (ctx) => `${ctx.mode}:${ctx.stated ?? ''}` })
  .result('Args');

export interface IdentityReturn {
  name?: string;
  description?: string;
  query?: string;
  instructions?: string;
  statuses?: { [K in 'active' | 'success' | 'retry' | 'failure']: { one: string; many: string } };
  unredactedParts?: string[];
}

// flow-decl.ts:1009-1104 — gin-declared flow args (`arg(type, docs, example)`, `optionalArg`)
/** `search`: `semantic` (SEMANTIC_ARG) only when an embedder is wired (`requires: 'semantic-search'`). */
export const FlowSearchArgs = a
  .declare<{ Args: { query: string; semantic?: number } }>()
  .dynamic((ctx: { embedder: boolean }) => {
    const query = a.string().describe('What to look for, in plain words.');
    return {
      Args: ctx.embedder
        ? a.object({ query, semantic: a.number().min(0).max(1).optional().describe('Optional hybrid rank weight 0..1: 0 is pure keyword, 1 pure meaning.').example(0.5) })
        : a.object({ query }),
    };
  }, { key: (ctx) => ctx.embedder })
  .result('Args');
export const FlowLoadArgs = a.object({ name: a.string().describe('the exact query fn name from a search hit') });
export const FlowReuseArgs = a.object({ names: a.array(a.string()).describe('the query fn names to reuse, as listed in search hits') });
export const FlowFailuresArgs = a.object({ offset: a.int().min(0).optional().describe('How many failures to skip (paging).') });
export const FlowDeclineArgs = a.object({
  reason: a.string().describe('Why this request cannot be satisfied — specific enough for the caller to act on, not "it did not work".')
    .example('no queryable type carries per-customer revenue'),
  examined: a.array(a.string()).optional()
    .describe('What you inspected before concluding it was impossible (type names, existing fns, the system you were scoped to).')
    .example(['order', 'order_line']),
  needed: a.array(a.string()).optional()
    .describe('What would have to exist for this to become possible, when there is such a thing.')
    .example(['a customer type with a revenue field']),
}).strict(); // sdk/src/fn.ts:932 FlowDeclineSchema is a z.strictObject

// ============================================================================
// type_compute / populate: the OPEN Expr over a bare registry
// ============================================================================

/** type.ts:5173 — `buildSchemas(createRegistry(), { strict: false })`, memoized per process. */
export const TypeComputeArgs = QueryModule.result(a.object({
  type: a.string().describe('the type to give the column to — a name, or "system:name" for a type another system ships'),
  name: a.string().describe('the column name to add (an identifier: it becomes something a query selects and a program reads after the dot)'),
  description: a.string().describe('what the column means, for whoever selects it'),
  expr: a.ref('Expr').describe('the @aeye/query expression, written against the TYPE’S OWN NAME as its source. A correlated subquery or aggregate over a related type is the usual shape.'),
})).adapt((bare: QueryCatalog) => [bare, { strict: false }]);

/** type-configure.ts:463 — the `populate` slot. */
export const PopulateExpr = QueryModule.result('Expr').adapt((bare: QueryCatalog) => [bare, { strict: false }]);

// ============================================================================
// The finished query fn's own arguments (querySignature)
// ============================================================================

/** query.ts:3524 — what `analyzeQuery` + `autoFiltered` derive. */
export interface QueryFnSignature {
  readonly version: string;
  /** Bind params and their field types (`fieldGinType(param.type)`). */
  readonly params: readonly { readonly name: string; readonly type: 'text' | 'num' | 'bool' | 'timestamp' }[];
  /** `limit` / `offset` from auto-pagination: optional. */
  readonly windowArgs: readonly string[];
  /** The filters allowlist: each column an optional argument (queryFilterArgs). */
  readonly filters: readonly { readonly arg: string; readonly type: 'text' | 'num' | 'bool' | 'timestamp' }[];
  readonly sorters: readonly string[];
  readonly searchTerm: boolean;
}
const QUERY_WRITE_OWNER_PARAM = '__writeOwner';
const scalar = (t: QueryFnSignature['params'][number]['type']): AnySchema =>
  t === 'num' ? a.number() : t === 'bool' ? a.boolean() : t === 'timestamp' ? a.string().format('date-time') : a.string();

export const QueryFnArgs = a
  .declare<{ Args: Record<string, string | number | boolean | undefined> }>()
  .dynamic((sig: QueryFnSignature) => {
    const args: Record<string, AnySchema> = {};
    for (const p of sig.params) {
      if (p.name === QUERY_WRITE_OWNER_PARAM) continue;
      args[p.name] = sig.windowArgs.includes(p.name) ? a.optional(scalar(p.type)) : scalar(p.type);
    }
    for (const f of sig.filters) if (!(f.arg in args)) args[f.arg] = a.optional(scalar(f.type));
    if (sig.sorters.length && !('sort' in args)) args.sort = a.enum(sig.sorters).optional();
    if (sig.searchTerm && !(QUERY_SEARCH_ARG in args)) args[QUERY_SEARCH_ARG] = a.string();
    return { Args: a.object(args) as unknown as SchemaOf<Record<string, string | number | boolean | undefined>> };
  }, { key: (s) => s.version })
  .result('Args');

// ============================================================================
// Types
// ============================================================================

expectTypeOf<a.infer<typeof QuerySetArgs>['value']>().toMatchTypeOf<QueryDef>();
expectTypeOf(QuerySetArgs.bind).parameters.toEqualTypeOf<[ctx: QuerySessionCtx]>();
expectTypeOf<a.infer<typeof TypeComputeArgs>>().toMatchTypeOf<{ type: string; name: string; description: string; expr: ModelExprDef }>();
expectTypeOf<a.infer<typeof TypeComputeArgs>['expr']['kind']>().toEqualTypeOf<ModelExprDef['kind']>();
expectTypeOf(TypeComputeArgs.bind).parameters.toEqualTypeOf<[bare: QueryCatalog]>();
expectTypeOf<a.infer<typeof PopulateExpr>>().toMatchTypeOf<ModelExprDef>();
expectTypeOf<a.infer<typeof QueryTestArgs>>().toEqualTypeOf<{ input?: Record<string, JsonValue>; sort?: string; searchTerm?: string }>();
expectTypeOf<a.infer<typeof IdentityReturnArgs>>().toEqualTypeOf<IdentityReturn>();
expectTypeOf<a.infer<typeof FlowDeclineArgs>>().toEqualTypeOf<{ reason: string; examined?: string[]; needed?: string[] }>();
expectTypeOf<a.infer<typeof FlowSearchArgs>>().toMatchTypeOf<{ query: string; semantic?: number }>();
expectTypeOf<a.infer<typeof DbFnLoadArgs>>().toEqualTypeOf<{ names: string[] }>();
expectTypeOf<a.infer<typeof FnStatusTemplates>['retry']>().toEqualTypeOf<{ one: string; many: string }>();
