import { z } from 'zod';
import { ToolInterrupt } from '@aeye/core';
import { LambdaExpr, val, type Value, type ObjType, type Registry } from '@aeye/gin';
import { ai } from '../ai';
import { flushDirtyVars } from '../vars-global';
import { withAskHandler } from '../natives/ask';

/**
 * Build the Zod sub-schema the model sees for `args`.
 *
 * - When the designer is authoring a fn (`ctx.targetFn?.argsType` is
 *   set), use that obj type's value-side schema directly. The model
 *   sees `{ n: number, m: string }` instead of an opaque
 *   `Record<string, unknown>` and stops trying to invent wrapper
 *   names like `obj` to read from scope.
 * - Otherwise (top-level / generic case) programs rarely take
 *   external scope vars; keep a permissive record fallback so the
 *   tool still works for ad-hoc one-off uses.
 */
function buildArgsSchema(argsType: ObjType | undefined): z.ZodTypeAny {
  if (argsType) {
    return argsType.toValueSchema({ includeDocs: 'all' }).describe(
      `Scope values — keys ARE the function's parameter names. The function body reads each via [{prop:'args'}, {prop:'<name>'}]. Pass concrete sample values matching the args type.`,
    );
  }
  return z
    .record(z.string(), z.unknown())
    .describe(
      'Scope variables for the top-level draft. Keys become variable names the program reads by name.',
    );
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
    'Run the draft. `args` are the values bound under the `args` scope variable — its schema reflects the function being authored when one is in scope, so just pass concrete values for each parameter. Set `expectError: true` if a runtime error is the expected outcome.',
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
    const draft = ctx.runState.draft;
    if (!draft) {
      throw new ToolInterrupt('No draft written yet. Call write() first.');
    }

    try {
      const value = await withAskHandler(ctx.ask, ctx.signal, () =>
        ctx.targetFn
          ? invokeAsLambda(ctx.registry, ctx.engine, ctx.targetFn, draft, input.args)
          : invokeTopLevel(ctx.registry, ctx.engine, draft, input.args),
      );
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
      // When authoring a fn (designer-driven flow), the immediate
      // next call MUST be `finish({ saveAs: <name> })` — without
      // saveAs the inner programmer "succeeds" but the designer
      // sees `lastTest.success === true && saved === false` and
      // reports `// FAILED: programmer reached a passing test but
      // didn't call finish({ saveAs: '<name>' })`. The model has
      // been observed forgetting this step; embedding the cue
      // directly in the test-success result is the highest-signal
      // place to remind it.
      const finishCue = ctx.targetFn
        ? `\n\n→ NEXT: call \`finish({ saveAs: '${ctx.targetFn.name}' })\` to persist this function. Without \`saveAs\`, the designer treats this attempt as unsuccessful.`
        : '';
      return `SUCCESS: ${JSON.stringify(rawResult)}${persistedNote}${finishCue}`;

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

/**
 * Designer-driven flow: the draft is a function body.
 *
 * Wrap it in a `LambdaExpr` and invoke through gin's standard call
 * machinery so the body sees `args` and `recurse` in scope and
 * `ReturnSignal` is unwrapped — exactly like the saved fn will behave
 * once `finish` persists it. Without the lambda wrap, recurse and
 * return-flow would silently misbehave during testing.
 */
async function invokeAsLambda(
  registry: Registry,
  engine: { createRootScope: () => any; registry: Registry },
  targetFn: { argsType: ObjType; returnsType: any },
  draft: any,
  rawArgs: Record<string, unknown> | undefined,
): Promise<Value> {
  const fnType = registry.fn({ args: targetFn.argsType, returns: targetFn.returnsType });
  const lambda = new LambdaExpr(fnType, registry.parseExpr(draft));
  // `engine.createRootScope()` seeds globals (fns, vars, loaded fns)
  // so the body can call other saved fns; a hand-built scope wouldn't.
  const lambdaValue = await lambda.evaluate(engine as any, engine.createRootScope());
  const argsValue = targetFn.argsType.parse(rawArgs ?? {});
  const callable = lambdaValue.raw as (a: Value) => Promise<Value>;
  return await callable(argsValue);
}

/**
 * Top-level flow: the draft is just a program (not a fn body).
 *
 * Run it directly via `engine.run` so `ExitSignal` (used by `kind:
 * 'exit'`) is unwrapped (engine.ts:74-84). No need for a lambda wrap —
 * top-level isn't a function and doesn't use `args`/`recurse`. Args
 * passed at this level are bound as a single permissive `args` value
 * for ad-hoc uses.
 */
async function invokeTopLevel(
  registry: Registry,
  engine: { run: (expr: any, extras?: Record<string, Value>) => Promise<Value> },
  draft: any,
  rawArgs: Record<string, unknown> | undefined,
): Promise<Value> {
  const extras: Record<string, Value> = rawArgs
    ? { args: val(registry.any(), rawArgs) }
    : {};
  return await engine.run(draft, extras);
}
