import { z } from 'zod';
import { ToolInterrupt } from '@aeye/core';
import { ai } from '../ai';
import type { FullCtx } from '../context';

export const finish = ai.tool({
  name: 'finish',
  description: 'Finalize the program after a successful test.',
  instructions: 'Call only after test() succeeds. Returns the final result for the user.',
  schema: z.object({}),
  call: async (_input: {}, _refs, ctx: FullCtx) => {
    if (!ctx.runState.lastTest) {
      throw new ToolInterrupt('You must call test() successfully before finish().');
    }
    if (!ctx.runState.lastTest.success) {
      throw new ToolInterrupt(
        `Last test did not pass. Error: ${ctx.runState.lastTest.error ?? 'unknown'}. Fix and test again.`,
      );
    }
    const result = ctx.runState.lastTest.value ?? ctx.runState.lastTest.error;
    return JSON.stringify(result);
  },
});
