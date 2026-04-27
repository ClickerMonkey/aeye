import { z } from 'zod';
import { ToolInterrupt } from '@aeye/core';
import { ai } from '../ai';
import { flushDirtyVars } from '../vars-global';

export const test = ai.tool({
  name: 'test',
  description: 'Execute the stored draft program and return the result.',
  instructions: 'Run the draft. Set expectError=true if a runtime error is the expected outcome.',
  schema: z.object({
    args: z.record(z.string(), z.unknown()).optional().describe('Extra scope variables'),
    expectError: z.boolean().optional().describe('If true, a runtime error counts as success'),
  }),
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
      const value = await ctx.engine.run(ctx.runState.draft, input.args as any);
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
      const errMsg = err instanceof Error ? err.message : String(err);
      if (input.expectError) {
        ctx.runState.lastTest = { success: true, error: errMsg, expectError: true };
        return `SUCCESS (expected error): ${errMsg}`;
      }
      ctx.runState.lastTest = { success: false, error: errMsg };
      return `ERROR: ${errMsg}`;
    }
  },
});
