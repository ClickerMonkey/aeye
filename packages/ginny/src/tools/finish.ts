import { z } from 'zod';
import { ToolInterrupt } from '@aeye/core';
import { ai } from '../ai';
import { registerFnAsGlobal } from '../fns-global';

/**
 * Finalize the draft after a successful test. If `saveAs` is provided
 * the draft is also persisted as a callable function under
 * `fns/<saveAs>.json` and registered in the engine immediately, so
 * subsequent requests in this session can invoke it by name. This is
 * how ginny's "everything is a function" model works — there's no
 * separate `programs/` dir; a finalized program with no parameters is
 * just a `fn() => T`.
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
      .describe('Short description of what the saved function does.'),
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
      // Programs are nullary by default — wrap them as `fn({}, ResultType)`
      // so they can be called as `name({})`. The engineer path is the
      // place to author parameterized fns.
      const argsType = r.obj({});
      const returnType = ctx.engine.typeOf(draft);
      const fnType = r.fn(argsType, returnType);
      try {
        ctx.store.writeFn(name, { type: fnType.toJSON(), body: draft });
        // Register only as a runtime global — FnType.name is always
        // 'function', so calling registry.register(fnType) would clobber
        // the canonical FnType class, not create a named entry.
        registerFnAsGlobal(ctx, name, fnType, draft);
        ctx.loadedFns.add(name);
        savedNote = ` (saved as fn '${name}': ${fnType.toCode()})`;
      } catch (e: unknown) {
        savedNote = ` (failed to save '${name}': ${e instanceof Error ? e.message : String(e)})`;
      }
    }

    return `${JSON.stringify(result)}${savedNote}`;
  },
});
