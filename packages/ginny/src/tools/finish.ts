import { z } from 'zod';
import { ToolInterrupt } from '@aeye/core';
import type { TypeDef } from '@aeye/gin';
import { ai } from '../ai';

/**
 * Finalize the draft after a successful test. If `saveAs` is provided
 * the draft is persisted as a single TypeDef whose `call.get` is the
 * body — gin's native shape for a callable global (see
 * `gin/src/__tests__/recurse.test.ts:267`). Subsequent requests in
 * this session can invoke it by name; the path walker handles args
 * binding and `recurse` automatically (`gin/src/path.ts:283-290`).
 *
 * This is how ginny's "everything is a function" model works — there's
 * no separate `programs/` dir; a finalized program with no parameters
 * is just a `fn() => T` with `call.get` = the program body.
 */
export const finish = ai.tool({
  name: 'finish',
  description: 'Finalize the draft after a successful test, optionally saving it as a reusable function.',
  instructions:
    'Call only after test() succeeds. Pass `saveAs` to persist the draft as a callable function ' +
    '(`fns/<saveAs>.json`) so the user — and future requests — can invoke it by name. Omit `saveAs` ' +
    'for one-shot answers that don\'t need to be reused.',
  schema: z.object({
    saveAs: z
      .string()
      .optional()
      .describe('Save the finalized draft as `fns/<saveAs>.json`. Use a stable, descriptive camelCase name.'),
    docs: z
      .string()
      .optional()
      .describe('Short description of what the saved function does. Stored on the TypeDef so search_fns surfaces it.'),
  }),
  applicable: (ctx) => !!ctx.runState.lastTest?.success,
  call: async (input: { saveAs?: string; docs?: string }, _refs, ctx) => {
    if (!ctx.runState.lastTest) {
      throw new ToolInterrupt('You must call test() successfully before finish().');
    }
    if (!ctx.runState.lastTest.success) {
      throw new ToolInterrupt(
        `Last test did not pass. Error: ${ctx.runState.lastTest.error ?? 'unknown'}. Fix and test again.`,
      );
    }
    const draft = ctx.runState.draft;
    if (!draft) {
      throw new ToolInterrupt('No draft on file — write() then test() before finish().');
    }

    const result = ctx.runState.lastTest.value ?? ctx.runState.lastTest.error;
    let savedNote = '';

    if (input.saveAs) {
      const name = input.saveAs;
      const r = ctx.registry;

      // When the engineer set up this run via `create_new_fn`, the
      // intended signature lives on `ctx.targetFn`. Use it so the saved
      // type matches what the engineer designed instead of being
      // inferred from the body — `engine.typeOf(draft)` of an if/elif
      // chain lands on weird unions like `or<bool, bool>`, useless to
      // callers expecting `(n: num) => list<num>`.
      const useTarget = ctx.targetFn && ctx.targetFn.name === name;
      const argsType = useTarget ? ctx.targetFn!.argsType : r.obj({});
      const returnsType = useTarget ? ctx.targetFn!.returnsType : ctx.engine.typeOf(draft);

      // Build the TypeDef with the body baked into `call.get`. Gin's
      // path walker invokes this directly — no ginny-side callable
      // wrapping needed.
      const fnTypeDef: TypeDef = {
        name: 'function',
        ...(input.docs ? { docs: input.docs } : {}),
        call: {
          args: argsType.toJSON(),
          returns: returnsType.toJSON(),
          get: draft,
        },
      };

      try {
        ctx.store.writeFn(name, fnTypeDef);
        const fnType = r.parse(fnTypeDef);
        ctx.engine.registerGlobal(name, { type: fnType, value: null });
        ctx.loadedFns.add(name);
        savedNote = ` (saved as fn '${name}': ${fnType.toCode()})`;
      } catch (e: unknown) {
        savedNote = ` (failed to save '${name}': ${e instanceof Error ? e.message : String(e)})`;
      }
    }

    return `${JSON.stringify(result)}${savedNote}`;
  },
});
