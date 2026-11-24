/**
 * CORPUS: the harness's run tools — the static toolset (hub/src/contextor/modes.ts), its `run` tool (core/src/modes.ts:75
 * `RunArgs`), a fleet fn's `on` (modes.ts:118 `fnModeTool`), `database/run_query` (systems/database/shared/index.ts:292)
 * and the authoring agents' `test` tool (sdk/src/program/tools.ts:234).
 *
 * What the harness does today and what `a` does instead:
 * - `run`'s `args` are "any JSON" (`z.record(z.string(), z.json())`); the real check runs AFTER the call
 *   (modes.ts:365 `#run`): the fn name read back through the prompt's names, `names.read(args, decl.args)` for fn-name
 *   fields inside the args, `repairArgs` for objects sent as JSON strings, then the fn's `argsSchema`. Ported as is
 *   (`RunArgs`), and as `a` would type it (`RunCall`): `args` depends on `fn` (`.dependent`), the fn's signature from
 *   the catalog the dynamic step closes over.
 * - a fleet fn's `on` is an enum of the connected instances spliced into the JSON schema by hand; in `a` it is the
 *   dynamic `Machine` ref (keyed by the machines).
 */
import { expectTypeOf } from 'expect-type';
import { a, type AnySchema, type JsonValue } from '../../index';
import { InstanceName, withFnNames, fnNameOf, type ModelFnNamesLike, type QualifiedName } from './harness-fns';

const byPrompt = { key: (names: ModelFnNamesLike) => names };
const fnNames = (names: ModelFnNamesLike) => ({ FnName: fnNameOf(names) });

// ============================================================================
// The static toolset's hub fns (sdk/src/hub.ts)
// ============================================================================

/** core/src/modes.ts:20 */
export const DETAIL_LEVELS = ['listed', 'signature', 'full'] as const;
const DetailType = a.enum(DETAIL_LEVELS);

/** hub.ts:877 `inspect`: `g.obj({ name: g.fnName(), detail: g.optional(DetailType) })`, with its examples. */
export const InspectArgs = withFnNames({})
  .dynamic(fnNames, byPrompt)
  .result(a.object({ name: a.ref('FnName'), detail: DetailType.optional() }).example({ name: 'fs/edit', detail: 'full' }, { name: 'fs/Entry' }));
/** hub.ts:887 `load`: `{ names: g.list(g.fnName(), { minLength: 1 }), detail }`. */
export const LoadArgs = withFnNames({})
  .dynamic(fnNames, byPrompt)
  .result(a.object({ names: a.array(a.ref('FnName')).min(1), detail: DetailType.optional() }));
/** hub.ts:896 `unload`. */
export const UnloadArgs = withFnNames({})
  .dynamic(fnNames, byPrompt)
  .result(a.object({ names: a.array(a.ref('FnName')).min(1) }));

expectTypeOf<a.infer<typeof InspectArgs>>().toEqualTypeOf<{ name: QualifiedName; detail?: 'listed' | 'signature' | 'full' }>();
expectTypeOf<a.infer<typeof LoadArgs>>().toEqualTypeOf<{ names: QualifiedName[]; detail?: 'listed' | 'signature' | 'full' }>();
expectTypeOf<a.infer<typeof UnloadArgs>>().toEqualTypeOf<{ names: QualifiedName[] }>();

// ============================================================================
// `run` (core/src/modes.ts:75), as the harness sends it
// ============================================================================

/** modes.ts:75 `RunArgs`, faithfully: `args` any JSON by key, `{}` when left out. */
export const RunArgs = a.object({
  fn: a.string().min(1).describe('The fn to run, by its qualified name (fs/read).'),
  args: a.record(a.json()).default({}).describe('Its args, as its card shows them.'),
  on: InstanceName.optional().describe('For a system with several machines connected, which one runs it (laptop).'),
});
expectTypeOf<a.infer<typeof RunArgs>>().toEqualTypeOf<{ fn: string; args: Record<string, JsonValue>; on?: InstanceName }>();

/** hub modes.ts:83,84 */
export const RUN_TOOL_DESCRIPTION = 'Run any fn by its name, as its card names it, with the args its card shows, as one JSON object. Its result, or what was wrong with the args, comes back as this call\'s result.';

// ============================================================================
// `run` as `a` types it: args depend on the fn
// ============================================================================

