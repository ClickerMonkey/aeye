import { z } from 'zod';
import { ToolInterrupt } from '@aeye/core';
import { val, type Value, type ObjType, type Registry } from '@aeye/gin';
import { ai } from '../ai';
import { flushDirtyVars } from '../vars-global';

/**
 * Build the Zod sub-schema the model sees for `args`.
 *
 * - When the engineer is authoring a fn (`ctx.targetFn?.argsType` is
 *   set), use that obj type's value-side schema directly. The model
 *   sees `{ n: number, m: string }` instead of an opaque
 *   `Record<string, unknown>` and stops trying to invent wrapper
 *   names like `obj` or `args` to read from scope.
 * - Otherwise (top-level / generic case) programs rarely take
 *   external scope vars; keep a permissive record fallback so the
 *   tool still works for ad-hoc one-off uses.
 */
function buildArgsSchema(argsType: ObjType | undefined): z.ZodTypeAny {
  if (argsType) {
    return argsType.toValueSchema({ includeDocs: 'all' }).describe(
      `Scope variables — keys ARE the function's parameter names. Each key becomes a scope variable the program reads via { kind: 'get', path: [{ prop: '<name>' }] }. Do NOT wrap in another object.`,
    );
  }
  return z
    .record(z.string(), z.unknown())
    .describe(
      'Scope variables — keys become variable names the program reads by name. NOT a single wrapper object; do NOT read `args` or `obj` from scope, read the names you put here.',
    );
}

/**
 * `engine.run`'s extras must be `Record<string, Value>` — the schema
 * lets the model pass plain JSON, so we wrap on the way in.
 *
 * Gin's calling convention exposes a function's parameters as a single
 * `args` scope variable, not as top-level scope entries (matches
 * `Lambda.evaluate` in @aeye/gin/exprs/lambda.ts). Param names live
 * under `args.*` so they can't collide with globals (`fns`, `vars`,
 * loaded fns), `recurse`, or lambda context names (`this`, `super`,
 * `key`, `value`).
 *
 * - With `argsType`, parse the entire args object through that obj
 *   type to get a typed `Value`, then bind it as `args`.
 * - Without it (top-level / generic case) the model rarely passes
 *   args. Wrap as `val(any, raw)` for whatever shape it provided.
 */
function buildScopeExtras(
  registry: Registry,
  argsType: ObjType | undefined,
  rawArgs: Record<string, unknown> | undefined,
): Record<string, Value> {
  if (argsType) {
    try {
      const parsed = argsType.parse(rawArgs ?? {});
      return { args: parsed };
    } catch {
      // Parse failed — fall through to a permissive any-typed args.
    }
  }
  if (!rawArgs) return {};
  return { args: val(registry.any(), rawArgs) };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || 'Error';
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    try {
      const json = JSON.stringify(err);
      // {} is the same uselessness as [object Object] — surface the
      // constructor name as a last-resort hint.
      if (json && json !== '{}') return json;
    } catch { /* circular or unserializable */ }
    const ctor = (err.constructor && err.constructor.name) || 'Object';
    return `<${ctor}>`;
  }
  return String(err);
}

export const test = ai.tool({
  name: 'test',
  description: 'Execute the stored draft program and return the result.',
  instructions:
    'Run the draft. `args` are scope variables the program reads by name — its schema reflects the function being authored when one is in scope, so just pass concrete values for each parameter. Set `expectError: true` if a runtime error is the expected outcome.',
  schema: (ctx) =>
    z.object({
      args: buildArgsSchema(ctx.targetFn?.argsType).optional(),
      expectError: z.boolean().optional().describe('If true, a runtime error counts as success'),
    }) as unknown as z.ZodType<{ args?: Record<string, unknown>; expectError?: boolean }>,
  applicable: (ctx) => !!ctx.runState.draft,
  call: async (
    input: { args?: Record<string, unknown>; expectError?: boolean },
    _refs,
    ctx,
  ) => {
    if (!ctx.runState.draft) {
      throw new ToolInterrupt('No draft written yet. Call write() first.');
    }

    try {
      const scopeExtras = buildScopeExtras(ctx.registry, ctx.targetFn?.argsType, input.args);
      const value = await ctx.engine.run(ctx.runState.draft, scopeExtras);
      const rawResult = value.type?.encode ? value.type.encode(value.raw) : value.raw;

      if (input.expectError) {
        ctx.runState.lastTest = { success: false, value: rawResult, error: 'Expected an error but program succeeded', expectError: true };
        return `FAIL (expected error but succeeded): ${JSON.stringify(rawResult)}`;
      }

      // Program ran cleanly — persist any var mutations the dirty-tracking
      // proxies caught (see `vars-global.ts`).
      const persisted = flushDirtyVars(ctx);
      const persistedNote = persisted.length ? ` (persisted vars: ${persisted.join(', ')})` : '';

      ctx.runState.lastTest = { success: true, value: rawResult };
      return `SUCCESS: ${JSON.stringify(rawResult)}${persistedNote}`;

    } catch (err: unknown) {
      const errMsg = formatError(err);
      if (input.expectError) {
        ctx.runState.lastTest = { success: true, error: errMsg, expectError: true };
        return `SUCCESS (expected error): ${errMsg}`;
      }
      ctx.runState.lastTest = { success: false, error: errMsg };
      return `ERROR: ${errMsg}`;
    }
  },
});