/** What the catalog gives the run tool per prompt: the session's usable fns' signatures, and the machines. */
export interface RunCtx {
  readonly names: ModelFnNamesLike;
  /** A fn's args schema (catalog.ts:252 `signature().argsSchema`), when the session may run it. */
  argsOf(fn: QualifiedName): AnySchema | undefined;
  /** The connected instances of systems with several (modes.ts:111 `machinesOf`). */
  readonly machines: readonly string[];
}

/**
 * The checked `run`: `fn` is a fn-name (read back by the prompt's names), `args` are checked against THAT fn's
 * signature as the model writes them, `on` one of the machines. modes.ts:365 does these steps by hand after the call.
 */
export const RunCall = a
  .declare<{ Run: { fn: QualifiedName; args: unknown; on?: string } }>()
  .dynamic((ctx: RunCtx) => ({
    FnName: fnNameOf(ctx.names),
    Machine: ctx.machines.length > 0 ? a.enum(ctx.machines as [string, ...string[]]) : a.string(),
    Run: a
      .object({ fn: a.ref('FnName').describe('The fn to run, as its card names it.'), on: a.ref('Machine').optional().describe(ON_DESCRIPTION) })
      .dependent('args', 'fn', (fn) => (typeof fn === 'string' ? ctx.argsOf(fn as QualifiedName) : undefined) ?? NO_FN),
  }), { key: (ctx) => ctx })
  .result('Run');
const NO_FN = a.object({}).refine(() => 'no fn of that name can run here');
expectTypeOf<a.infer<typeof RunCall>>().toEqualTypeOf<{ fn: QualifiedName; args: unknown; on?: string }>();
expectTypeOf(RunCall.bind).parameters.toEqualTypeOf<[ctx: RunCtx]>();

// ============================================================================
// A fleet fn's native tool (modes.ts:118 `fnModeTool` + :131 `fleetArgs`)
// ============================================================================

/** modes.ts:108 */
export const ON_DESCRIPTION = 'Which machine runs it: this system has several connected.';

/**
 * A fn's args with an optional `on` naming one of its executing system's machines. `machines` is runtime (the
 * connected instances), so it is the dynamic step, keyed by the list. Example fn: fs/read on a laptop or a desktop.
 */
export const FsReadArgs = a.object({ path: a.string().min(1).describe('The file\'s path.'), lines: a.tuple([a.int().min(1), a.int().min(1)]).optional().describe('From and to line.') });
export const FleetFsRead = a
  .declare<{ Machine: string }>()
  .dynamic((machines: readonly string[]) => ({ Machine: a.enum(machines as [string, ...string[]]) }), { key: (machines) => machines.join(',') })
  .result(FsReadArgs.extend({ on: a.ref('Machine').optional().describe(ON_DESCRIPTION) }));
expectTypeOf<a.infer<typeof FleetFsRead>>().toEqualTypeOf<{ path: string; lines?: [number, number]; on?: string }>();

// ============================================================================
// `database/run_query` (systems/database/shared/index.ts:292) and the `test` tool
// ============================================================================

/** database shared/index.ts:78 */
export const PARAM_VALUES_DOCS = 'An object of the values by param name, such as { "status": "paid" }: a JSON object, never a string holding JSON.';
/** shared/index.ts:303 `args: g.obj({ fn: g.field(g.fnName(), …), args: g.field(g.optional(ginAs(ParamValues)), …) })` + its examples. */
export const RunQueryArgs = withFnNames({})
  .dynamic(fnNames, byPrompt)
  .result(a.object({
    fn: a.ref('FnName').describe('The saved query fn, by its name as a search hit, get_query or table_fns_generate gave it (`database/main.orders_by_status`).'),
    args: a.record(a.json()).optional().describe(PARAM_VALUES_DOCS),
  }).example(
    { fn: 'database/main.orders_by_status', args: { status: 'paid' } },
    { fn: 'database/main.orders_by_status', args: { status: 'open', offset: 50, limit: 50, sort: [{ column: 'customer', dir: 'asc' }] } },
  ));
expectTypeOf<a.infer<typeof RunQueryArgs>>().toEqualTypeOf<{ fn: QualifiedName; args?: Record<string, JsonValue> }>();

/** sdk/src/program/tools.ts:240 `test`. */
export const TestArgs = a.object({ args: a.record(a.json()).describe('A value for each arg, by name.') });
expectTypeOf<a.infer<typeof TestArgs>>().toEqualTypeOf<{ args: Record<string, JsonValue> }>();
